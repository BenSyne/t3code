/**
 * T3AgentAdapter — adapter shape for the built-in agent.
 *
 * Mirrors the other provider adapter shapes: pins the error channel so the
 * implementation and its call sites agree without repeating the generic
 * everywhere. Following the directory convention, the types live here and the
 * implementation lives in `Layers/`.
 *
 * @module provider/Services/T3AgentAdapter
 */
import type * as Effect from "effect/Effect";
import type * as Crypto from "effect/Crypto";
import type * as FileSystem from "effect/FileSystem";
import type { HttpClient } from "effect/unstable/http";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import type { McpServers } from "../../agent/mcp/serverConfig.ts";
import type { PermissionRule } from "../../agent/permission/rules.ts";
import type { ConductorContext } from "../../agent/conductor/conductorTools.ts";
import type { BackendKind } from "../../agent/model/resolveLanguageModel.ts";
import type { ResolvedCredential } from "../../agent/model/credentials.ts";
import type { RateTable } from "../../usage/usagePricing.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export type T3AgentAdapterShape = ProviderAdapterShape<ProviderAdapterError>;

export interface T3AgentAdapterOptions {
  /** Re-read per session so a key added after startup is picked up. */
  readonly credential: () => ResolvedCredential;
  readonly backend: BackendKind;
  /** Override for the provider's endpoint. Required for OpenAI-compatible servers. */
  readonly baseUrl?: string | undefined;
  readonly defaultModel: string;
  /** Environment for commands the `bash` tool runs. */
  readonly commandEnv: Record<string, string>;
  /** Context window for the usage meter, or null when the model is unknown to us. */
  readonly contextWindowFor: (model: string) => number | null;
  /** Rules the user set, evaluated after the mode default. */
  readonly permissionRules: ReadonlyArray<PermissionRule>;
  /** Where conversations are written so they survive a restart. */
  readonly transcriptDirectory: string;
  readonly mcpServers: McpServers;
  /** Model rates, for showing what a turn cost on a key the user pays for. */
  readonly rateTable: Effect.Effect<RateTable>;
  /** For discovering global skills. */
  readonly homeDirectory: string;
  /**
   * Lets this agent run the *other* agents, or null to withhold the ability.
   *
   * Null rather than an empty policy so the tools are absent from the prompt
   * entirely when the feature is off. A tool the model can see is a tool it
   * will try, and spending a step to be told no is worse than never offering
   * it. Off is the default: orchestration spends money on other providers.
   */
  readonly conductor: ConductorContext | null;
}

/**
 * What the adapter needs from the runtime.
 *
 * All four are already in the server's layer graph, which is why an in-process
 * provider still adds no new runtime layer. `ChildProcessSpawner` and
 * `FileSystem` arrived with the tools — an agent that cannot read a file or run
 * a command is not a coding agent — but nothing here launches a *provider*
 * process, which is the distinction that keeps this driver simple.
 */
export type T3AgentAdapterEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient;
