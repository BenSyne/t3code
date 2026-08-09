/**
 * Which models exist, and how big their context windows are.
 *
 * Two jobs. The picker needs a list to show before any network call, so a user
 * who just pasted a key sees something immediately rather than a spinner. And
 * the usage meter needs a denominator — a token count with no window to compare
 * it against tells the user nothing about when to compact.
 *
 * Deliberately incomplete, and that is fine. A model missing from this table
 * still works: the picker accepts any string the user types, and an unknown
 * context window reports as unknown rather than as a wrong number. This is a
 * convenience, never a gate.
 *
 * @module agent/model/ModelCatalog
 */
import type { BackendKind } from "./resolveLanguageModel.ts";

export interface CatalogModel {
  /** The id sent on the wire. */
  readonly id: string;
  readonly label: string;
  readonly contextWindow: number;
}

/**
 * Known models per backend, best-first.
 *
 * `openai-compat` is deliberately empty: whatever is behind that address is
 * whatever the user is running, and guessing would be worse than asking.
 */
export const KNOWN_MODELS: Record<BackendKind, ReadonlyArray<CatalogModel>> = {
  anthropic: [
    { id: "claude-opus-5", label: "Claude Opus 5", contextWindow: 200_000 },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5", contextWindow: 200_000 },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", contextWindow: 200_000 },
  ],
  openai: [
    { id: "gpt-5.1", label: "GPT-5.1", contextWindow: 400_000 },
    { id: "gpt-5.1-mini", label: "GPT-5.1 mini", contextWindow: 400_000 },
    { id: "o4-mini", label: "o4-mini", contextWindow: 200_000 },
  ],
  openrouter: [
    { id: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5", contextWindow: 200_000 },
    { id: "openai/gpt-5.1", label: "GPT-5.1", contextWindow: 400_000 },
    { id: "google/gemini-3-pro", label: "Gemini 3 Pro", contextWindow: 1_048_576 },
    { id: "moonshotai/kimi-k3", label: "Kimi K3", contextWindow: 1_048_576 },
    { id: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash", contextWindow: 1_048_576 },
    { id: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro", contextWindow: 1_048_576 },
  ],
  "openai-compat": [],
};

/**
 * The context window for a model, or null if we do not know it.
 *
 * Null rather than a default: a made-up denominator makes the meter actively
 * misleading, and "unknown" is a thing the UI can render honestly.
 */
export function contextWindowFor(backend: BackendKind, model: string): number | null {
  const match = KNOWN_MODELS[backend].find((candidate) => candidate.id === model);
  if (match !== undefined) {
    return match.contextWindow;
  }
  // OpenRouter ids carry the upstream model, so `anthropic/claude-sonnet-5`
  // can borrow the window we already know for `claude-sonnet-5`.
  const bare = model.includes("/") ? (model.split("/").at(-1) ?? model) : model;
  for (const models of Object.values(KNOWN_MODELS)) {
    const cross = models.find(
      (candidate) => candidate.id === bare || candidate.id.endsWith(`/${bare}`),
    );
    if (cross !== undefined) {
      return cross.contextWindow;
    }
  }
  return null;
}

/** Suggestions for the picker: what we know, plus whatever the user added. */
export function modelOptions(
  backend: BackendKind,
  customModels: ReadonlyArray<string>,
): ReadonlyArray<CatalogModel> {
  const known = KNOWN_MODELS[backend];
  const extra = customModels
    .filter((id) => id.trim() !== "" && !known.some((candidate) => candidate.id === id))
    .map((id) => ({ id, label: id, contextWindow: contextWindowFor(backend, id) ?? 0 }));
  return [...known, ...extra];
}
