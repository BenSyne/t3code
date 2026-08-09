/**
 * The shared vocabulary for how hard a model should think.
 *
 * One scale across all four backends, so the picker means the same thing
 * whichever instance a thread runs on. The scale is OpenRouter's, chosen
 * because it is the widest — every other backend accepts a subset of it, and
 * translating a subset is honest in a way that stretching a narrow scale to a
 * wide one is not. It is also, not by coincidence, the vocabulary T3 Code
 * already uses for Codex, so the labels match what users see elsewhere.
 *
 * What each level *does* is the backend's business: the translation to wire
 * shapes lives in `resolveLanguageModel`, and which levels a given model
 * supports lives in `ModelCatalog`. This module only says what the words are.
 *
 * @module agent/model/reasoning
 */

/** Every effort the control can express, weakest first. */
export const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** Labels matching the ones Codex already shows, so the app speaks one language. */
export const REASONING_EFFORT_LABELS: Record<ReasoningEffort, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

/**
 * The picker choice meaning "send nothing, let the provider decide".
 *
 * A visible option rather than an absent selection, because the backends
 * disagree about what silence means — Anthropic does not think unless asked,
 * OpenAI's reasoning models think anyway — and a labelled "Default" is honest
 * about being a delegation where a silent one would look like "off".
 */
export const REASONING_DEFAULT_CHOICE = "default";

/**
 * Narrow a stored selection to an effort, or undefined for anything else.
 *
 * Undefined covers three cases that all mean "send nothing": no selection was
 * made, the user chose Default, or the stored value is something this build
 * has never heard of. Treating the unknown value as absent rather than an
 * error matters because selections outlive builds — a thread configured under
 * a future version must not fail to run under this one.
 */
export function asReasoningEffort(value: string | undefined): ReasoningEffort | undefined {
  if (value === undefined || value === REASONING_DEFAULT_CHOICE) {
    return undefined;
  }
  return REASONING_EFFORTS.includes(value as ReasoningEffort)
    ? (value as ReasoningEffort)
    : undefined;
}
