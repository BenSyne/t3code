/**
 * The seam the Conductor reaches the rest of T3 Code through.
 *
 * The agent orchestrates other providers by dispatching the *same*
 * `ClientOrchestrationCommand`s the web UI dispatches. It is a headless client,
 * not a privileged internal path, and that is the whole design.
 *
 * Two consequences follow, and both are the point:
 *
 *   - Every guard, validation, and event the UI goes through applies here
 *     unchanged. There is no second code path to keep in sync and no way for
 *     the agent to reach a state a person could not have reached.
 *   - A thread the agent started is an ordinary thread. It appears in the
 *     sidebar, streams into the UI, and can be interrupted, reverted, or taken
 *     over by the user at any point.
 *
 * This interface deliberately names only what the tools need. Widening it is
 * how "headless client" quietly becomes "back door", so a new capability should
 * arrive as a new command, not as a new method here.
 *
 * @module agent/conductor/OrchestrationClient
 */
import type {
  DispatchableClientOrchestrationCommand,
  OrchestrationProject,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

/** What the agent can see about a thread it did not start. */
export interface ThreadSummary {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly status: string;
  readonly updatedAt: string;
}

export interface ProviderSummary {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: string;
  readonly displayName: string;
  readonly available: boolean;
  readonly defaultModel: string | null;
}

export interface OrchestrationClient {
  /**
   * Dispatch a command exactly as a client would.
   *
   * Failure is a value: a rejected command is something the agent should read
   * and adapt to, not a reason for its turn to end.
   */
  readonly dispatch: (
    command: DispatchableClientOrchestrationCommand,
  ) => Effect.Effect<{ readonly accepted: boolean; readonly detail?: string | undefined }>;

  readonly listProviders: Effect.Effect<ReadonlyArray<ProviderSummary>>;
  readonly listProjects: Effect.Effect<ReadonlyArray<OrchestrationProject>>;
  readonly listThreads: (projectId: string) => Effect.Effect<ReadonlyArray<ThreadSummary>>;
  /** The transcript of a thread, as text the model can read. */
  readonly readThread: (threadId: ThreadId) => Effect.Effect<string>;
}
