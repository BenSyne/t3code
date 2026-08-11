/**
 * The shared vocabulary for how hard a model should think.
 *
 * OpenRouter's scale, because it is the widest — every other backend accepts a
 * subset, and translating a subset down is honest where stretching a narrow
 * scale up is not. It is also what T3 Code already shows for Codex.
 *
 * Translation to wire shapes lives in `resolveLanguageModel`; which levels a
 * model supports lives in `ModelCatalog`. This only names the words.
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
 * Visible rather than absent because backends disagree about what silence
 * means: Anthropic does not think unless asked, OpenAI's reasoning models think
 * anyway. A silent default would read as "off".
 */
export const REASONING_DEFAULT_CHOICE = "default";

/**
 * Narrow a stored selection to an effort, or undefined for anything else.
 *
 * An unrecognised value is absent rather than an error: selections outlive
 * builds, and a thread configured under a future version must still run here.
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
 * Read from the model's own descriptors rather than assumed from the provider,
 * because a lineup mixes models taking the full range with models taking none.
 * Empty means no reasoning control, so sending an effort does nothing quietly.
 * The "default" choice is filtered out — it is a picker affordance, not a level.
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
 * The scale is ordered, so an unavailable request still says which direction
 * was wanted: "minimal" on a lineup starting at "low" means the least
 * available. Ties go to the more thorough level — spending slightly more than
 * asked beats risking the task not being done properly.
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
