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
import { OPENROUTER_FALLBACK_MODELS } from "./openrouterFallback.ts";
import type { ReasoningEffort } from "./reasoning.ts";
import type { BackendKind } from "./resolveLanguageModel.ts";

export interface CatalogModel {
  /** The id sent on the wire. */
  readonly id: string;
  readonly label: string;
  readonly contextWindow: number;
  /**
   * Who actually built the model, when that is not the backend serving it.
   *
   * Only meaningful for an aggregator: an OpenRouter instance serves Anthropic,
   * OpenAI, Google and half a dozen others, and a list that does not say so is
   * a wall of names with no way to tell a frontier model from a fine-tune. The
   * picker renders it under the model as "<instance> · <vendor>", and uses it
   * to strip a redundant vendor prefix off the label.
   */
  readonly vendor?: string;
  /**
   * The efforts this model honours, weakest first, or absent for a model that
   * does not reason (or that we cannot vouch for). Absent means no picker: the
   * control only offers what we know the API will accept.
   */
  readonly reasoningEfforts?: ReadonlyArray<ReasoningEffort>;
}

/**
 * Effort subsets by backend family, named for why they differ.
 *
 * Anthropic's adaptive thinking has three levels plus off. OpenAI adds
 * `minimal` and `xhigh` at the extremes. OpenRouter translates the common
 * levels for whatever is upstream, so its models share one conservative set.
 */
const ANTHROPIC_EFFORTS: ReadonlyArray<ReasoningEffort> = ["none", "low", "medium", "high"];
const OPENAI_EFFORTS: ReadonlyArray<ReasoningEffort> = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];
/** Exported for the live OpenRouter catalogue, which labels models the same way. */
export const OPENROUTER_EFFORTS: ReadonlyArray<ReasoningEffort> = ["none", "low", "medium", "high"];

/**
 * Known models per backend, best-first.
 *
 * `openrouter` is generated from the live API; the rest are written from each
 * vendor's own documentation, because their catalogues need a key to read and
 * a build cannot assume one. Written-out entries rot — this list once carried
 * five ids that had stopped existing — so treat anything here as a convenience
 * that may be stale, never as proof a model exists. Nothing is gated on it:
 * the picker takes any id typed at it, and an unknown window reports unknown.
 *
 * `openai-compat` is deliberately empty: whatever is behind that address is
 * whatever the user is running, and guessing would be worse than asking.
 */
export const KNOWN_MODELS: Record<BackendKind, ReadonlyArray<CatalogModel>> = {
  anthropic: [
    {
      id: "claude-opus-5",
      label: "Claude Opus 5",
      contextWindow: 200_000,
      reasoningEfforts: ANTHROPIC_EFFORTS,
    },
    {
      id: "claude-sonnet-5",
      label: "Claude Sonnet 5",
      contextWindow: 200_000,
      reasoningEfforts: ANTHROPIC_EFFORTS,
    },
    {
      id: "claude-haiku-4-5",
      label: "Claude Haiku 4.5",
      contextWindow: 200_000,
      reasoningEfforts: ANTHROPIC_EFFORTS,
    },
  ],
  openai: [
    { id: "gpt-5.1", label: "GPT-5.1", contextWindow: 400_000, reasoningEfforts: OPENAI_EFFORTS },
    {
      id: "gpt-5.1-mini",
      label: "GPT-5.1 mini",
      contextWindow: 400_000,
      reasoningEfforts: OPENAI_EFFORTS,
    },
    {
      id: "o4-mini",
      label: "o4-mini",
      contextWindow: 200_000,
      // Always reasons; "none" is not something the API accepts for it.
      reasoningEfforts: ["low", "medium", "high"],
    },
  ],
  // One key, most of the frontier, generated rather than typed.
  //
  // Every entry carries a `vendor`, which is what makes a list this long
  // readable: the row reads "Claude Sonnet 5 / T3 Agent · Anthropic" instead of
  // leaving the user to decode a slug. It is also load-bearing for the label —
  // the picker strips a leading vendor word, so "Anthropic" here is what keeps
  // a future "Anthropic Claude 5.5" from rendering the word twice.
  openrouter: OPENROUTER_FALLBACK_MODELS,
  // Cerebras runs open-weight models on their own silicon, roughly an order of
  // magnitude faster than GPU inference. Two things here are not guesses and
  // should not be "tidied" into the shared defaults:
  //
  // The effort sets come from Cerebras' own per-model table and genuinely
  // disagree with each other.
  //
  // The windows are the documented *free tier* numbers, not the paid ones
  // (131k). Erring low is the safer mistake: too high and compaction never
  // fires, so the first the user hears of it is a rejected request. Even these
  // are optimistic — a trial key was observed enforcing 8,192 on GLM 4.7,
  // eight times below what the docs promise. The limit ultimately belongs to
  // the account, not the model, so nothing written here can be reliable; what
  // makes that survivable is `failureMessage.ts`, which reads the real limit
  // out of the rejection and explains it.
  cerebras: [
    {
      id: "zai-glm-4.7",
      label: "GLM 4.7",
      vendor: "Z.ai",
      contextWindow: 64_000,
      // Reasons by default; `none` is the only thing it lets you say about it.
      reasoningEfforts: ["none"],
    },
    {
      id: "gpt-oss-120b",
      label: "GPT-OSS 120B",
      vendor: "OpenAI",
      contextWindow: 65_000,
      // No `none`: this one always reasons.
      reasoningEfforts: ["low", "medium", "high"],
    },
    {
      id: "gemma-4-31b",
      label: "Gemma 4 31B",
      vendor: "Google",
      contextWindow: 65_000,
      reasoningEfforts: ["none", "low", "medium", "high"],
    },
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
