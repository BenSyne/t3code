/**
 * Language-model resolution for the built-in agent.
 *
 * One function turning a credential and a model slug into a `LanguageModel`
 * layer. Effect 4 ships first-party clients for the providers we care about, so
 * this file is a thin composition rather than a protocol implementation — the
 * wire formats are upstream's problem, not ours.
 *
 * Only Anthropic exists here today. The shape is deliberately built to widen:
 * additional backends become additional branches returning the same
 * `Layer<LanguageModel, never, HttpClient>`, so nothing downstream changes.
 *
 * @module agent/model/resolveLanguageModel
 */
import * as AnthropicClient from "@effect/ai-anthropic/AnthropicClient";
import * as AnthropicLanguageModel from "@effect/ai-anthropic/AnthropicLanguageModel";
import type { HttpClient } from "effect/unstable/http";
import type * as LanguageModel from "effect/unstable/ai/LanguageModel";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";

/**
 * Backends the agent can talk to.
 *
 * `openai-compat` is the deliberate catch-all for later: one branch covers
 * Ollama, LM Studio, vLLM and every hosted OpenAI-compatible endpoint, so we
 * never grow a branch per vendor.
 */
export type BackendKind = "anthropic";

export interface ResolveLanguageModelInput {
  readonly backend: BackendKind;
  readonly credential: Redacted.Redacted<string>;
  readonly model: string;
}

/**
 * Build the layer that satisfies `LanguageModel` for one turn.
 *
 * `HttpClient` is the only requirement left open, and the server runtime
 * already provides it — so a driver using this needs no new layer.
 */
export function resolveLanguageModel(
  input: ResolveLanguageModelInput,
): Layer.Layer<LanguageModel.LanguageModel, never, HttpClient.HttpClient> {
  switch (input.backend) {
    case "anthropic":
      return Layer.provide(
        AnthropicLanguageModel.layer({ model: input.model }),
        AnthropicClient.layer({ apiKey: input.credential }),
      );
  }
}
