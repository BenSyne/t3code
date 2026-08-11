/**
 * T3AgentDriver — `ProviderDriver` for the built-in agent.
 *
 * @module provider/Drivers/T3AgentDriver
 */
import { DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER, T3AgentSettings } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import * as UsageService from "../../usage/UsageService.ts";
import { T3AGENT_DRIVER_KIND } from "../../agent/driverKind.ts";
import { ConductorClient } from "../../agent/conductor/ConductorClient.ts";
import type { ConductorContext } from "../../agent/conductor/conductorTools.ts";
import { DEFAULT_FLEET_POLICY } from "../../agent/conductor/fleet.ts";
import { McpServerConfig, type McpServers } from "../../agent/mcp/serverConfig.ts";
import { safeBaseUrlOrUndefined } from "../../agent/model/baseUrl.ts";
import { resolveCredential } from "../../agent/model/credentials.ts";
import { contextWindowFor } from "../../agent/model/ModelCatalog.ts";
import { makeAnthropicCatalog } from "../../agent/model/anthropicCatalog.ts";
import { makeOpenRouterCatalog } from "../../agent/model/openRouterCatalog.ts";
import { resolveLanguageModel } from "../../agent/model/resolveLanguageModel.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeT3AgentAdapter } from "../Layers/T3AgentAdapter.ts";
import { buildT3AgentSnapshot, defaultModelFor } from "../Layers/T3AgentProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeT3AgentTextGeneration } from "../../textGeneration/T3AgentTextGeneration.ts";

const decodeT3AgentSettings = Schema.decodeSync(T3AgentSettings);
const decodeMcpServer = Schema.decodeUnknownOption(McpServerConfig);

/** Keep the entries that parse, drop the ones that do not. */
function decodeMcpServers(raw: Record<string, unknown>): McpServers {
  const parsed: Record<string, McpServerConfig> = {};
  for (const [name, value] of Object.entries(raw)) {
    const decoded = decodeMcpServer(value);
    if (decoded._tag === "Some") {
      parsed[name] = decoded.value;
    }
  }
  return parsed;
}

/** What this driver needs from the runtime. */
export type T3AgentDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ServerConfig.ServerConfig
  | UsageService.UsageService
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | ServerSettingsService
  | ConductorClient;

