import { ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type {
  OrchestrationClient,
  ProviderSummary,
  ProjectSummary,
  ThreadSummary,
} from "../conductor/OrchestrationClient.ts";
import { buildEnvironmentSnapshot } from "./environmentSnapshot.ts";

const provider = (overrides: Partial<ProviderSummary>): ProviderSummary => ({
  instanceId: ProviderInstanceId.make("instance-1"),
  driverKind: "codex",
  displayName: "Codex",
  available: true,
  defaultModel: null,
  billing: "unknown",
  ...overrides,
});

const project: ProjectSummary = {
  id: ProjectId.make("project-1"),
  title: "Better T3",
  workspaceRoot: "/repo",
};

const thread = (overrides: Partial<ThreadSummary>): ThreadSummary => ({
  threadId: ThreadId.make("thread-1"),
  title: "A thread",
  providerInstanceId: ProviderInstanceId.make("instance-1"),
  status: "ready",
  updatedAt: "2026-08-10T00:00:00.000Z",
  lifecycle: "active",
  isRunning: false,
  awaitingInput: false,
  awaitingApproval: false,
  ...overrides,
});

const client = (overrides: Partial<OrchestrationClient>): OrchestrationClient => ({
  dispatch: () => Effect.succeed({ accepted: false }),
  listProviders: Effect.succeed([]),
  listModels: () => Effect.succeed([]),
  listProjects: Effect.succeed([]),
  listThreads: () => Effect.succeed([]),
  getThread: () => Effect.succeed(undefined),
  readThread: () => Effect.succeed(""),
  pendingInput: () => Effect.succeed([]),
  ...overrides,
});

describe("the environment snapshot", () => {
  it.effect("says what each agent costs, and which one is the reader", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildEnvironmentSnapshot({
        selfDriverKind: "t3agent",
        client: client({
          listProviders: Effect.succeed([
            provider({ displayName: "Codex", billing: "subscription" }),
            provider({
              displayName: "T3 Orchestrator",
              driverKind: "t3agent",
              billing: "per-token",
              defaultModel: "deepseek/deepseek-v4-flash",
            }),
            provider({ displayName: "Claude Code", available: false }),
          ]),
        }),
      });

      assert.isNotNull(snapshot);
      assert.include(snapshot ?? "", "Codex (subscription — capacity already paid for)");
      assert.include(snapshot ?? "", "per-token — each delegation bills the user");
      assert.include(snapshot ?? "", "this is you");
      assert.include(snapshot ?? "", "currently unavailable");
    }),
  );

  it.effect("names the blocked threads and skips the tidied-away ones", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildEnvironmentSnapshot({
        selfDriverKind: "t3agent",
        client: client({
          listProviders: Effect.succeed([provider({})]),
          listProjects: Effect.succeed([project]),
          listThreads: () =>
            Effect.succeed([
              thread({ title: "Running fine", isRunning: true }),
              thread({ title: "Stuck on a question", awaitingInput: true }),
              thread({ title: "Needs a yes", awaitingApproval: true }),
              // Settled work is not part of "what needs attention".
              thread({ title: "Old news", lifecycle: "settled", awaitingInput: true }),
            ]),
        }),
      });

      assert.include(snapshot ?? "", "3 active — 1 running, 2 blocked");
      assert.include(snapshot ?? "", '"Stuck on a question" is waiting for an answer');
      assert.include(snapshot ?? "", '"Needs a yes" is waiting on an approval');
      assert.notInclude(snapshot ?? "", "Old news");
    }),
  );

  it.live("shrugs rather than stalling session start when a projection hangs", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildEnvironmentSnapshot({
        selfDriverKind: "t3agent",
        timeoutMillis: 50,
        client: client({ listProviders: Effect.never }),
      });

      assert.isNull(snapshot);
    }),
  );
});
