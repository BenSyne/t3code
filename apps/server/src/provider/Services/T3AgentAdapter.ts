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
import type * as Crypto from "effect/Crypto";
import type { HttpClient } from "effect/unstable/http";

import type { ResolvedCredential } from "../../agent/model/credentials.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export type T3AgentAdapterShape = ProviderAdapterShape<ProviderAdapterError>;

export interface T3AgentAdapterOptions {
  /** Re-read per session so a key added after startup is picked up. */
  readonly credential: () => ResolvedCredential;
  readonly defaultModel: string;
}

/**
 * What the adapter needs from the runtime. Both are already in the server's
 * layer graph, which is why an in-process provider adds no new layer.
 */
export type T3AgentAdapterEnv = HttpClient.HttpClient | Crypto.Crypto;
