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

/** The id every provider uses for the reasoning control in its option descriptors. */
export const REASONING_EFFORT_OPTION_ID = "reasoningEffort";

/**
 * Which efforts a specific model will accept.
 *
 * Read from the model's own option descriptors — the same list the picker
 * renders — rather than assumed from the provider, because a lineup routinely
 * mixes models that take the full range with models that take none. An empty
 * result means the model exposes no reasoning control at all, which is
 * different from "we do not know" and should be reported as such: sending an
 * effort to one of those does nothing, quietly.
 *
 * The "default" choice is filtered out. It is a picker affordance meaning
 * "send nothing", not a level anyone can ask for.
 */
export function reasoningEffortsFor(
  capabilities: { readonly optionDescriptors?: ReadonlyArray<unknown> | undefined } | null,
): ReadonlyArray<ReasoningEffort> {
  const descriptor = capabilities?.optionDescriptors?.find(
    (candidate): candidate is { readonly id: string; readonly type: string } =>
      typeof candidate === "object" &&
      candidate !== null &&
      (candidate as { id?: unknown }).id === REASONING_EFFORT_OPTION_ID,
  );
  if (descriptor === undefined || descriptor.type !== "select") {
    return [];
  }
  const options = (descriptor as { readonly options?: ReadonlyArray<unknown> }).options ?? [];
  return options.flatMap((option) => {
    const id = (option as { id?: unknown }).id;
    const effort = typeof id === "string" ? asReasoningEffort(id) : undefined;
    return effort === undefined ? [] : [effort];
  });
}

/**
 * The closest level a model will actually accept.
 *
 * The scale is ordered, so a request the target does not offer still says which
 * direction was wanted: "minimal" on a lineup starting at "low" means the least
 * available, not nothing. Refusing outright — which is what this replaces —
 * costs a whole round trip to learn something the ordering already implies.
 *
 * Ties go to the more thorough level. Spending slightly more than asked is a
 * worse answer arriving; spending less risks the task not being done properly,
 * which is what the caller was trying to avoid by naming an effort at all.
 */
export function nearestAcceptedEffort(
  requested: ReasoningEffort,
  accepted: ReadonlyArray<ReasoningEffort>,
): ReasoningEffort | undefined {
  if (accepted.length === 0) {
    return undefined;
  }
  if (accepted.includes(requested)) {
    return requested;
  }
  const target = REASONING_EFFORTS.indexOf(requested);
  return accepted.reduce((best, candidate) => {
    const bestGap = Math.abs(REASONING_EFFORTS.indexOf(best) - target);
    const candidateGap = Math.abs(REASONING_EFFORTS.indexOf(candidate) - target);
    if (candidateGap !== bestGap) {
      return candidateGap < bestGap ? candidate : best;
    }
    return REASONING_EFFORTS.indexOf(candidate) > REASONING_EFFORTS.indexOf(best)
      ? candidate
      : best;
  });
}
