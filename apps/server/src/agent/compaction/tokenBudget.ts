/**
 * When the conversation is too long, and how much of it to keep.
 *
 * Pure arithmetic, separated from the summarising because these are the numbers
 * that decide whether the agent forgets something it needed. They are worth
 * being able to test directly and change deliberately.
 *
 * ## Where the numbers come from
 *
 * The shape of this calculation follows OpenCode's, which is MIT-licensed and
 * has the advantage of having been run against real conversations for a long
 * time. Guessing here produces two bad outcomes that are hard to notice: compact
 * too late and requests start failing outright, compact too eagerly and the
 * agent keeps losing context it was about to use.
 *
 * The reserve exists because the context limit covers input *and* output. Filling
 * the window with history leaves no room for the reply, and the request fails
 * with an error that reads like a provider problem.
 *
 * @module agent/compaction/tokenBudget
 */

/** Held back for the model's reply. */
const OUTPUT_RESERVE_TOKENS = 20_000;
/** Never keep less than this much recent conversation, whatever the window. */
const MIN_PRESERVED_TOKENS = 2_000;
/** Never keep more than this, or a long tail defeats the point of compacting. */
const MAX_PRESERVED_TOKENS = 8_000;
/** The fraction of the usable window kept verbatim as the recent tail. */
const PRESERVE_FRACTION = 0.25;

export interface ContextBudget {
  /** Tokens available for history, once the reply's share is set aside. */
  readonly usable: number;
  /** Tokens of recent conversation to keep verbatim when compacting. */
  readonly preserve: number;
}

/**
 * Work out the budget for a model.
 *
 * A context window of zero or null means we do not know it. Then the budget is
 * zero and {@link shouldCompact} always says no: compacting on a guess would
 * throw away real conversation for no reason we can justify.
 */
export function contextBudget(contextWindow: number | null): ContextBudget {
  if (contextWindow === null || contextWindow <= 0) {
    return { usable: 0, preserve: 0 };
  }

  const usable = Math.max(0, contextWindow - OUTPUT_RESERVE_TOKENS);
  const preserve = Math.min(
    MAX_PRESERVED_TOKENS,
    Math.max(MIN_PRESERVED_TOKENS, Math.floor(usable * PRESERVE_FRACTION)),
  );

  return { usable, preserve };
}

/** Is the conversation over budget? False whenever the window is unknown. */
export function shouldCompact(input: {
  readonly usedTokens: number;
  readonly contextWindow: number | null;
}): boolean {
  const budget = contextBudget(input.contextWindow);
  return budget.usable > 0 && input.usedTokens >= budget.usable;
}

/**
 * A rough token count for a piece of text.
 *
 * Four characters per token is the usual English approximation. It is wrong for
 * code and wrong for other languages, which is why it is only used to decide
 * *where* to cut the history — the authoritative number always comes from the
 * provider's own usage report.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Split messages into the part to summarise and the part to keep verbatim.
 *
 * Walks backwards from the newest message until the preserve budget is spent.
 * The system message is never summarised — it is instructions, not history, and
 * losing it changes how the agent behaves for the rest of the conversation.
 */
export function splitForCompaction<T extends { readonly role: string }>(input: {
  readonly messages: ReadonlyArray<T>;
  readonly preserveTokens: number;
  readonly sizeOf: (message: T) => number;
}): {
  readonly system: ReadonlyArray<T>;
  readonly summarise: ReadonlyArray<T>;
  readonly keep: ReadonlyArray<T>;
} {
  const system = input.messages.filter((message) => message.role === "system");
  const rest = input.messages.filter((message) => message.role !== "system");

  let spent = 0;
  let cut = rest.length;
  for (let index = rest.length - 1; index >= 0; index -= 1) {
    const message = rest[index];
    if (message === undefined) {
      continue;
    }
    spent += input.sizeOf(message);
    if (spent > input.preserveTokens) {
      break;
    }
    cut = index;
  }

  // A tool result whose call is being summarised would be an orphan the next
  // request rejects, so the cut moves back to include the call.
  while (cut > 0 && rest[cut]?.role === "tool") {
    cut -= 1;
  }

  return { system, summarise: rest.slice(0, cut), keep: rest.slice(cut) };
}
