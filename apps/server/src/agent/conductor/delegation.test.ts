/**
 * Delegating work somewhere it cannot collide.
 *
 * A fan-out is the point of orchestration, and delegated threads share a
 * project — so without a checkout of its own, every parallel delegation is two
 * agents editing the same files with no conflict, no error, and nothing in
 * either transcript to say whose work survived.
 */
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { HttpClient } from "effect/unstable/http";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import type * as AiError from "effect/unstable/ai/AiError";

import { unavailableOrchestrationClient } from "./ConductorClient.ts";
import { conductorContributor, delegationBranchName } from "./conductorTools.ts";
import type { OrchestrationClient } from "./OrchestrationClient.ts";
import type { ToolFailure } from "../tools/failure.ts";
import type { AgentToolContext } from "../tools/registry.ts";

type Dispatched = { readonly type: string } & Record<string, unknown>;

interface DelegateResult {
  readonly threadId: string;
  readonly worktreePath?: string;
  readonly branch?: string;
}

/**
 * Runs `delegate_to_agent` against a client that records what it was asked to
 * do. `worktree` decides whether the checkout can be made.
 */
const runDelegate = (
  input: {
    readonly worktree: "created" | "failed";
    readonly params?: Record<string, unknown>;
    /** Null stands for a provider the user never configured a default on. */
    readonly defaultModel?: string | null;
  } = { worktree: "created" },
) =>
  Effect.gen(function* () {
    const dispatched: Array<Dispatched> = [];
    const worktreeCalls: Array<{ cwd: string; branch: string }> = [];

    const client: OrchestrationClient = {
      ...unavailableOrchestrationClient,
      dispatch: (command) =>
        Effect.sync(() => {
          dispatched.push(command as unknown as Dispatched);
          return { accepted: true } as const;
        }),
      listProviders: Effect.succeed([
        {
          instanceId: ProviderInstanceId.make("codex"),
          driverKind: "codex",
          displayName: "Codex",
          available: true,
          defaultModel: input.defaultModel === undefined ? "gpt-5.6-luna" : input.defaultModel,
          billing: "subscription" as const,
        },
      ]),
      listProjects: Effect.succeed([
        {
          id: ProjectId.make("project-1"),
          title: "A project",
          workspaceRoot: "/repo",
        },
      ]),
      createWorktree: (request) =>
        Effect.sync(() => {
          worktreeCalls.push(request);
          return input.worktree === "created"
            ? ({
                _tag: "Created",
                path: "/worktrees/repo/t3-agent-thing",
                refName: "t3-agent/thing",
              } as const)
            : ({ _tag: "Failed", detail: "not a git repository" } as const);
        }),
    };

    const toolContext: AgentToolContext = {
      workspaceRoot: "/",
      fileSystem: yield* FileSystem.FileSystem,
      spawner: yield* ChildProcessSpawner.ChildProcessSpawner,
      httpClient: HttpClient.make(() => Effect.die(new Error("no HTTP in this test"))),
      commandEnv: {},
      requestApproval: () => Effect.succeed({ _tag: "Allowed" as const }),
    };

    const tools = yield* conductorContributor({
      client,
      policy: { allowSelfTargeting: true, allowApprovingRequests: true },
      selfDriverKind: "t3agent",
      nextId: Effect.succeed("11111111-2222-3333-4444-555555555555"),
      nowIso: Effect.succeed("2026-01-01T00:00:00.000Z"),
    }).tools(toolContext);

    const delegate = tools.find((entry) => entry.tool.name === "delegate_to_agent");
    assert.isDefined(delegate, "delegate_to_agent should be offered");
    const handler = delegate.handler as unknown as (
      params: Record<string, unknown>,
      context: Record<string, unknown>,
    ) => Effect.Effect<DelegateResult, ToolFailure | AiError.AiError>;

    const outcome = yield* Effect.result(
      handler(
        {
          providerInstanceId: "codex",
          projectId: "project-1",
          title: "Fix the thing",
          task: "Do the work.",
          ...input.params,
        },
        {},
      ),
    );
    return { outcome, dispatched, worktreeCalls };
  }).pipe(Effect.provide(NodeServices.layer));

const createCommand = (dispatched: ReadonlyArray<Dispatched>) =>
  dispatched.find((command) => command.type === "thread.create");

