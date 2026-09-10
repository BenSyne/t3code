import { expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  OrchestrationShellSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { TestClock } from "effect/testing";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { ProviderRegistry } from "./Services/ProviderRegistry.ts";
import { ProviderService } from "./Services/ProviderService.ts";
import { ProviderMaintenanceRunner } from "./providerMaintenanceRunner.ts";
import { makeProviderMaintenanceCapabilities } from "./providerMaintenance.ts";
import { makeProviderAutoUpdater } from "./providerAutoUpdate.ts";

it.effect(
  "updates each shared installation once, defers busy work, and bounds failed retries",
  () => {
    const main = ProviderInstanceId.make("codex");
    const backup = ProviderInstanceId.make("codex_backup");
    const opencode = ProviderInstanceId.make("opencode");
    let busy = false;
    const calls: Array<ProviderInstanceId> = [];
    const providers: ReadonlyArray<ServerProvider> = [main, backup, opencode].map((instanceId) => ({
      instanceId,
      driver: ProviderDriverKind.make(instanceId === opencode ? "opencode" : "codex"),
      enabled: true,
      installed: true,
      status: "ready",
      auth: { status: "authenticated" },
      version: "1.0.0",
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
      versionAdvisory: {
        status: "behind_latest",
        currentVersion: "1.0.0",
        latestVersion: "2.0.0",
        updateCommand: "npm update",
        canUpdate: true,
        checkedAt: null,
        message: null,
      },
    }));
    return Effect.gen(function* () {
      const settings = yield* ServerSettingsService;
      const check = yield* makeProviderAutoUpdater();
      yield* check();
      expect(calls).toEqual([]);
      yield* settings.updateSettings({ autoUpdateProviders: true });
      busy = true;
      yield* check();
      expect(calls).toEqual([]);
      busy = false;
      yield* check();
      yield* check();
      expect(calls).toEqual([main, opencode]);
      yield* settings.updateSettings({ enableProviderUpdateChecks: false });
      yield* TestClock.adjust("6 hours");
      yield* check();
      expect(calls).toEqual([main, opencode]);
      yield* settings.updateSettings({ enableProviderUpdateChecks: true });
      yield* check();
      expect(calls).toEqual([main, opencode, main, opencode]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettingsService.layerTest(),
          Layer.mock(ProviderService, { listSessions: () => Effect.succeed([]) }),
          Layer.mock(ProjectionSnapshotQuery, {
            getShellSnapshot: () =>
              Schema.decodeUnknownEffect(OrchestrationShellSnapshot)({
                snapshotSequence: 0,
                projects: [],
                updatedAt: "2026-01-01T00:00:00.000Z",
                threads: busy
                  ? [
                      {
                        id: "busy-task",
                        projectId: "project",
                        title: "Waiting for an answer",
                        modelSelection: { instanceId: main, model: "test" },
                        runtimeMode: "approval-required",
                        branch: null,
                        worktreePath: null,
                        latestTurn: null,
                        session: null,
                        createdAt: "2026-01-01T00:00:00.000Z",
                        updatedAt: "2026-01-01T00:00:00.000Z",
                        latestUserMessageAt: null,
                        hasPendingApprovals: true,
                        hasPendingUserInput: false,
                        hasActionableProposedPlan: false,
                      },
                    ]
                  : [],
              }).pipe(Effect.orDie),
          }),
          Layer.mock(ProviderRegistry, {
            getProviders: Effect.succeed(providers),
            getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider) =>
              Effect.succeed(
                makeProviderMaintenanceCapabilities({
                  provider,
                  packageName: String(provider),
                  updateExecutable: "npm",
                  updateArgs: ["install", "-g", String(provider)],
                  updateLockKey: "npm-global",
                }),
              ),
          }),
          Layer.mock(ProviderMaintenanceRunner, {
            updateProvider: (target, canRun) =>
              Effect.gen(function* () {
                expect(canRun && (yield* canRun)).toBe(true);
                if (typeof target !== "string" && target.instanceId) calls.push(target.instanceId);
                return {
                  providers: providers.map((provider) => ({
                    ...provider,
                    updateState: {
                      status: "failed" as const,
                      startedAt: null,
                      finishedAt: null,
                      message: "Simulated failure",
                      output: null,
                    },
                  })),
                };
              }),
          }),
        ),
      ),
    );
  },
);
