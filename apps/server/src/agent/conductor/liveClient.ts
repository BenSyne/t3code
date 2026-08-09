/**
 * The Conductor's `OrchestrationClient`, wired to the real server.
 *
 * Everything here is deliberately thin. The tools already decide what to do;
 * this only translates their intent into the same commands the web UI sends
 * and reads the same projections the web UI reads. If this file ever grows a
 * decision of its own, the "headless client, not a back door" property that
 * makes the Conductor safe has quietly been given up.
 *
 * Two shapes matter and are easy to get wrong:
 *
 * Failure is a *value*. A rejected command is something the model should read
 * and adapt to — "that provider is not authenticated" is information, not a
 * reason for the turn to die. Every method here converts errors into ordinary
 * results, which is why none of them carry an error type.
 *
 * Snapshots come from `ProviderSnapshotStore`, never `ProviderRegistry`. The
 * registry builds provider instances, this agent is one of the things it
 * builds, so depending on it here is a cycle. The store exists precisely to
 * be the half of that job which is safe to depend on.
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
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderSnapshotStore } from "../../provider/Services/ProviderSnapshotStore.ts";
import type { OrchestrationClient, ProviderSummary, ThreadSummary } from "./OrchestrationClient.ts";
import { lifecycleOf } from "./threadLifecycle.ts";
import { renderTranscript } from "./transcript.ts";

/**
 * A rejected command, in words.
 *
 * `Cause.pretty` rather than a check for `Error`: what arrives here is a
 * `Cause`, which is not an `Error`, so the obvious version answered "unknown
 * error" to everything. A malformed command then reported the one thing that
 * could not help — and did it to the model, which had no way to correct
 * itself, and to the user watching the tool fail for no stated reason.
 */
const describe = (cause: Cause.Cause<unknown>): string => {
  const pretty = Cause.pretty(cause).split("\n    at ")[0]?.trim() ?? "";
  return pretty === "" ? "the command was rejected" : pretty;
};

/**
 * Whether an instance bills per token or draws on something already paid for.
 *
 * Read from how it authenticates, because that is what actually decides it —
 * and the same driver goes either way. A Codex instance signed in to a ChatGPT
 * subscription costs nothing per delegation; the same driver holding an API key
 * bills every token. Anything we cannot read is `unknown` rather than assumed
 * free, since guessing wrong in that direction is what spends a user's money.
 */
function billingOf(auth: ServerProviderAuth): ProviderSummary["billing"] {
  if (auth.status !== "authenticated") {
    return "unknown";
  }
  if (auth.type === "api-key") {
    return "per-token";
  }
  return auth.type === undefined ? "unknown" : "subscription";
}

/**
 * Build the client from services already in the server graph.
 *
 * Requires the three it actually uses and nothing else, so the requirement
 * that would reintroduce the cycle cannot be added here by accident.
 */
export const makeLiveOrchestrationClient = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const projections = yield* ProjectionSnapshotQuery;
  const providerSnapshots = yield* ProviderSnapshotStore;

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

  /**
   * The navigation-level model.
   *
   * `getShellSnapshot` rather than `getSnapshot`: listing threads needs titles
   * and status, and the full snapshot hydrates every message of every thread
   * in the workspace to produce them. A projection failure resolves to nothing
   * rather than failing — an agent that cannot list threads should say so, not
   * lose the turn.
   */
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

  /**
   * The thread as text.
   *
   * Rendered rather than handed over as structure because the consumer is a
   * language model reading someone else's work, and the newest exchanges are
   * what it needs — hence the tail, not the head.
   */
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
        });
      }),
      Effect.catchCause((cause) =>
        Effect.succeed(`Could not read thread ${threadId}: ${describe(cause)}`),
      ),
    );

  return {
    dispatch,
    listProviders,
    listProjects,
    listThreads,
    getThread,
    readThread,
  } satisfies OrchestrationClient;
});
