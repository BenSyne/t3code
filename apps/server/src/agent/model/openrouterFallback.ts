/**
 * Generated. Do not edit by hand.
 *
 * The OpenRouter list the picker shows before the live catalogue resolves,
 * snapshotted from the live API on 2026-08-11 by the same policy the live
 * catalogue uses. Every id and context window here came from OpenRouter rather
 * than from memory, which is the whole point: hand-written entries drifted into
 * ids that no longer existed and windows that were wrong by five times.
 *
 * Refresh: node apps/server/scripts/refresh-openrouter-fallback.ts
 *
 * @module agent/model/openrouterFallback
 */
import type { CatalogModel } from "./ModelCatalog.ts";
import type { ReasoningEffort } from "./reasoning.ts";

/** Inlined rather than imported: importing a value from ModelCatalog would cycle. */
const EFFORTS: ReadonlyArray<ReasoningEffort> = ["none", "low", "medium", "high"];

export const OPENROUTER_FALLBACK_MODELS: ReadonlyArray<CatalogModel> = [
  {
    id: "anthropic/claude-opus-5-fast",
    label: "Claude Opus 5 (Fast)",
    vendor: "Anthropic",
    contextWindow: 1000000,
    reasoningEfforts: EFFORTS,
  },
  {
    id: "anthropic/claude-opus-5",
    label: "Claude Opus 5",
    vendor: "Anthropic",
    contextWindow: 1000000,
    reasoningEfforts: EFFORTS,
  },
  {
    id: "anthropic/claude-sonnet-5",
    label: "Claude Sonnet 5",
    vendor: "Anthropic",
    contextWindow: 1000000,
    reasoningEfforts: EFFORTS,
  },
  {
    id: "openai/gpt-5.6-luna-pro",
    label: "GPT-5.6 Luna Pro",
    vendor: "OpenAI",
    contextWindow: 1050000,
    reasoningEfforts: EFFORTS,
  },
  {
    id: "openai/gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    vendor: "OpenAI",
    contextWindow: 1050000,
    reasoningEfforts: EFFORTS,
  },
  {
    id: "openai/gpt-5.6-terra-pro",
    label: "GPT-5.6 Terra Pro",
    vendor: "OpenAI",
    contextWindow: 1050000,
    reasoningEfforts: EFFORTS,
  },
  {
    id: "google/gemini-3.6-flash",
    label: "Gemini 3.6 Flash",
    vendor: "Google",
    contextWindow: 1048576,
    reasoningEfforts: EFFORTS,
  },
  {
    id: "google/gemini-3.5-flash-lite",
    label: "Gemini 3.5 Flash Lite",
    vendor: "Google",
    contextWindow: 1048576,
    reasoningEfforts: EFFORTS,
  },
  {
    id: "google/gemini-3-pro-image",
    label: "Nano Banana Pro (Gemini 3 Pro Image)",
    vendor: "Google",
    contextWindow: 131072,
    reasoningEfforts: EFFORTS,
  },
  {
    id: "moonshotai/kimi-k3",
    label: "Kimi K3",
    vendor: "Moonshot AI",
    contextWindow: 1048576,
    reasoningEfforts: EFFORTS,
  },
  {
    id: "moonshotai/kimi-k2.7-code",
    label: "Kimi K2.7 Code",
    vendor: "Moonshot AI",
    contextWindow: 262144,
    reasoningEfforts: EFFORTS,
  },
  {
    id: "moonshotai/kimi-k2.6",
    label: "Kimi K2.6",
    vendor: "Moonshot AI",
    contextWindow: 262144,
    reasoningEfforts: EFFORTS,
  },
  {
    id: "deepseek/deepseek-v4-flash-0731",
    label: "DeepSeek V4 Flash 0731",
    vendor: "DeepSeek",
    contextWindow: 1048576,
    reasoningEfforts: EFFORTS,
  },
  {
    id: "deepseek/deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    vendor: "DeepSeek",
    contextWindow: 1048576,
    reasoningEfforts: EFFORTS,
  },
  {
    id: "deepseek/deepseek-v4-flash",
    label: "DeepSeek V4 Flash 0423",
    vendor: "DeepSeek",
    contextWindow: 1048576,
    reasoningEfforts: EFFORTS,
  },
  {
    id: "qwen/qwen3.8-max",
    label: "Qwen3.8 Max",
    vendor: "Qwen",
    contextWindow: 1000000,
    reasoningEfforts: EFFORTS,
  },
  {
    id: "qwen/qwen3.7-flash",
    label: "Qwen3.7 Flash",
    vendor: "Qwen",
    contextWindow: 1000000,
    reasoningEfforts: EFFORTS,
  },
  {
    id: "qwen/qwen3.7-plus",
    label: "Qwen3.7 Plus",
    vendor: "Qwen",
    contextWindow: 1000000,
    reasoningEfforts: EFFORTS,
  },
  {
    id: "minimax/minimax-m3",
    label: "MiniMax M3",
    vendor: "MiniMax",
    contextWindow: 1048576,
    reasoningEfforts: EFFORTS,
  },
  {
    id: "minimax/minimax-m2.7",
    label: "MiniMax M2.7",
    vendor: "MiniMax",
    contextWindow: 204800,
    reasoningEfforts: EFFORTS,
  },
  {
    id: "minimax/minimax-m2.5",
    label: "MiniMax M2.5",
    vendor: "MiniMax",
    contextWindow: 204800,
    reasoningEfforts: EFFORTS,
  },
  {
    id: "z-ai/glm-5.2",
    label: "GLM 5.2",
    vendor: "Z.ai",
    contextWindow: 1048576,
    reasoningEfforts: EFFORTS,
  },
  {
    id: "z-ai/glm-5.1",
    label: "GLM 5.1",
    vendor: "Z.ai",
    contextWindow: 204800,
    reasoningEfforts: EFFORTS,
  },
  {
    id: "z-ai/glm-5v-turbo",
    label: "GLM 5V Turbo",
    vendor: "Z.ai",
    contextWindow: 202752,
    reasoningEfforts: EFFORTS,
  },
];
