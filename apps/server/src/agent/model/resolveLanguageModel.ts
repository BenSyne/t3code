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
import * as OpenAiCompatClient from "@effect/ai-openai-compat/OpenAiClient";
import * as OpenAiCompatLanguageModel from "@effect/ai-openai-compat/OpenAiLanguageModel";
import * as OpenRouterClient from "@effect/ai-openrouter/OpenRouterClient";
import * as OpenRouterLanguageModel from "@effect/ai-openrouter/OpenRouterLanguageModel";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import type * as LanguageModel from "effect/unstable/ai/LanguageModel";
import type { HttpClient } from "effect/unstable/http";

import type { ReasoningEffort } from "./reasoning.ts";

export const BACKEND_KINDS = [
  "anthropic",
  "openai",
  "openrouter",
  "cerebras",
  "openai-compat",
] as const;
export type BackendKind = (typeof BACKEND_KINDS)[number];

/**
 * Cerebras' endpoint, pinned.
 *
 * A first-class backend rather than a documented `openai-compat` recipe,
 * because everything that makes the picker useful — a model list before the
 * first request, a working default, the right reasoning levels per model —
 * needs a name to hang off. The wire format is still OpenAI's, so this costs
 * one switch arm and no new dependency.
 */
export const CEREBRAS_BASE_URL = "https://api.cerebras.ai/v1";

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
  /**
   * How hard to think, on the shared scale, or undefined to send nothing and
   * let the provider decide. Translated to each backend's wire shape below.
   */
  readonly reasoningEffort?: ReasoningEffort | undefined;
}

// ── Effort translation ────────────────────────────────────────────────
//
// Exported for tests: each function is the complete statement of how one
// backend spells the shared scale, pure and checkable without a network.
//
// Levels a backend cannot express clamp to its nearest neighbour rather than
// failing. The picker only offers what the catalogue says a model supports,
// so a clamp normally never fires — but selections outlive builds and users
// type custom model names, and "slightly less effort than asked" is the right
// failure mode where "the turn did not run" is not.

/**
 * Anthropic: adaptive thinking plus a native effort level.
 *
 * The adaptive API is what makes this mapping honest — the older knob was a
 * raw token budget, and any translation to it would have been an invented
 * number. `none` disables thinking entirely, which on Anthropic is also the
 * provider default.
 */
export function anthropicReasoningConfig(effort: ReasoningEffort | undefined):
  | { readonly thinking: { readonly type: "disabled" } }
  | {
      readonly thinking: { readonly type: "adaptive" };
      readonly output_config: { readonly effort: "low" | "medium" | "high" };
    }
  | undefined {
  switch (effort) {
    case undefined:
      return undefined;
    case "none":
      return { thinking: { type: "disabled" } };
    case "minimal":
    case "low":
      return { thinking: { type: "adaptive" }, output_config: { effort: "low" } };
    case "medium":
      return { thinking: { type: "adaptive" }, output_config: { effort: "medium" } };
    case "high":
    case "xhigh":
    case "max":
      return { thinking: { type: "adaptive" }, output_config: { effort: "high" } };
  }
}

/** OpenAI: the Responses API takes the scale directly, minus `max`. */
export function openAiReasoningConfig(
  effort: ReasoningEffort | undefined,
): { readonly reasoning: { readonly effort: Exclude<ReasoningEffort, "max"> } } | undefined {
  if (effort === undefined) {
    return undefined;
  }
  return { reasoning: { effort: effort === "max" ? "xhigh" : effort } };
}

/** OpenRouter: the scale is theirs, verbatim, and they translate per upstream model. */
export function openRouterReasoningConfig(
  effort: ReasoningEffort | undefined,
): { readonly reasoning_effort: ReasoningEffort } | undefined {
  return effort === undefined ? undefined : { reasoning_effort: effort };
}

/**
 * OpenAI-compatible servers: pass `reasoning_effort` through untranslated.
 *
 * The de-facto `/chat/completions` spelling, understood by vLLM, LiteLLM and
 * recent Ollama — and by Cerebras, which shares this arm. A server that has
 * never heard of it ignores the unknown field, which is exactly the behaviour
 * we want from a backend defined as "whatever is behind that address".
 */
export function compatReasoningConfig(
  effort: ReasoningEffort | undefined,
): { readonly reasoning_effort: ReasoningEffort } | undefined {
  return effort === undefined ? undefined : { reasoning_effort: effort };
}

/** Where a local server would be if the user has not said otherwise. */
export const DEFAULT_LOCAL_BASE_URL = "http://localhost:11434/v1";

/**
 * Which address the OpenAI-compatible client talks to.
 *
 * Cerebras is pinned: the endpoint is what makes that backend Cerebras, and
 * honouring an override would let a stray value point it somewhere else while
 * the UI still names Cerebras and the catalogue still offers its models.
 */
export function compatBaseUrl(
  backend: "cerebras" | "openai-compat",
  baseUrl: string | undefined,
): string {
  return backend === "cerebras" ? CEREBRAS_BASE_URL : (baseUrl ?? DEFAULT_LOCAL_BASE_URL);
}

export function resolveLanguageModel(
  input: ResolveLanguageModelInput,
): Layer.Layer<LanguageModel.LanguageModel, never, HttpClient.HttpClient> {
  switch (input.backend) {
    case "anthropic": {
      const config = anthropicReasoningConfig(input.reasoningEffort);
      return Layer.provide(
        AnthropicLanguageModel.layer({
          model: input.model,
          ...(config === undefined ? {} : { config }),
        }),
        AnthropicClient.layer({
          apiKey: input.credential,
          ...(input.baseUrl === undefined ? {} : { apiUrl: input.baseUrl }),
        }),
      );
    }

    case "openai": {
      const config = openAiReasoningConfig(input.reasoningEffort);
      return Layer.provide(
        OpenAiLanguageModel.layer({
          model: input.model,
          ...(config === undefined ? {} : { config }),
        }),
        OpenAiClient.layer({
          apiKey: input.credential,
          ...(input.baseUrl === undefined ? {} : { apiUrl: input.baseUrl }),
        }),
      );
    }

    case "openrouter": {
      const config = openRouterReasoningConfig(input.reasoningEffort);
      return Layer.provide(
        OpenRouterLanguageModel.layer({
          model: input.model,
          ...(config === undefined ? {} : { config }),
        }),
        OpenRouterClient.layer({
          apiKey: input.credential,
          ...(input.baseUrl === undefined ? {} : { apiUrl: input.baseUrl }),
        }),
      );
    }

    // Cerebras and every self-hosted server share this arm: both speak
    // `/chat/completions`. They differ only in where they are and whether we
    // know the address ahead of time.
    case "cerebras":
    case "openai-compat": {
      const config = compatReasoningConfig(input.reasoningEffort);
      // A different package from `openai`, and the difference is the whole
      // point: OpenAI's own client speaks the Responses API, while Cerebras,
      // Ollama, LM Studio, vLLM and every other compatible server implement
      // the older `/chat/completions`. Using the wrong one fails at the first
      // request with a schema error that reads like a bug in this repository.
      return Layer.provide(
        OpenAiCompatLanguageModel.layer({
          model: input.model,
          ...(config === undefined ? {} : { config }),
        }),
        OpenAiCompatClient.layer({
          apiKey: input.credential,
          // A local server usually ignores the key entirely, but the client
          // still wants one, which is why `credentials.ts` hands out a
          // placeholder rather than reporting the instance unauthenticated.
          // Cerebras does require a real key — see `keyOptional` in the driver.
          apiUrl: compatBaseUrl(input.backend, input.baseUrl),
        }),
      );
    }
  }
}
