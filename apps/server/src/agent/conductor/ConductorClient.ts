/**
 * The Conductor's client, as a service.
 *
 * Without this the T3 Agent driver would depend on the orchestration engine,
 * the projections, and the snapshot store directly — three infrastructure
 * services, which then have to exist anywhere a driver is built. That is how a
 * unit test about provider snapshots ends up needing a database.
 *
 * One service instead, whose shape is the seam that already existed. The
 * driver names `ConductorClient`; production binds it to the real thing; a
 * test binds it to {@link ConductorClientUnavailable} in one line.
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

/**
 * A client that refuses everything, for contexts with no orchestration.
 *
 * Refuses rather than throws: the tools treat a rejected command as an answer,
 * so an agent that somehow reaches these gets a sentence it can act on instead
 * of a turn that dies. Tests use it to avoid standing up a database for a
 * feature they are not exercising.
 */
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
};

export const ConductorClientUnavailable = Layer.succeed(
  ConductorClient,
  ConductorClient.of(unavailableOrchestrationClient),
);
