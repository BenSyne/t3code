/**
 * Where provider snapshots live, separately from what produces them.
 *
 * `ProviderRegistry` does two unrelated jobs: it *builds* provider instances —
 * probing binaries, spawning drivers, refreshing versions — and it *holds* the
 * resulting snapshots for anyone who wants to read them. Bundling both made
 * the second impossible to reach from inside a driver, because a driver asking
 * the registry for snapshots is asking the thing that constructs it.
 *
 * That is not a hypothetical. The built-in agent orchestrates the other
 * providers, so it needs to know which ones exist — and every attempt to give
 * it the registry produced a genuine cycle: `ProviderRegistry` →
 * `ProviderInstanceRegistry` → the drivers → `ProviderRegistry`. A late-bound
 * holder breaks it at runtime but not at the type level, where the layer
 * graph's requirements collapse to `any` and quietly disable missing-service
 * checking across the whole server.
 *
 * So the holding half moves here, into a service with no dependencies of its
 * own. `ProviderRegistry` writes; anything that only needs to read the current
 * state — the agent among them — depends on this instead and stays clear of
 * the construction graph entirely.
 *
 * Exactly one writer. `ProviderRegistryLive` owns every mutation, and `modify`
 * exists for it rather than as an invitation: two writers here would race over
 * the list the UI renders, with no ordering to appeal to.
 *
 * @module provider/Services/ProviderSnapshotStore
 */
import type { ServerProvider } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

export interface ProviderSnapshotStoreShape {
  /**
   * The snapshots themselves.
   *
   * A `Ref` rather than a pair of methods, deliberately. A `modify` shaped as
   * `<A>(update) => Effect<A>` is generic, and a generic function on a service
   * shape defeats the layer graph's inference: every requirement in the graph
   * collapses to `any`, which silently switches off missing-service checking
   * across the whole server. Handing over the `Ref` keeps the atomic
   * read-modify-write the registry needs without that cost.
   *
   * Empty before the registry's first pass rather than blocking on it: a
   * reader that arrives early should see "nothing yet", not deadlock against
   * a layer that has not finished building.
   */
  readonly ref: Ref.Ref<ReadonlyArray<ServerProvider>>;

  /** Read-only view, which is all any consumer outside the registry wants. */
  readonly get: Effect.Effect<ReadonlyArray<ServerProvider>>;
}

export class ProviderSnapshotStore extends Context.Service<
  ProviderSnapshotStore,
  ProviderSnapshotStoreShape
>()("t3/provider/Services/ProviderSnapshotStore") {}

/**
 * A leaf layer: it requires nothing, which is the entire point.
 *
 * Anything may depend on this without joining the provider construction graph,
 * which is what lets a driver read snapshots without depending on the registry
 * that builds drivers.
 */
export const ProviderSnapshotStoreLive = Layer.effect(
  ProviderSnapshotStore,
  Effect.gen(function* () {
    const ref = yield* Ref.make<ReadonlyArray<ServerProvider>>([]);
    return ProviderSnapshotStore.of({ ref, get: Ref.get(ref) });
  }),
);
