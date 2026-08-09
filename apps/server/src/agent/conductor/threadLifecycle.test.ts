import { CommandId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  lifecycleOf,
  planThreadStateChange,
  THREAD_STATE_ACTIONS,
  type ThreadLifecycleFields,
} from "./threadLifecycle.ts";

const NOW = "2026-08-09T12:00:00.000Z";

const thread = (fields: Partial<ThreadLifecycleFields>): ThreadLifecycleFields => ({
  archivedAt: null,
  settledAt: null,
  settledOverride: null,
  ...fields,
});

describe("classifying a thread", () => {
  it("calls an untouched thread active", () => {
    expect(lifecycleOf(thread({}), NOW)).toBe("active");
  });

  it("reads a settled stamp", () => {
    expect(lifecycleOf(thread({ settledAt: "2026-08-09T11:00:00.000Z" }), NOW)).toBe("settled");
  });

  it("lets an explicit reopen beat the stamp the server left behind", () => {
    // The user reopened it after it settled. Reporting it as settled would
    // have the agent tidy away the one thread they just said they still want.
    expect(
      lifecycleOf(
        thread({ settledAt: "2026-08-09T11:00:00.000Z", settledOverride: "active" }),
        NOW,
      ),
    ).toBe("active");
  });

  it("lets an explicit settle stand without a stamp", () => {
    expect(lifecycleOf(thread({ settledOverride: "settled" }), NOW)).toBe("settled");
  });

  it("treats a snooze that has already elapsed as not snoozed", () => {
    // A passed wake time emits no event, so the field stays set forever. Judging
    // on presence alone would leave threads permanently invisible to the agent.
    expect(lifecycleOf(thread({ snoozedUntil: "2026-08-09T09:00:00.000Z" }), NOW)).toBe("active");
    expect(lifecycleOf(thread({ snoozedUntil: "2026-08-09T18:00:00.000Z" }), NOW)).toBe("snoozed");
  });

  it("puts a pin above settled and snoozed", () => {
    expect(
      lifecycleOf(
        thread({
          pinnedAt: NOW,
          settledAt: "2026-08-09T11:00:00.000Z",
          snoozedUntil: "2026-08-09T18:00:00.000Z",
        }),
        NOW,
      ),
    ).toBe("pinned");
  });

  it("puts archived above everything", () => {
    expect(lifecycleOf(thread({ archivedAt: NOW, pinnedAt: NOW }), NOW)).toBe("archived");
  });
});

const plan = (action: string, extra: { snoozeHours?: number; isRunning?: boolean } = {}) =>
  planThreadStateChange({
    action,
    threadId: ThreadId.make("thread-1"),
    commandId: CommandId.make("command-1"),
    nowIso: NOW,
    snoozeHours: extra.snoozeHours,
    isRunning: extra.isRunning ?? false,
  });

describe("planning a state change", () => {
  it("builds a command for every action it advertises", () => {
    // The tool offers this list to the model. An action that is named but not
    // handled is a refusal the model cannot understand or work around.
    for (const action of THREAD_STATE_ACTIONS) {
      const result = plan(action, { snoozeHours: 2 });
      expect(result._tag, `${action} should be plannable`).toBe("Command");
    }
  });

  it("names the actions it accepts when given one it does not", () => {
    const result = plan("delete");
    expect(result).toMatchObject({ _tag: "Refused" });
    if (result._tag !== "Refused") return;
    expect(result.reason).toContain("settle");
  });

  it("carries reason 'user' on the un- verbs, which the schema requires", () => {
    for (const action of ["unsettle", "unsnooze"] as const) {
      const result = plan(action);
      expect(result).toMatchObject({ _tag: "Command", command: { reason: "user" } });
    }
  });

  it("turns snooze hours into an absolute wake time", () => {
    const result = plan("snooze", { snoozeHours: 3 });
    expect(result).toMatchObject({
      _tag: "Command",
      command: { type: "thread.snooze", snoozedUntil: "2026-08-09T15:00:00.000Z" },
    });
  });

  it("refuses a snooze with no duration rather than picking one", () => {
    const result = plan("snooze");
    expect(result).toMatchObject({ _tag: "Refused" });
    if (result._tag !== "Refused") return;
    expect(result.reason).toContain("snoozeHours");
  });

  it("refuses durations that are not a length of time", () => {
    for (const hours of [0, -4, Number.NaN, Number.POSITIVE_INFINITY, 24 * 366]) {
      expect(plan("snooze", { snoozeHours: hours })._tag, `${hours} should be refused`).toBe(
        "Refused",
      );
    }
  });

  it("refuses to archive a thread that is still running", () => {
    // Nothing un-archives a thread on activity, so archiving a live one hides
    // work that keeps spending the user's money with no way back to it.
    const result = plan("archive", { isRunning: true });
    expect(result).toMatchObject({ _tag: "Refused" });
    if (result._tag !== "Refused") return;
    expect(result.reason).toContain("still running");
  });

  it("still settles and snoozes a running thread", () => {
    // Both recover on their own: real activity un-settles and wakes a thread,
    // so the worst case is that it reappears, which is the correct outcome.
    expect(plan("settle", { isRunning: true })._tag).toBe("Command");
    expect(plan("snooze", { isRunning: true, snoozeHours: 1 })._tag).toBe("Command");
  });
});
