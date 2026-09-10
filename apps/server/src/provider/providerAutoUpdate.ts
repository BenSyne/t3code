import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { ProviderRegistry } from "./Services/ProviderRegistry.ts";
import { ProviderService } from "./Services/ProviderService.ts";
import { ProviderMaintenanceRunner } from "./providerMaintenanceRunner.ts";

const encodeUpdateKey = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Tuple([Schema.String, Schema.String, Schema.Array(Schema.String), Schema.String]),
  ),
);

/** One updater per server, with retries bounded per installation and release. */
export const makeProviderAutoUpdater = Effect.fn("makeProviderAutoUpdater")(function* () {
  const settings = yield* ServerSettingsService;
  const registry = yield* ProviderRegistry;
  const sessions = yield* ProviderService;
  const query = yield* ProjectionSnapshotQuery;
  const runner = yield* ProviderMaintenanceRunner;
  const attempted = new Map<string, number>();

  const canRun = Effect.gen(function* () {
    const current = yield* settings.getSettings;
    if (!current.autoUpdateProviders || !current.enableProviderUpdateChecks) return false;
    const active = yield* sessions.listSessions();
    if (
      active.some(
        (session) =>
          session.status === "running" ||
          session.status === "connecting" ||
          session.activeTurnId != null,
      )
    )
      return false;
    const snapshot = yield* query.getShellSnapshot();
    return !snapshot.threads.some(
      (thread) =>
        thread.hasPendingApprovals ||
        thread.hasPendingUserInput ||
        thread.backgroundLiveness != null ||
        thread.latestTurn?.state === "running" ||
        thread.session?.status === "starting" ||
        thread.session?.status === "running",
    );
  }).pipe(Effect.catch(() => Effect.succeed(false)));

  return Effect.fn("ProviderAutoUpdater.check")(function* () {
    if (!(yield* canRun)) return;
    const now = yield* Clock.currentTimeMillis;
    for (const [key, at] of attempted) {
      if (now - at >= 6 * 60 * 60_000) attempted.delete(key);
    }
    for (const provider of yield* registry.getProviders) {
      const advisory = provider.versionAdvisory;
      if (
        !provider.enabled ||
        !provider.installed ||
        !advisory?.canUpdate ||
        advisory.status !== "behind_latest" ||
        !advisory.latestVersion ||
        provider.updateState?.status === "running" ||
        provider.updateState?.status === "queued"
      )
        continue;
      const capabilities = yield* registry.getProviderMaintenanceCapabilitiesForInstance(
        provider.instanceId,
        provider.driver,
      );
      if (!capabilities.update) continue;
      const key = encodeUpdateKey([
        capabilities.update.lockKey,
        capabilities.update.executable,
        capabilities.update.args,
        advisory.latestVersion,
      ]);
      if (attempted.has(key)) continue;
      if (!(yield* canRun)) return;
      const result = yield* runner
        .updateProvider({ provider: provider.driver, instanceId: provider.instanceId }, canRun)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      const status = result?.providers.find((entry) => entry.instanceId === provider.instanceId)
        ?.updateState?.status;
      if (status !== "idle") attempted.set(key, now);
    }
  });
});
