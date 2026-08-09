/**
 * Turns that were in flight when the process stopped.
 *
 * A turn lives in memory: a fiber streaming from a provider into the event
 * log. The projection that says a turn is running is durable, the fiber is
 * not, so a restart leaves threads permanently claiming to be busy. Nothing
 * recovers them on its own —
 *
 *   - the session reaper skips any thread with an `activeTurnId`, correctly,
 *     since its whole job is to avoid killing live work;
 *   - pressing Stop dispatches an interrupt, and the reactor checks the
 *     *projection* for a session before forwarding it. The projection still
 *     says one exists, so the interrupt is sent into a session that is not
 *     there and the turn never settles.
 *
 * The result is a thread that shows as working forever and cannot be stopped.
 *
 * The invariant this leans on is narrow and certain: at boot, this process has
 * no provider sessions, so any turn the projection believes is running is
 * finished — badly. What it deliberately does *not* do is tear the session
 * down. Bindings carry `resumeCursor` and `runtimePayload`, and Codex, Claude
 * and OpenCode are built to pick a conversation back up across a restart;
 * marking sessions stopped here would trade a stuck thread for a lost one.
 *
 * @module orchestration/reconcileInterruptedTurns
 */
import {
  CommandId,
  type OrchestrationSession,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

/**
 * What the user is told.
 *
 * Written for the person who left a long task running and came back to it,
 * because that is who this happens to. It says what was lost and what to do,
 * rather than reporting a state transition they did not ask about.
 */
export const INTERRUPTED_BY_RESTART =
  "T3 Code restarted while this turn was running, so it did not finish. Send another message to carry on.";

/** Threads the projection still believes are mid-turn. */
export function hasInterruptedTurn(thread: OrchestrationThreadShell): boolean {
  return (thread.session?.activeTurnId ?? null) !== null;
}

/**
 * The session as it should have been left.
 *
 * `error` rather than `stopped`, because the turn genuinely failed: work was
 * in progress and was lost, and a thread that quietly returns to idle invites
 * the user to assume it finished. A session already `stopped` keeps that —
 * there is nothing to report about a session that was deliberately ended.
 *
 * Everything except the turn is carried through untouched. The provider name,
 * the instance, the runtime mode: none of them stopped being true, and the
 * binding they refer to is still resumable.
 */
export function withTurnCleared(
  session: OrchestrationSession,
  nowIso: string,
): OrchestrationSession {
  return {
    ...session,
    status: session.status === "stopped" ? "stopped" : "error",
    activeTurnId: null,
    lastError: INTERRUPTED_BY_RESTART,
    updatedAt: nowIso,
  };
}

/**
 * Settle every turn orphaned by the last shutdown.
 *
 * Runs before commands are accepted, so a client never observes the stale
 * state and then has to be corrected. Failure is logged and swallowed: a
 * server that will not start because it could not tidy up is a worse outcome
 * than the threads it was tidying.
 */
export const reconcileInterruptedTurns = Effect.gen(function* () {
  const projections = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  const crypto = yield* Crypto.Crypto;

  const shell = yield* projections.getShellSnapshot();
  const interrupted = shell.threads.filter((thread) => hasInterruptedTurn(thread));
  if (interrupted.length === 0) {
    return;
  }

  const nowIso = DateTime.formatIso(yield* DateTime.now);
  let settled = 0;

  for (const thread of interrupted) {
    const session = thread.session;
    if (session === null) {
      continue;
    }
    // One at a time, and a failure on one does not abandon the rest: these are
    // independent threads and a thread left stuck is exactly the bug this
    // exists to fix.
    yield* engine
      .dispatch({
        type: "thread.session.set",
        commandId: CommandId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie)),
        threadId: thread.id,
        session: withTurnCleared(session, nowIso),
        createdAt: nowIso,
      })
      .pipe(
        Effect.tap(() => Effect.sync(() => (settled += 1))),
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration.startup.interrupted-turn.settle-failed", {
            threadId: thread.id,
            cause,
          }),
        ),
      );
  }

  yield* Effect.logInfo("orchestration.startup.interrupted-turns-settled", {
    settled,
    found: interrupted.length,
  });
});