export const T3AgentDriver: ProviderDriver<T3AgentSettings, T3AgentDriverEnv> = {
  driverKind: T3AGENT_DRIVER_KIND,
  metadata: {
    displayName: "T3 Orchestrator",
    supportsMultipleInstances: true,
  },
  configSchema: T3AgentSettings,
  defaultConfig: (): T3AgentSettings => decodeT3AgentSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const usage = yield* UsageService.UsageService;
      const instanceEnv = mergeProviderInstanceEnvironment(environment);

      const backend = config.backend;
      // Re-checked on the way out of settings, not just on the way in: this is
      // a JSON file a person can edit, and every request the agent makes sends
      // the key to this address. An unsafe one is dropped rather than honoured,
      // which falls back to the default instead of failing the provider.
      const baseUrl = safeBaseUrlOrUndefined(config.baseUrl);
      const crypto = yield* Crypto.Crypto;
      // Read on demand rather than captured: a key added after the instance was
      // materialised should work without restarting the server.
      const credential = () =>
        resolveCredential({
          variableName: config.credentialEnvVar,
          instanceEnv,
          // A local server authenticates nothing, so demanding a key would
          // report an instance as broken when it is ready to use.
          keyOptional: backend === "openai-compat",
        });
      // The two backends that publish a catalogue worth reading. OpenRouter's
      // is public; Anthropic's needs the key and is worth the call because it
      // carries the context window and the efforts each model accepts, both of
      // which were wrong while they were written out by hand. Null rather than
      // an empty catalogue, so the fallback is decided in one place.
      // Kept apart because only one of them prices: OpenRouter publishes exact
      // per-token rates alongside the windows, in the response we already
      // fetch.
      const openRouterCatalog = backend === "openrouter" ? yield* makeOpenRouterCatalog() : null;
      const anthropicCatalog =
        backend === "anthropic" ? yield* makeAnthropicCatalog(credential) : null;
      const liveCatalog = openRouterCatalog ?? anthropicCatalog;

      const stampIdentity = (draft: ServerProviderDraft) => ({
        ...draft,
        instanceId,
        driver: T3AGENT_DRIVER_KIND,
        ...(displayName ? { displayName } : {}),
        ...(accentColor ? { accentColor } : {}),
        continuation: {
          groupKey: defaultProviderContinuationIdentity({
            driverKind: T3AGENT_DRIVER_KIND,
            instanceId,
          }).continuationKey,
        },
      });

      const buildSnapshot = Effect.gen(function* () {
        const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
        // Refreshed on the snapshot cadence — the same rhythm that re-checks
        // the credential — so a new frontier model appears without a restart.
        const liveModels =
          liveCatalog === null ? undefined : ((yield* liveCatalog.current) ?? undefined);
        return stampIdentity(
          buildT3AgentSnapshot({
            settings: { ...config, enabled },
            // Re-resolved on every check, so adding a key flips the instance to
            // authenticated without a restart.
            credential: credential(),
            checkedAt,
            liveModels,
          }),
        );
      });

      const snapshotSettings = makeProviderSnapshotSettingsSource(config, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<T3AgentSettings>>({
        maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
          provider: T3AGENT_DRIVER_KIND,
          // Nothing to update: the agent ships with the server.
          packageName: null,
        }),
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: () => buildSnapshot,
        checkProvider: buildSnapshot,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: T3AGENT_DRIVER_KIND,
              instanceId,
              detail: `Failed to build T3 Agent snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      // Built once per instance. Off unless the user asks for it: these tools
      // start real threads on other providers, which costs money on whatever
      // key those providers use.
      const conductor: ConductorContext | null = config.orchestrateOtherAgents
        ? {
            client: yield* ConductorClient,
            policy: DEFAULT_FLEET_POLICY,
            // Its own kind, so the self-targeting guard can recognise a T3
            // Agent instance as itself however it has been renamed.
            selfDriverKind: T3AGENT_DRIVER_KIND,
            nextId: crypto.randomUUIDv4.pipe(Effect.orDie),
            nowIso: Effect.map(DateTime.now, DateTime.formatIso),
          }
        : null;

      const adapter = yield* makeT3AgentAdapter({
        conductor,
        credential,
        backend,
        defaultModel: defaultModelFor(config),
        commandEnv: instanceEnv as Record<string, string>,
        // The live catalogue knows windows for models the static list has
        // never heard of; the static list still answers for the rest.
        contextWindowFor: (model) =>
          liveCatalog?.contextWindowOf(model) ?? contextWindowFor(backend, model),
        // Only where the backend publishes its own; everything else prices off
        // the shared table.
        ...(openRouterCatalog === null ? {} : { modelRateFor: openRouterCatalog.rateOf }),
        permissionRules: [],
        // Decoded leniently: an MCP entry the user typed wrong should cost that
        // one server, not the whole provider instance.
        mcpServers: decodeMcpServers(config.mcpServers),
        homeDirectory: NodeOS.homedir(),
        rateTable: usage.rateTable,
        // Per instance, so two instances in the same project keep separate
        // conversations rather than reading each other's history.
        transcriptDirectory: NodePath.join(
          serverConfig.stateDir,
          "agent",
          "transcripts",
          instanceId,
        ),
        ...(baseUrl === undefined ? {} : { baseUrl }),
      });

      // Titles and commit messages run on a cheaper model than the chat turn.
      const httpClient = yield* HttpClient.HttpClient;
      const textGenerationModel =
        DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[T3AGENT_DRIVER_KIND] ?? "claude-haiku-4-5";
      const textGeneration = makeT3AgentTextGeneration({
        resolveModel: () => {
          const resolved = credential();
          if (resolved._tag === "Missing") {
            return {
              _tag: "Unavailable" as const,
              detail: `No API key. Set ${resolved.variableName} on this provider instance.`,
            };
          }
          return {
            _tag: "Ready" as const,
            layer: Layer.provide(
              resolveLanguageModel({
                backend,
                credential: resolved.key,
                model: textGenerationModel,
                ...(baseUrl === undefined ? {} : { baseUrl }),
              }),
              Layer.succeed(HttpClient.HttpClient, httpClient),
            ),
          };
        },
      });

      return {
        instanceId,
        driverKind: T3AGENT_DRIVER_KIND,
        continuationIdentity: defaultProviderContinuationIdentity({
          driverKind: T3AGENT_DRIVER_KIND,
          instanceId,
        }),
        displayName,
        ...(accentColor === undefined ? {} : { accentColor }),
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
