/**
 * Token accounting for a thread.
 *
 * The AI stack reports usage per request. A thread runs many requests, and the
 * UI shows one running total, so somebody has to add them up. That somebody is
 * this file, kept pure and separate because a context-window meter that drifts
 * is worse than no meter — the user makes decisions about compaction based on
 * it.
 *
 * `used` is the *current* context size, not the lifetime sum. Those diverge the
 * moment a turn is compacted, and conflating them is how a progress bar ends up
 * reading 340%.
 *
 * @module agent/events/usage
 */
import type { ThreadTokenUsageSnapshot } from "@t3tools/contracts";

/** One request's usage, in the shape the AI stack reports it. */
export interface RequestUsage {
  readonly inputTokens: {
    readonly total?: number | undefined;
    readonly cacheRead?: number | undefined;
  };
  readonly outputTokens: {
    readonly total?: number | undefined;
    readonly reasoning?: number | undefined;
  };
}

export interface TurnCost {
  readonly costUsd: number;
  readonly costSource: "providerReported" | "modelPriced" | "unpriced";
}

export interface UsageTally {
  /** Lifetime input tokens across every request in the thread. */
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
  /** Context size after the most recent request: its input plus its output. */
  readonly contextTokens: number;
  readonly toolUses: number;
  /** Lifetime cost of the thread, in US dollars. */
  readonly costUsd: number;
  /** What the most recent request cost, so one exchange has a visible price. */
  readonly lastCostUsd: number;
  /**
   * How the figure was reached.
   *
   * Sticky at `unpriced` once anything in the thread could not be priced: a
   * running total that silently omits a leg is worse than one that admits it
   * is incomplete.
   */
  readonly costSource: TurnCost["costSource"];
}

export const EMPTY_USAGE: UsageTally = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  contextTokens: 0,
  toolUses: 0,
  costUsd: 0,
  lastCostUsd: 0,
  costSource: "modelPriced",
};

/**
 * Fold one request's usage into the running tally.
 *
 * Missing fields count as zero rather than making the whole snapshot absent:
 * providers vary in what they report, and a meter that disappears whenever a
 * provider omits `cacheRead` is less useful than one that is slightly low.
 */
export function foldUsage(
  tally: UsageTally,
  usage: RequestUsage,
  toolCallsThisStep: number,
  cost: TurnCost = { costUsd: 0, costSource: "unpriced" },
): UsageTally {
  const input = nonNegative(usage.inputTokens.total);
  const output = nonNegative(usage.outputTokens.total);

  return {
    inputTokens: tally.inputTokens + input,
    cachedInputTokens: tally.cachedInputTokens + nonNegative(usage.inputTokens.cacheRead),
    outputTokens: tally.outputTokens + output,
    reasoningOutputTokens: tally.reasoningOutputTokens + nonNegative(usage.outputTokens.reasoning),
    contextTokens: input + output,
    toolUses: tally.toolUses + Math.max(0, toolCallsThisStep),
    costUsd: tally.costUsd + Math.max(0, cost.costUsd),
    lastCostUsd: Math.max(0, cost.costUsd),
    // Once anything is unpriced the total is a floor, not a figure.
    costSource: tally.costSource === "unpriced" ? "unpriced" : cost.costSource,
  };
}

/**
 * Token counts in the shape the pricing table expects.
 *
 * `uncachedInputTokens` excludes the cached portion, because the two are
 * charged at different rates and double-counting the cache inflates the bill
 * the user is shown.
 */
export function toPricingTotals(usage: RequestUsage): {
  readonly uncachedInputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
} {
  const total = nonNegative(usage.inputTokens.total);
  const cached = Math.min(total, nonNegative(usage.inputTokens.cacheRead));
  return {
    uncachedInputTokens: total - cached,
    cachedInputTokens: cached,
    cacheCreationTokens: 0,
    outputTokens: nonNegative(usage.outputTokens.total),
    reasoningTokens: nonNegative(usage.outputTokens.reasoning),
  };
}

/**
 * Render the tally as the wire snapshot.
 *
 * `maxTokens` comes from the model's known context window when we have one.
 * Omitted rather than guessed: a wrong denominator makes the meter actively
 * misleading, which is worse than showing a raw count.
 */
export function toUsageSnapshot(
  tally: UsageTally,
  contextWindow: number | null,
): ThreadTokenUsageSnapshot {
  return {
    usedTokens: tally.contextTokens,
    totalProcessedTokens: tally.inputTokens + tally.outputTokens,
    ...(contextWindow !== null && contextWindow > 0 ? { maxTokens: contextWindow } : {}),
    inputTokens: tally.inputTokens,
    cachedInputTokens: tally.cachedInputTokens,
    outputTokens: tally.outputTokens,
    reasoningOutputTokens: tally.reasoningOutputTokens,
    toolUses: tally.toolUses,
    totalCostUsd: tally.costUsd,
    lastCostUsd: tally.lastCostUsd,
    costSource: tally.costSource,
  };
}

function nonNegative(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
