import {
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationSession,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "@effect/vitest";

import {
  hasInterruptedTurn,
  INTERRUPTED_BY_RESTART,
  reconcileInterruptedTurns,
  withTurnCleared,
} from "./reconcileInterruptedTurns.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

const NOW = "2026-08-09T15:00:00.000Z";

const session = (overrides: Partial<OrchestrationSession> = {}): OrchestrationSession => ({
  threadId: ThreadId.make("thread-1"),
  status: "running",
  providerName: "codex",
  runtimeMode: "auto",
  activeTurnId: TurnId.make("turn-1"),
  lastError: null,
  updatedAt: "2026-08-09T14:00:00.000Z",
  ...overrides,
});

const thread = (value: OrchestrationSession | null) =>
  ({ session: value }) as Parameters<typeof hasInterruptedTurn>[0];

describe("spotting a turn the last shutdown caught mid-flight", () => {
  it("finds a thread the projection still believes is running", () => {
    expect(hasInterruptedTurn(thread(session()))).toBe(true);
  });

  it("leaves a thread with no turn in flight alone", () => {
    expect(hasInterruptedTurn(thread(session({ activeTurnId: null })))).toBe(false);
    expect(hasInterruptedTurn(thread(null))).toBe(false);
  });
});

describe("settling it", () => {
  it("clears the turn, which is the whole bug", () => {
    // While activeTurnId is set the reaper skips the thread and the interrupt
    // reactor forwards Stop into a session that is not there. Nothing else in
    // the system ever clears it.
    expect(withTurnCleared(session(), NOW).activeTurnId).toBeNull();
  });

  it("reports it as an error rather than quietly idle", () => {
    // Work was in progress and was lost. A thread that slides back to idle
    // invites the user to assume it finished.
    const settled = withTurnCleared(session(), NOW);
    expect(settled.status).toBe("error");
    expect(settled.lastError).toBe(INTERRUPTED_BY_RESTART);
  });

  it("tells the user what to do, not what state changed", () => {
    expect(INTERRUPTED_BY_RESTART).toMatch(/restarted/);
    expect(INTERRUPTED_BY_RESTART).toMatch(/Send another message/);
  });

  it("does not resurrect a session that was deliberately stopped", () => {
    expect(withTurnCleared(session({ status: "stopped" }), NOW).status).toBe("stopped");
  });

  it("keeps everything that identifies the session, so it stays resumable", () => {
    // The binding behind this carries resumeCursor/runtimePayload and the
    // CLI-backed providers are built to pick a conversation back up. Tearing
    // it down here would trade a stuck thread for a lost one.
    const before = session();
    const after = withTurnCleared(before, NOW);
    expect(after.providerName).toBe(before.providerName);
    expect(after.runtimeMode).toBe(before.runtimeMode);
    expect(after.threadId).toBe(before.threadId);
  });

  it("stamps the time it was settled", () => {
    expect(withTurnCleared(session(), NOW).updatedAt).toBe(NOW);
  });
});

describe("the pass that runs at boot", () => {
  const shell = (threads: ReadonlyArray<unknown>) =>
    ({
      snapshotSequence: 1,
      projects: [],
      threads,
      updatedAt: NOW,
    }) as never;

  const runWith = (threads: ReadonlyArray<unknown>, dispatch?: () => Effect.Effect<never, never>) =>
    Effect.gen(function* () {
      const seen: Array<OrchestrationCommand> = [];
      yield* reconcileInterruptedTurns.pipe(
        Effect.provideService(ProjectionSnapshotQuery, {
          getShellSnapshot: () => Effect.succeed(shell(threads)),
        } as never),
        Effect.provideService(OrchestrationEngineService, {
          dispatch: (command: OrchestrationCommand) =>
            dispatch === undefined
              ? Effect.sync(() => {
                  seen.push(command);
                  return { sequence: seen.length };
                })
              : dispatch(),
        } as never),
        Effect.provideService(Crypto.Crypto, {
          randomUUIDv4: Effect.succeed("11111111-1111-4111-8111-111111111111"),
        } as never),
      );
      return seen;
    });

  const stuck = (id: string) => ({
    id: ThreadId.make(id),
    session: session({ threadId: ThreadId.make(id) }),
  });

  it.effect("settles every thread the last shutdown left mid-turn", () =>
    Effect.gen(function* () {
      const seen = yield* runWith([stuck("thread-1"), stuck("thread-2")]);
      expect(seen).toHaveLength(2);
      expect(seen[0]).toMatchObject({
        type: "thread.session.set",
        threadId: "thread-1",
        session: { activeTurnId: null, status: "error" },
      });
    }),
  );

  it.effect("dispatches nothing when no turn was in flight", () =>
    Effect.gen(function* () {
      const seen = yield* runWith([
        { id: ThreadId.make("thread-1"), session: session({ activeTurnId: null }) },
      ]);
      expect(seen).toEqual([]);
    }),
  );

  it.effect("keeps going when one thread cannot be settled", () =>
    Effect.gen(function* () {
      // These are independent threads, and a thread left stuck is the exact
      // bug this exists to fix — abandoning the rest on the first failure
      // would reintroduce it for everything after the bad one.
      let attempts = 0;
      yield* runWith([stuck("thread-1"), stuck("thread-2"), stuck("thread-3")], () =>
        Effect.sync(() => {
          attempts += 1;
        }).pipe(Effect.andThen(Effect.fail("nope" as never))),
      );
      expect(attempts).toBe(3);
    }),
  );
});
