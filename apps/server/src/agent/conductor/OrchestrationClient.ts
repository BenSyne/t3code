/**
 * The seam the Conductor reaches the rest of T3 Code through.
 *
 * The agent orchestrates other providers by dispatching the *same*
 * `ClientOrchestrationCommand`s the web UI dispatches — a headless client, not
 * a privileged internal path. Every guard the UI goes through applies here
 * unchanged, and a thread the agent started is an ordinary thread the user can
 * interrupt or take over.
 *
 * The interface names only what the tools need. Widening it is how "headless
 * client" quietly becomes "back door", so new capability should arrive as a new
 * command rather than a new method here.
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

import type { PendingUserInput } from "./pendingRequests.ts";
import type { ThreadLifecycle } from "./threadLifecycle.ts";

/** What the agent can see about a thread it did not start. */
export interface ThreadSummary {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly status: string;
  readonly updatedAt: string;
  readonly lifecycle: ThreadLifecycle;
  /** Read from `activeTurnId`, the field that actually decides whether work is running. */
  readonly isRunning: boolean;
  /**
   * Stopped and waiting on a person. Not the opposite of `isRunning` — a
   * blocked thread is idle *and* unfinished, and reads as "working" to anything
   * looking only at status.
   */
  readonly awaitingInput: boolean;
  readonly awaitingApproval: boolean;
}

/**
 * A project, as much of one as the agent needs to start work in it.
 *
 * Three fields rather than the full `OrchestrationProject`: the
 * navigation-level projection already returns exactly this much, and the wide
 * type would force hydrating every message in the workspace.
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
   * Read from the instance's own auth rather than hardcoded per driver, because
   * the same driver is either depending on how it was set up.
   */
  readonly billing: "subscription" | "per-token" | "unknown";
}

/** One model an instance can actually be pointed at. */
export interface ModelSummary {
  readonly slug: string;
  readonly name: string;
  readonly isDefault: boolean;
  /** Superseded but still selectable. Not a default choice. */
  readonly isLegacy: boolean;
  /** Who actually makes it, where the instance is an aggregator. */
  readonly vendor: string | null;
  /** Empty means no reasoning control, so passing an effort is silently meaningless. */
  readonly reasoningEfforts: ReadonlyArray<string>;
}

export interface OrchestrationClient {
  /**
   * Dispatch a command exactly as a client would. Failure is a value: a
   * rejected command is something the agent adapts to, not a reason for its
   * turn to end.
   */
  readonly dispatch: (
    command: DispatchableClientOrchestrationCommand,
  ) => Effect.Effect<{ readonly accepted: boolean; readonly detail?: string | undefined }>;

  readonly listProviders: Effect.Effect<ReadonlyArray<ProviderSummary>>;
  /**
   * Separate from `listProviders` because a workspace with several aggregator
   * instances has hundreds of models between them, and "who can I delegate to"
   * should not pay for that every time it is asked.
   */
  readonly listModels: (instanceId: string) => Effect.Effect<ReadonlyArray<ModelSummary>>;
  readonly listProjects: Effect.Effect<ReadonlyArray<ProjectSummary>>;
  readonly listThreads: (projectId: string) => Effect.Effect<ReadonlyArray<ThreadSummary>>;
  /**
   * One thread without needing to know its project. Returns exactly what
   * `listThreads` does — it exists because acting on a thread needs its current
   * state, and making the agent guess the project is a lookup it gets wrong.
   */
  readonly getThread: (threadId: ThreadId) => Effect.Effect<ThreadSummary | undefined>;
  /** The transcript of a thread, as text the model can read. */
  readonly readThread: (threadId: ThreadId) => Effect.Effect<string>;
  /** The questions a thread is blocked on, if any. */
  readonly pendingInput: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<PendingUserInput>>;
}
