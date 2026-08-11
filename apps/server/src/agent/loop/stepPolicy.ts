/**
 * When a turn keeps going, and when it stops.
 *
 * A turn is a loop: ask the model, run whatever tools it asked for, ask again
 * with the results, repeat. Something has to decide when that loop ends, and
 * that decision is the difference between an agent that finishes a task and one
 * that burns a credit card overnight.
 *
 * The rule lives here, on its own, as arithmetic over a tally — no model, no
 * network, no clock. Every stop condition is therefore testable directly, which
 * matters more for this file than for any other in the loop: the failure mode it
 * guards against is one you cannot reproduce on demand.
 *
 * @module agent/loop/stepPolicy
 */

/** Why a turn stopped. Carried through to `turn.completed` so the UI can say so. */
export type StepStopReason =
  /** The model answered without asking for another tool. The normal ending. */
  | "completed"
  /** The model kept asking for tools past `maxSteps`. */
  | "step_limit"
  /** The model asked for more tool calls than `maxToolCalls` across the turn. */
  | "tool_call_limit"
  /** Someone asked the turn to stop while it was running. */
  | "interrupted";

export interface StepLimits {
  /** Model round-trips allowed in one turn. One step = one request. */
  readonly maxSteps: number;
  /** Tool calls allowed across the whole turn, summed over every step. */
  readonly maxToolCalls: number;
}

/**
 * Defaults chosen to let a real coding task finish while still bounding a
 * runaway. Twenty-five steps is roughly the deepest useful chain we have seen
 * for "read some files, edit one, run the tests"; a turn that wants more than
 * that is usually looping, not working.
 */
export const DEFAULT_STEP_LIMITS: StepLimits = {
  maxSteps: 25,
  maxToolCalls: 100,
};

export interface StepTally {
  /** Steps already completed, including the one just finished. */
  readonly steps: number;
  /** Tool calls requested so far across the whole turn. */
  readonly toolCalls: number;
}

export const EMPTY_TALLY: StepTally = { steps: 0, toolCalls: 0 };

export type StepDecision =
  | { readonly _tag: "Continue" }
  | { readonly _tag: "Stop"; readonly reason: StepStopReason };

const CONTINUE: StepDecision = { _tag: "Continue" };

const stop = (reason: StepStopReason): StepDecision => ({ _tag: "Stop", reason });

/** Fold one step's outcome into the running tally. */
export function recordStep(tally: StepTally, toolCallsThisStep: number): StepTally {
  return {
    steps: tally.steps + 1,
    toolCalls: tally.toolCalls + Math.max(0, toolCallsThisStep),
  };
}

/**
 * Decide what happens after a step.
 *
 * Order matters and is deliberate. Interruption wins over everything, because a
 * user who asked to stop should not be told the turn hit a limit. A step that
 * requested no tools is a finished answer, so it beats the limits too — hitting
 * `maxSteps` exactly on the final step is a success, not a truncation. Only then
 * do the budgets apply.
 */
export function decideNextStep(input: {
  readonly tally: StepTally;
  readonly limits: StepLimits;
  /** Did the step that just finished ask for at least one tool call? */
  readonly requestedTools: boolean;
  readonly interrupted: boolean;
}): StepDecision {
  if (input.interrupted) {
    return stop("interrupted");
  }
  if (!input.requestedTools) {
    return stop("completed");
  }
  if (input.tally.steps >= input.limits.maxSteps) {
    return stop("step_limit");
  }
  if (input.tally.toolCalls >= input.limits.maxToolCalls) {
    return stop("tool_call_limit");
  }
  return CONTINUE;
}

/**
 * Human-readable explanation of a stop, for the note appended to a turn that
 * ended early. `completed` has no note — nothing went wrong, so saying anything
 * would be noise.
 */
export function describeStop(reason: StepStopReason, limits: StepLimits): string | null {
  switch (reason) {
    case "completed":
      return null;
    case "interrupted":
      return "Stopped at your request.";
    case "step_limit":
      return `Stopped after ${limits.maxSteps} steps without finishing. Send another message to continue.`;
    case "tool_call_limit":
      return `Stopped after ${limits.maxToolCalls} tool calls without finishing. Send another message to continue.`;
  }
}
