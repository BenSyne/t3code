import { describe, expect, it } from "vite-plus/test";

import { pendingUserInputOf, type RequestActivity } from "./pendingRequests.ts";

const at = (step: number): string => `2026-08-09T12:${String(step).padStart(2, "0")}:00.000Z`;

const requested = (requestId: string, step: number, questions?: unknown): RequestActivity => ({
  kind: "user-input.requested",
  createdAt: at(step),
  payload: {
    requestId,
    questions: questions ?? [
      {
        id: "which-file",
        question: "Which file did you mean?",
        options: [{ label: "parser.ts" }, { label: "lexer.ts" }],
      },
    ],
  },
});

const resolved = (requestId: string, step: number): RequestActivity => ({
  kind: "user-input.resolved",
  createdAt: at(step),
  payload: { requestId },
});

describe("finding the questions a thread is still waiting on", () => {
  it("reports a request that was never answered", () => {
    const pending = pendingUserInputOf([requested("req-1", 1)]);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.requestId).toBe("req-1");
    expect(pending[0]?.questions[0]).toMatchObject({
      id: "which-file",
      question: "Which file did you mean?",
      options: ["parser.ts", "lexer.ts"],
      multiSelect: false,
    });
  });

  it("drops one that was answered", () => {
    expect(pendingUserInputOf([requested("req-1", 1), resolved("req-1", 2)])).toEqual([]);
  });

  it("drops one whose answer failed, since re-answering only fails again", () => {
    // Matches how the projection's own counter treats it: the provider has
    // moved on and no longer knows the request.
    const pending = pendingUserInputOf([
      requested("req-1", 1),
      {
        kind: "provider.user-input.respond.failed",
        createdAt: at(2),
        payload: { requestId: "req-1" },
      },
    ]);
    expect(pending).toEqual([]);
  });

  it("does not let a later activity resurrect an answered request", () => {
    // The tombstone is the point. Deleting the entry instead would let any
    // subsequent activity carrying the same id reopen a closed question.
    const pending = pendingUserInputOf([
      requested("req-1", 1),
      resolved("req-1", 2),
      { kind: "provider.turn.completed", createdAt: at(3), payload: { requestId: "req-1" } },
    ]);
    expect(pending).toEqual([]);
  });

  it("folds in chronological order regardless of how it was handed the log", () => {
    const pending = pendingUserInputOf([resolved("req-1", 2), requested("req-1", 1)]);
    expect(pending).toEqual([]);
  });

  it("keeps a second question asked after the first was answered", () => {
    const pending = pendingUserInputOf([
      requested("req-1", 1),
      resolved("req-1", 2),
      requested("req-2", 3),
    ]);
    expect(pending.map((entry) => entry.requestId)).toEqual(["req-2"]);
  });

  it("ignores activities that are not part of a request conversation", () => {
    const pending = pendingUserInputOf([
      { kind: "provider.tool.call", createdAt: at(1), payload: { summary: "ran tests" } },
      { kind: "provider.tool.call", createdAt: at(2), payload: null },
    ]);
    expect(pending).toEqual([]);
  });

  it("still reports a malformed question set as pending rather than losing it", () => {
    // The thread is blocked either way. Dropping the request because its
    // payload could not be parsed would hide the block entirely, which is the
    // one outcome worse than reporting it with no detail.
    const pending = pendingUserInputOf([requested("req-1", 1, "not an array")]);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.questions).toEqual([]);
  });

  it("skips individual questions it cannot read, keeping the ones it can", () => {
    const pending = pendingUserInputOf([
      requested("req-1", 1, [{ id: "ok", question: "Which?", options: [] }, { nonsense: true }]),
    ]);
    expect(pending[0]?.questions.map((question) => question.id)).toEqual(["ok"]);
  });

  it("carries multiSelect through, since it changes the shape of a valid answer", () => {
    const pending = pendingUserInputOf([
      requested("req-1", 1, [
        { id: "which", question: "Which?", options: [{ label: "a" }], multiSelect: true },
      ]),
    ]);
    expect(pending[0]?.questions[0]?.multiSelect).toBe(true);
  });
});
