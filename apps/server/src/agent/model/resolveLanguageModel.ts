/**
 * Turning a key and a model name into something that can answer.
 *
 * This is the whole "bring your own key" promise in one function. Each backend
 * is a client layer plus a model layer; the differences between them stop here,
 * and nothing downstream — not the loop, not the tools, not the adapter — knows
 * which one is in use.
 *
 * `openai-compat` is the important one. Ollama, LM Studio, vLLM, LiteLLM and
 * most self-hosted gateways speak the OpenAI wire format at some other address,
 * so pointing the OpenAI client at that address is all local inference needs.
 * It is also the escape hatch for a provider we have never heard of.
 *
 * @module agent/model/resolveLanguageModel
 */
import * as AnthropicClient from "@effect/ai-anthropic/AnthropicClient";
import * as AnthropicLanguageModel from "@effect/ai-anthropic/AnthropicLanguageModel";
import * as OpenAiClient from "@effect/ai-openai/OpenAiClient";
import * as OpenAiLanguageModel from "@effect/ai-openai/OpenAiLanguageModel";
import * as OpenRouterClient from "@effect/ai-openrouter/OpenRouterClient";
import * as OpenRouterLanguageModel from "@effect/ai-openrouter/OpenRouterLanguageModel";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import type * as LanguageModel from "effect/unstable/ai/LanguageModel";
import type { HttpClient } from "effect/unstable/http";

export const BACKEND_KINDS = ["anthropic", "openai", "openrouter", "openai-compat"] as const;
export type BackendKind = (typeof BACKEND_KINDS)[number];

export interface ResolveLanguageModelInput {
  readonly backend: BackendKind;
  readonly credential: Redacted.Redacted<string>;
  readonly model: string;
  /**
   * Override for the API base URL.
   *
   * Required for `openai-compat` — that backend is defined by its address —
   * and optional elsewhere, where it covers proxies and regional endpoints.
   */
  readonly baseUrl?: string | undefined;
}

export function resolveLanguageModel(
  input: ResolveLanguageModelInput,
): Layer.Layer<LanguageModel.LanguageModel, never, HttpClient.HttpClient> {
  switch (input.backend) {
    case "anthropic":
      return Layer.provide(
        AnthropicLanguageModel.layer({ model: input.model }),
        AnthropicClient.layer({
          apiKey: input.credential,
          ...(input.baseUrl === undefined ? {} : { apiUrl: input.baseUrl }),
        }),
      );

    case "openai":
      return Layer.provide(
        OpenAiLanguageModel.layer({ model: input.model }),
        OpenAiClient.layer({
          apiKey: input.credential,
          ...(input.baseUrl === undefined ? {} : { apiUrl: input.baseUrl }),
        }),
      );

    case "openrouter":
      return Layer.provide(
        OpenRouterLanguageModel.layer({ model: input.model }),
        OpenRouterClient.layer({
          apiKey: input.credential,
          ...(input.baseUrl === undefined ? {} : { apiUrl: input.baseUrl }),
        }),
      );

    case "openai-compat":
      return Layer.provide(
        OpenAiLanguageModel.layer({ model: input.model }),
        OpenAiClient.layer({
          apiKey: input.credential,
          // A local server usually ignores the key entirely, but the client
          // still wants one, which is why `credentials.ts` hands out a
          // placeholder rather than reporting the instance unauthenticated.
          apiUrl: input.baseUrl ?? "http://localhost:11434/v1",
        }),
      );
  }
}
