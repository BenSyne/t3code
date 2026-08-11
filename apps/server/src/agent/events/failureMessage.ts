/**
 * Turning a failed turn into a sentence the user can act on.
 *
 * What arrives here is an Effect `Cause`, and stringifying it produces the
 * whole internal picture: the `Cause([Fail(...)])` wrapper, the client method
 * that threw, the URL, the raw JSON body, and a stack trace through
 * `node_modules`. Shown as-is — which is what we did — a mistyped model name
 * reads like a crash in T3 Code.
 *
 * Almost every provider already writes a good explanation and buries it in
 * that noise, in a JSON `message` field. So the job is mostly excavation:
 * find their sentence, drop ours.
 *
 * The one case worth adding to rather than merely unwrapping is running out of
 * context. Providers state it in tokens, which is honest but not actionable —
 * the user's next question is always "so what do I do", and the answer depends
 * on whether the conversation grew too long or the model was never big enough
 * to hold the agent in the first place. Those need different advice, and we
 * have the numbers to tell them apart.
 *
 * @module agent/events/failureMessage
 */

/** Anything past this is a wall of text in a toast, not information. */
const MAX_LENGTH = 400;

const FALLBACK = "The agent turn failed.";

/**
 * The provider's own explanation, dug out of the error body.
 *
 * Matched loosely on purpose: bodies differ between providers and versions,
 * and a `message` field is the one convention they all keep.
 */
function providerMessage(text: string): string | null {
  const match = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
  if (match?.[1] === undefined) {
    return null;
  }
  try {
    const decoded = JSON.parse(`"${match[1]}"`) as string;
    return decoded.trim() === "" ? null : decoded.trim();
  } catch {
    return null;
  }
}

/** HTTP status, when the transport bothered to say. */
function httpStatus(text: string): number | null {
  const match = /HTTP (\d{3})/.exec(text);
  return match?.[1] === undefined ? null : Number(match[1]);
}

interface ContextOverflow {
  readonly needed: number;
  readonly limit: number;
}

/**
 * The two numbers from a context-length rejection.
 *
 * Only trusted together: half of this pair tells the user nothing they can use.
 */
function contextOverflow(text: string): ContextOverflow | null {
  if (!text.includes("context_length_exceeded") && !/reduce the length/i.test(text)) {
    return null;
  }
  const match = /length is (\d+) while limit is (\d+)/i.exec(text);
  if (match?.[1] === undefined || match[2] === undefined) {
    return null;
  }
  return { needed: Number(match[1]), limit: Number(match[2]) };
}

const formatTokens = (value: number) => value.toLocaleString("en-US");

/**
 * Explain running out of room, and say which kind of stuck this is.
 *
 * `conversationTokens` is what the conversation had grown to before this turn.
 * When the overflow is bigger than that, the fixed part — the agent's own
 * instructions and tool definitions — is already too big for this model, and
 * no amount of trimming the conversation will help. Telling someone to "start
 * a new thread" in that situation sends them round a loop that cannot end.
 */
function describeContextOverflow(
  overflow: ContextOverflow,
  conversationTokens: number | null,
): string {
  const { needed, limit } = overflow;
  const overBy = needed - limit;
  const headline = `This model allows ${formatTokens(limit)} tokens of context, and the request needed ${formatTokens(needed)}.`;

  // Nothing the user removes from the conversation can close a gap this big:
  // what does not fit is the part that is there on every turn.
  const conversationCannotBeTheCause =
    conversationTokens !== null && conversationTokens > 0 && conversationTokens < overBy;
  if (conversationCannotBeTheCause || conversationTokens === 0) {
    return `${headline} That is before your conversation is counted, so this model is too small to run the agent — its instructions and tools do not fit. Pick a model with a larger context window.`;
  }

  return `${headline} Start a new thread, or switch to a model with a larger context window.`;
}

/**
 * One sentence describing why the turn failed.
 *
 * `conversationTokens` lets the context-overflow case tell the user which kind
 * of problem they have. Omit it and the advice stays correct, just vaguer.
 */
export function describeTurnFailure(cause: unknown, conversationTokens?: number | null): string {
  const raw = cause instanceof Error ? cause.message : String(cause);
  // Everything from the first stack frame on is ours, not theirs.
  const text = raw.split("\n    at ")[0] ?? raw;
  if (text.trim() === "") {
    return FALLBACK;
  }

  const overflow = contextOverflow(text);
  if (overflow !== null) {
    return describeContextOverflow(overflow, conversationTokens ?? null);
  }

  const message = providerMessage(text);
  if (message !== null) {
    const status = httpStatus(text);
    // 401/403 are the one class where the provider's wording ("invalid API
    // key") is accurate but leaves out the part only we know: which instance
    // and which variable they need to go fix.
    const prefix = status === 401 || status === 403 ? "The provider rejected the API key. " : "";
    return truncate(`${prefix}${message}`);
  }

  return truncate(stripCauseWrapper(text));
}

/**
 * Unwrap `Cause([Fail(...)])` down to the message inside.
 *
 * Only cosmetic, and only reached when a provider gave us nothing better —
 * but it is the difference between a sentence and a data structure.
 */
function stripCauseWrapper(text: string): string {
  const unwrapped = /^Cause\(\[?(?:Fail|Die)\((.*?)\)\]?\)$/s.exec(text.trim());
  const inner = unwrapped?.[1] ?? text;
  // Effect error classes carry a module path in front of the real sentence.
  return inner.replace(/^[\w/.@-]+Error:\s*/, "").trim() || FALLBACK;
}

function truncate(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") {
    return FALLBACK;
  }
  return trimmed.length <= MAX_LENGTH ? trimmed : `${trimmed.slice(0, MAX_LENGTH - 1).trimEnd()}…`;
}
