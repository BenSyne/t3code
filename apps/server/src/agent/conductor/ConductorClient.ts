/**
 * The Conductor's client, as a service.
 *
 * @module agent/conductor/ConductorClient
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { makeLiveOrchestrationClient } from "./liveClient.ts";
import type { OrchestrationClient } from "./OrchestrationClient.ts";

export class ConductorClient extends Context.Service<ConductorClient, OrchestrationClient>()(
  "t3/agent/conductor/ConductorClient",
) {}

/** The real one, reading and dispatching against the running server. */
export const ConductorClientLive = Layer.effect(ConductorClient, makeLiveOrchestrationClient);

/** A client that refuses everything, for contexts with no orchestration. */
export const unavailableOrchestrationClient: OrchestrationClient = {
  dispatch: () =>
    Effect.succeed({ accepted: false, detail: "Orchestration is not available here." }),
  listProviders: Effect.succeed([]),
  listModels: () => Effect.succeed([]),
  listProjects: Effect.succeed([]),
  listThreads: () => Effect.succeed([]),
  getThread: () => Effect.succeed(undefined),
  readThread: () => Effect.succeed("Orchestration is not available here."),
  pendingInput: () => Effect.succeed([]),
  createWorktree: () =>
    Effect.succeed({ _tag: "Failed" as const, detail: "Orchestration is not available here." }),
};

export const ConductorClientUnavailable = Layer.succeed(
  ConductorClient,
  ConductorClient.of(unavailableOrchestrationClient),
);
