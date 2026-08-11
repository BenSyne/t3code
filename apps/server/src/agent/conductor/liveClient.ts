/**
 * The Conductor's `OrchestrationClient`, wired to the real server.
 *
 * @module agent/conductor/liveClient
 */
import type {
  DispatchableClientOrchestrationCommand,
  OrchestrationThreadShell,
  ServerProviderAuth,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderSnapshotStore } from "../../provider/Services/ProviderSnapshotStore.ts";
import { reasoningEffortsFor } from "../model/reasoning.ts";
import type {
  ModelSummary,
  OrchestrationClient,
  ProviderSummary,
  ThreadSummary,
} from "./OrchestrationClient.ts";
import { pendingUserInputOf } from "./pendingRequests.ts";
import { lifecycleOf } from "./threadLifecycle.ts";
import { renderTranscript } from "./transcript.ts";

/** A rejected command, in words. */
const describe = (cause: Cause.Cause<unknown>): string => {
  const pretty = Cause.pretty(cause).split("\n    at ")[0]?.trim() ?? "";
  return pretty === "" ? "the command was rejected" : pretty;
};

/** Whether an instance bills per token or draws on something already paid for. */
function billingOf(auth: ServerProviderAuth): ProviderSummary["billing"] {
  if (auth.status !== "authenticated") {
    return "unknown";
  }
  if (auth.type === "api-key") {
    return "per-token";
  }
  return auth.type === undefined ? "unknown" : "subscription";
}

/** Build the client from services already in the server graph. */
export const makeLiveOrchestrationClient = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const projections = yield* ProjectionSnapshotQuery;
  const providerSnapshots = yield* ProviderSnapshotStore;
  // The driver, not `GitWorkflowService`. That wrapper adds a git-availability
  // precheck and pulls in `GitManager`, which needs text generation, which
  // needs the provider registry — the very thing being built one layer out.
  // Depending on it here is a cycle; the driver does the work anyway.
  const git = yield* GitVcsDriver.GitVcsDriver;

  const dispatch: OrchestrationClient["dispatch"] = (
    command: DispatchableClientOrchestrationCommand,
  ) =>
    engine.dispatch(command).pipe(
      Effect.map(() => ({ accepted: true }) as const),
      // A refusal is the answer, not a failure: the model can read "that
      // provider is not authenticated" and pick a different one.
      Effect.catchCause((cause) => Effect.succeed({ accepted: false, detail: describe(cause) })),
    );

  const listProviders: OrchestrationClient["listProviders"] = Effect.map(
    providerSnapshots.get,
    (providers): ReadonlyArray<ProviderSummary> =>
      providers.map((provider) => ({
        instanceId: provider.instanceId,
        driverKind: provider.driver,
        displayName: provider.displayName?.trim() || provider.driver,
        // What the tools mean by available is "a turn sent here would run",
        // which is narrower than the snapshot's several near-ready states.
        available: provider.enabled && provider.installed && provider.status === "ready",
        defaultModel: provider.models.find((model) => model.isDefault)?.slug ?? null,
        billing: billingOf(provider.auth),
      })),
  );

  const listModels: OrchestrationClient["listModels"] = (instanceId) =>
    Effect.map(providerSnapshots.get, (providers): ReadonlyArray<ModelSummary> => {
      const instance = providers.find((provider) => String(provider.instanceId) === instanceId);
      return (instance?.models ?? []).map((model) => ({
        slug: model.slug,
        name: model.name,
        isDefault: model.isDefault === true,
        isLegacy: model.isLegacy === true,
        // The same field the picker labels aggregated models by, so the agent
        // and the user are looking at the same "who actually made this".
        vendor: model.subProvider ?? null,
        reasoningEfforts: reasoningEffortsFor(model.capabilities),
      }));
    });

  /** The navigation-level model. */
  const shell = projections
    .getShellSnapshot()
    .pipe(Effect.catchCause(() => Effect.succeed(undefined)));

  const listProjects: OrchestrationClient["listProjects"] = Effect.map(shell, (model) =>
    (model?.projects ?? []).map((project) => ({
      id: project.id,
      title: project.title,
      workspaceRoot: project.workspaceRoot,
    })),
  );

  const summarize = (thread: OrchestrationThreadShell, nowIso: string): ThreadSummary => ({
    threadId: thread.id,
    title: thread.title,
    // A thread with no session has not run yet; its configured instance is
    // still the honest answer to "who would this go to".
    providerInstanceId: thread.modelSelection.instanceId,
    status: thread.session?.status ?? "idle",
    updatedAt: thread.updatedAt,
    lifecycle: lifecycleOf(thread, nowIso),
    isRunning: (thread.session?.activeTurnId ?? null) !== null,
    awaitingInput: thread.hasPendingUserInput,
    awaitingApproval: thread.hasPendingApprovals,
  });

  const listThreads: OrchestrationClient["listThreads"] = (projectId) =>
    Effect.gen(function* () {
      const model = yield* shell;
      // One clock reading for the whole list, so two threads with the same
      // wake time cannot be classified differently by a millisecond.
      const nowIso = yield* Effect.map(DateTime.now, DateTime.formatIso);
      return (model?.threads ?? [])
        .filter((thread) => thread.projectId === projectId)
        .map((thread) => summarize(thread, nowIso));
    });

  const getThread: OrchestrationClient["getThread"] = (threadId) =>
    Effect.gen(function* () {
      const model = yield* shell;
      const found = (model?.threads ?? []).find((thread) => thread.id === threadId);
      if (found === undefined) {
        return undefined;
      }
      return summarize(found, yield* Effect.map(DateTime.now, DateTime.formatIso));
    });

  /** The thread as text. */
  const readThread: OrchestrationClient["readThread"] = (threadId: ThreadId) =>
    projections.getThreadDetailById(threadId).pipe(
      Effect.map((found) => {
        if (Option.isNone(found)) {
          return `No thread ${threadId} was found. It may have been deleted.`;
        }
        const thread = found.value;
        return renderTranscript({
          title: thread.title,
          status: thread.session?.status ?? "idle",
          messages: thread.messages,
          activities: thread.activities,
          pending: pendingUserInputOf(thread.activities),
        });
      }),
      Effect.catchCause((cause) =>
        Effect.succeed(`Could not read thread ${threadId}: ${describe(cause)}`),
      ),
    );

  const pendingInput: OrchestrationClient["pendingInput"] = (threadId) =>
    projections.getThreadDetailById(threadId).pipe(
      Effect.map((found) =>
        Option.isNone(found) ? [] : pendingUserInputOf(found.value.activities),
      ),
      // A thread whose questions cannot be read is reported as unblocked
      // rather than failing the turn. The transcript still carries the block.
      Effect.catchCause(() => Effect.succeed([])),
    );

  // `HEAD` as the base, so a delegation branches from whatever the user is on
  // rather than an assumed default branch that may not exist.
  const createWorktree: OrchestrationClient["createWorktree"] = (input) =>
    git
      .createWorktree({ cwd: input.cwd, refName: "HEAD", newRefName: input.branch, path: null })
      .pipe(
        Effect.map(
          (result) =>
            ({
              _tag: "Created",
              path: result.worktree.path,
              refName: result.worktree.refName,
            }) as const,
        ),
        Effect.catchCause((cause) =>
          Effect.succeed({ _tag: "Failed", detail: describe(cause) } as const),
        ),
      );

  return {
    dispatch,
    listProviders,
    listModels,
    listProjects,
    listThreads,
    getThread,
    readThread,
    pendingInput,
    createWorktree,
  } satisfies OrchestrationClient;
});
