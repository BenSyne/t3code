/**
 * Where a thread sits in the inbox, and how to move it.
 *
 * @module agent/conductor/threadLifecycle
 */
import type {
  CommandId,
  DispatchableClientOrchestrationCommand,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";

export const THREAD_STATE_ACTIONS = [
  "settle",
  "unsettle",
  "archive",
  "unarchive",
  "snooze",
  "unsnooze",
  "pin",
  "unpin",
] as const;

export type ThreadStateAction = (typeof THREAD_STATE_ACTIONS)[number];

/** The agent's view of a thread's place in the inbox. */
export type ThreadLifecycle = "active" | "settled" | "snoozed" | "pinned" | "archived";

/** Only the fields the classification reads, so it is not tied to a projection. */
export interface ThreadLifecycleFields {
  readonly archivedAt: string | null;
  readonly settledAt: string | null;
  readonly settledOverride: "settled" | "active" | null;
  readonly snoozedUntil?: string | null | undefined;
  readonly pinnedAt?: string | null | undefined;
}

/** Classify a thread. */
export function lifecycleOf(thread: ThreadLifecycleFields, nowIso: string): ThreadLifecycle {
  if (thread.archivedAt !== null) {
    return "archived";
  }
  if (thread.pinnedAt !== null && thread.pinnedAt !== undefined) {
    return "pinned";
  }
  // A wake time in the past emits no event — clients derive the wake from the
  // timestamp passing — so "snoozed" has to be judged against now, not against
  // whether the field is set.
  if (
    thread.snoozedUntil !== null &&
    thread.snoozedUntil !== undefined &&
    thread.snoozedUntil > nowIso
  ) {
    return "snoozed";
  }
  // An explicit override is the user's own answer and outranks the stamp the
  // server left behind: "active" means they reopened it after it settled.
  if (thread.settledOverride === "settled") {
    return "settled";
  }
  if (thread.settledOverride === "active") {
    return "active";
  }
  return thread.settledAt !== null ? "settled" : "active";
}

/** Order threads so the ones that need someone come first. */
export function orderForAttention<
  T extends {
    readonly awaitingInput: boolean;
    readonly awaitingApproval: boolean;
    readonly updatedAt: string;
  },
>(threads: ReadonlyArray<T>): ReadonlyArray<T> {
  const blocked = (thread: T): boolean => thread.awaitingInput || thread.awaitingApproval;
  return [...threads].sort((left, right) => {
    if (blocked(left) !== blocked(right)) {
      return blocked(left) ? -1 : 1;
    }
    return right.updatedAt.localeCompare(left.updatedAt);
  });
}

export type ThreadStatePlan =
  | { readonly _tag: "Command"; readonly command: DispatchableClientOrchestrationCommand }
  | { readonly _tag: "Refused"; readonly reason: string };

const refuse = (reason: string): ThreadStatePlan => ({ _tag: "Refused", reason });

/** A year out. Past this the agent has misread a unit, not asked for a long snooze. */
const MAX_SNOOZE_HOURS = 24 * 365;

const isAction = (value: string): value is ThreadStateAction =>
  (THREAD_STATE_ACTIONS as ReadonlyArray<string>).includes(value);

/** Turn a requested state change into the command that performs it. */
export function planThreadStateChange(input: {
  readonly action: string;
  readonly threadId: ThreadId;
  readonly commandId: CommandId;
  readonly nowIso: string;
  readonly snoozeHours: number | undefined;
  /** True while a provider session is live on this thread. */
  readonly isRunning: boolean;
}): ThreadStatePlan {
  if (!isAction(input.action)) {
    return refuse(
      `"${input.action}" is not something you can do to a thread. Use one of: ${THREAD_STATE_ACTIONS.join(", ")}.`,
    );
  }
  const action: ThreadStateAction = input.action;

  // Settling and snoozing a busy thread are safe: real activity un-settles and
  // wakes it, so the worst case is that it comes straight back. Archiving has
  // no such recovery — nothing un-archives a thread on activity — so archiving
  // one mid-run hides work that is still spending the user's money.
  if (action === "archive" && input.isRunning) {
    return refuse(
      "That thread is still running. Stop it first, or wait for it to finish — archiving it now would hide work that is still going.",
    );
  }

  const base = { commandId: input.commandId, threadId: input.threadId } as const;

  switch (action) {
    case "settle":
      return { _tag: "Command", command: { type: "thread.settle", ...base } };
    // "user" is the only reason a command may carry. The neutral reset that
    // activity performs is emitted server-side, so a client cannot forge it.
    case "unsettle":
      return { _tag: "Command", command: { type: "thread.unsettle", ...base, reason: "user" } };
    case "archive":
      return { _tag: "Command", command: { type: "thread.archive", ...base } };
    case "unarchive":
      return { _tag: "Command", command: { type: "thread.unarchive", ...base } };
    case "unsnooze":
      return { _tag: "Command", command: { type: "thread.unsnooze", ...base, reason: "user" } };
    case "pin":
      // No order key: the pinned block falls back to creation order without
      // one, and inventing a fractional index here would reorder pins the
      // user arranged by hand.
      return { _tag: "Command", command: { type: "thread.pin", ...base } };
    case "unpin":
      return { _tag: "Command", command: { type: "thread.unpin", ...base } };
    case "snooze": {
      const hours = input.snoozeHours;
      if (hours === undefined) {
        return refuse("Snoozing needs snoozeHours — how long to hide the thread for.");
      }
      if (!Number.isFinite(hours) || hours <= 0) {
        return refuse("snoozeHours must be a positive number of hours.");
      }
      if (hours > MAX_SNOOZE_HOURS) {
        return refuse(`snoozeHours cannot exceed ${MAX_SNOOZE_HOURS} (one year).`);
      }
      // Relative rather than an absolute timestamp: the model would have to
      // know the current time to compute one, and a wake time it got wrong by
      // a day is a thread that silently never comes back.
      const now = DateTime.make(input.nowIso);
      if (Option.isNone(now)) {
        return refuse("Could not work out a wake time from that.");
      }
      const wakesAt = DateTime.addDuration(now.value, Duration.millis(hours * 3_600_000));
      return {
        _tag: "Command",
        command: { type: "thread.snooze", ...base, snoozedUntil: DateTime.formatIso(wakesAt) },
      };
    }
  }
}
