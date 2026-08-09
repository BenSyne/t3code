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
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ThreadLifecycle } from "./threadLifecycle.ts";

/** What the agent can see about a thread it did not start. */
export interface ThreadSummary {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly status: string;
  readonly updatedAt: string;
  /**
   * Where the thread sits in the inbox.
   *
   * Without this the agent can change a thread's state but never see the
   * state it is changing, so "settle everything that is finished" becomes
   * settling threads that already were — repeatedly, with no way to tell.
   */
  readonly lifecycle: ThreadLifecycle;
  /**
   * Whether a turn is in flight right now.
   *
   * Read from `activeTurnId` rather than from the coarser session status,
   * because that is the field that actually decides whether work is running.
   */
  readonly isRunning: boolean;
}

/**
 * A project, as much of one as the agent needs to start work in it.
 *
 * Three fields rather than the full `OrchestrationProject` on purpose. The
 * navigation-level projection already returns exactly this much, and naming
 * the wide type here would force the client to hydrate every message in the
 * workspace to answer "what projects are there".
 */
export interface ProjectSummary {
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
}

export interface ProviderSummary {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: string;
  readonly displayName: string;
  readonly available: boolean;
  readonly defaultModel: string | null;
  /**
   * Whether work sent here adds to a bill or draws on something already paid.
   *
   * The single most decision-relevant fact about a provider, and one the agent
   * cannot infer from a name. A Codex instance on a ChatGPT subscription costs
   * nothing extra per delegation; an instance holding an API key bills every
   * token. Read from the instance's own auth rather than hardcoded per driver,
   * because the same driver can be either depending on how it was set up.
   */
  readonly billing: "subscription" | "per-token" | "unknown";
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
  readonly listProjects: Effect.Effect<ReadonlyArray<ProjectSummary>>;
  readonly listThreads: (projectId: string) => Effect.Effect<ReadonlyArray<ThreadSummary>>;
  /**
   * One thread, without needing to know which project it is in.
   *
   * Not a widening of what the agent can see — it returns exactly what
   * `listThreads` already returns. It exists because acting on a thread needs
   * its current state first, and making the agent guess the project to find a
   * thread it already has the id of is a lookup it would get wrong.
   */
  readonly getThread: (threadId: ThreadId) => Effect.Effect<ThreadSummary | undefined>;
  /** The transcript of a thread, as text the model can read. */
  readonly readThread: (threadId: ThreadId) => Effect.Effect<string>;
}