describe("delegating into a worktree", () => {
  it.effect("gives the new thread a checkout of its own by default", () =>
    Effect.gen(function* () {
      const { outcome, dispatched, worktreeCalls } = yield* runDelegate();
      assert.strictEqual(outcome._tag, "Success");

      assert.strictEqual(worktreeCalls.length, 1);
      assert.strictEqual(worktreeCalls[0]?.cwd, "/repo");

      // The thread has to be created already pointing at the checkout —
      // pointing it there afterwards leaves a window where the agent could
      // start work in the shared directory.
      const created = createCommand(dispatched);
      assert.strictEqual(created?.worktreePath, "/worktrees/repo/t3-agent-thing");
      assert.strictEqual(created?.branch, "t3-agent/thing");
    }),
  );

  it.effect("tells the caller where the work will land", () =>
    Effect.gen(function* () {
      // Isolation nobody is told about reads to the user as work that vanished.
      const { outcome } = yield* runDelegate();
      assert.strictEqual(outcome._tag, "Success");
      if (outcome._tag !== "Success") {
        return;
      }
      assert.strictEqual(outcome.success.branch, "t3-agent/thing");
      assert.strictEqual(outcome.success.worktreePath, "/worktrees/repo/t3-agent-thing");
    }),
  );

  it.effect("refuses rather than quietly falling back to the shared directory", () =>
    Effect.gen(function* () {
      // The dangerous alternative: the caller asked for work that is safe to
      // run alongside other work, and silently gets the shared directory.
      const { outcome, dispatched } = yield* runDelegate({ worktree: "failed" });
      assert.strictEqual(outcome._tag, "Failure");

      // And nothing was started: a thread pointing at the shared directory is
      // exactly what this was refusing to make.
      assert.isUndefined(createCommand(dispatched));
    }),
  );

  it.effect("shares the workspace only when asked, and makes no worktree then", () =>
    Effect.gen(function* () {
      const { outcome, dispatched, worktreeCalls } = yield* runDelegate({
        worktree: "created",
        params: { shareWorkspace: true },
      });
      assert.strictEqual(outcome._tag, "Success");
      assert.strictEqual(worktreeCalls.length, 0);

      const created = createCommand(dispatched);
      assert.strictEqual(created?.worktreePath, null);
      assert.strictEqual(created?.branch, null);
    }),
  );
});

describe("delegationBranchName", () => {
  it("keeps to an alphabet git will accept", () => {
    const branch = delegationBranchName("Fix the OAuth bug (urgent!) — 2026", "abcdef1234567890");
    assert.match(branch, /^t3-agent\/[a-z0-9-]+-abcdef12$/);
  });

  it("separates two delegations that were given the same title", () => {
    // Both would otherwise branch at the same name, and the second worktree
    // simply fails to create.
    assert.notStrictEqual(
      delegationBranchName("fix the tests", "1111111111"),
      delegationBranchName("fix the tests", "2222222222"),
    );
  });

  it("still produces a usable branch from a title with nothing to slug", () => {
    assert.strictEqual(delegationBranchName("!!!", "abcdef1234"), "t3-agent/task-abcdef12");
  });
});

describe("delegating to a provider with no default model", () => {
  it.effect("says which tool supplies the answer, not just that one is missing", () =>
    Effect.gen(function* () {
      // The agent reaches this failure whenever the user has not pinned a model
      // on the target provider, which is the common case for the subscription
      // CLIs. A message naming only the fault costs a round trip while the
      // agent works out that `list_models` exists; naming the recovery makes it
      // one step, and on a live demo it is the difference between a recovery
      // and a stall.
      const { outcome, dispatched } = yield* runDelegate({
        worktree: "created",
        defaultModel: null,
      });

      assert.strictEqual(outcome._tag, "Failure");
      if (outcome._tag !== "Failure") {
        return;
      }
      const message = String((outcome.failure as { message?: unknown }).message ?? outcome.failure);
      assert.include(message, "list_models");
      assert.include(message, "Codex");
      // Nothing was started, so there is no half-made thread to clean up.
      assert.strictEqual(dispatched.length, 0);
    }),
  );

  it.effect("goes ahead when the caller names a model itself", () =>
    Effect.gen(function* () {
      const { outcome } = yield* runDelegate({
        worktree: "created",
        defaultModel: null,
        params: { model: "gpt-5.6-luna" },
      });

      assert.strictEqual(outcome._tag, "Success");
    }),
  );
});
