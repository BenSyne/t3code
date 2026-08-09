/**
 * T3AgentDriver — `ProviderDriver` for the built-in agent.
 *
 * Mirrors the other drivers, minus everything to do with a subprocess. There is
 * no binary to locate, no version to probe and no package to update, so this
 * driver asks the runtime for far less than its siblings: no
 * `ChildProcessSpawner`, no `FileSystem`, no `Path`. Every service it does need
 * is already in the server's layer graph, which is why adding an in-process
 * provider requires no new runtime layer.
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
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import { T3AGENT_DRIVER_KIND } from "../../agent/driverKind.ts";
import { McpServerConfig, type McpServers } from "../../agent/mcp/serverConfig.ts";
import { resolveCredential } from "../../agent/model/credentials.ts";
import { contextWindowFor } from "../../agent/model/ModelCatalog.ts";
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

/**
 * Keep the entries that parse, drop the ones that do not.
 *
 * A typo in one server's config should not take the other servers — or the
 * provider — down with it. The dropped ones surface as a warning when the
 * session starts.
 */
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

export type T3AgentDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ServerConfig.ServerConfig
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | ServerSettingsService;

export const T3AgentDriver: ProviderDriver<T3AgentSettings, T3AgentDriverEnv> = {
  driverKind: T3AGENT_DRIVER_KIND,
  metadata: {
    displayName: "T3 Agent",
    supportsMultipleInstances: true,
  },
  configSchema: T3AgentSettings,
  defaultConfig: (): T3AgentSettings => decodeT3AgentSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const instanceEnv = mergeProviderInstanceEnvironment(environment);

      const backend = config.backend;
      const baseUrl = config.baseUrl.trim() === "" ? undefined : config.baseUrl.trim();

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
        return stampIdentity(
          buildT3AgentSnapshot({
            settings: { ...config, enabled },
            // Re-resolved on every check, so adding a key flips the instance to
            // authenticated without a restart.
            credential: credential(),
            checkedAt,
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

      const adapter = yield* makeT3AgentAdapter({
        credential,
        backend,
        defaultModel: defaultModelFor(config),
        commandEnv: instanceEnv as Record<string, string>,
        contextWindowFor: (model) => contextWindowFor(backend, model),
        permissionRules: [],
        // Decoded leniently: an MCP entry the user typed wrong should cost that
        // one server, not the whole provider instance.
        mcpServers: decodeMcpServers(config.mcpServers),
        homeDirectory: NodeOs.homedir(),
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
