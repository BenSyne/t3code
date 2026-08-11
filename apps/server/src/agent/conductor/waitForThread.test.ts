/**
 * Waiting on a delegated thread.
 *
 * The tool exists to stop the agent spending a model turn per look, so what
 * matters here is when it returns and what it calls the reason — a wait that
 * treats a blocked thread as "still working" deadlocks a fleet, and one that
 * calls a timeout "finished" makes the agent report work that is still running.
 */
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { ThreadId, ProviderInstanceId } from "@t3tools/contracts";

import type * as AiError from "effect/unstable/ai/AiError";

import { unavailableOrchestrationClient } from "./ConductorClient.ts";
import type { ToolFailure } from "../tools/failure.ts";
import { conductorContributor } from "./conductorTools.ts";
import type { OrchestrationClient, ThreadSummary } from "./OrchestrationClient.ts";
import type { AgentToolContext } from "../tools/registry.ts";

const THREAD = ThreadId.make("thread-under-watch");

const summary = (over: Partial<ThreadSummary>): ThreadSummary => ({
  threadId: THREAD,
  title: "Some delegated work",
  providerInstanceId: ProviderInstanceId.make("codex"),
  status: "running",
  updatedAt: "2026-01-01T00:00:00.000Z",
  lifecycle: "active",
  isRunning: true,
  awaitingInput: false,
  awaitingApproval: false,
  ...over,
});

/**
 * Runs the tool against a client that answers from `script`, one entry per
 * look, the last repeating. Returns the result and how many looks it took.
 */
const runWait = (
  script: ReadonlyArray<ThreadSummary | undefined>,
  params: Record<string, unknown> = {},
) =>
  Effect.gen(function* () {
    let looks = 0;
    const client: OrchestrationClient = {
      ...unavailableOrchestrationClient,
      getThread: () =>
        Effect.sync(() => {
          const found = script[Math.min(looks, script.length - 1)];
          looks += 1;
          return found;
        }),
    };

    const toolContext: AgentToolContext = {
      workspaceRoot: "/",
      fileSystem: yield* FileSystem.FileSystem,
      spawner: yield* ChildProcessSpawner.ChildProcessSpawner,
      commandEnv: {},
      requestApproval: () => Effect.succeed({ _tag: "Allowed" as const }),
    };

    const tools = yield* conductorContributor({
      client,
      policy: { allowSelfTargeting: true, allowApprovingRequests: true },
      selfDriverKind: "t3agent",
      nextId: Effect.succeed("id"),
      nowIso: Effect.succeed("2026-01-01T00:00:00.000Z"),
    }).tools(toolContext);

    const wait = tools.find((entry) => entry.tool.name === "wait_for_thread");
    assert.isDefined(wait, "wait_for_thread should be offered");
    // The registry erases each handler's parameter schema, so the shape comes
    // back here. The failure channel is not erased and is named exactly.
    const handler = wait.handler as unknown as (
      params: Record<string, unknown>,
      context: Record<string, unknown>,
    ) => Effect.Effect<{ readonly outcome: string }, ToolFailure | AiError.AiError>;

    const result = yield* handler({ threadId: String(THREAD), ...params }, {});
    return { result, looks };
  }).pipe(Effect.provide(NodeServices.layer));

describe("wait_for_thread", () => {
  it.effect("returns as soon as the thread has stopped", () =>
    Effect.gen(function* () {
      const { result, looks } = yield* runWait([summary({ isRunning: false, status: "idle" })]);
      assert.strictEqual(result.outcome, "finished");
      // One look, no sleeping: a thread that is already done must not cost the
      // caller a second of latency.
      assert.strictEqual(looks, 1);
    }),
  );

  it.effect("calls a thread waiting on a person blocked, not finished", () =>
    Effect.gen(function* () {
      // The distinction the fleet turns on: this thread is idle *and*
      // unfinished, and will not move until somebody answers it.
      const { result } = yield* runWait([summary({ isRunning: true, awaitingInput: true })]);
      assert.strictEqual(result.outcome, "blocked");
    }),
  );

  it.effect("treats a pending approval as blocked too", () =>
    Effect.gen(function* () {
      const { result } = yield* runWait([summary({ awaitingApproval: true })]);
      assert.strictEqual(result.outcome, "blocked");
    }),
  );

  it.live("keeps looking while the thread is still running, then reports it finished", () =>
    Effect.gen(function* () {
      const { result, looks } = yield* runWait([
        summary({}),
        summary({}),
        summary({ isRunning: false, status: "idle" }),
      ]);
      assert.strictEqual(result.outcome, "finished");
      assert.strictEqual(looks, 3);
    }),
  );

  it.live("gives up with a timeout rather than claiming the work is done", () =>
    Effect.gen(function* () {
      // A thread that never stops. Reporting "finished" here would have the
      // agent summarise work that is still being done.
      const { result } = yield* runWait([summary({})], { timeoutSeconds: 1 });
      assert.strictEqual(result.outcome, "timeout");
    }),
  );

  it.effect("fails on a thread that does not exist", () =>
    Effect.gen(function* () {
      const outcome = yield* Effect.result(runWait([undefined]));
      assert.strictEqual(outcome._tag, "Failure");
    }),
  );
});
