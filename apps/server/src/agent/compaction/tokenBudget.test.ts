import { describe, expect, it } from "vite-plus/test";

import { contextBudget, estimateTokens, shouldCompact, splitForCompaction } from "./tokenBudget.ts";

describe("contextBudget", () => {
  it("holds tokens back for the reply", () => {
    // The window covers input and output together; filling it with history
    // leaves no room to answer and the request fails outright.
    expect(contextBudget(200_000).usable).toBe(180_000);
  });

  it("reports nothing usable when the window is unknown", () => {
    expect(contextBudget(null)).toEqual({ usable: 0, preserve: 0 });
    expect(contextBudget(0)).toEqual({ usable: 0, preserve: 0 });
  });

  it("never lets the reserve push the budget below zero", () => {
    expect(contextBudget(8_000).usable).toBe(0);
  });

  it("clamps how much recent conversation is preserved", () => {
    // A quarter of a large window would be far more than is useful.
    expect(contextBudget(1_048_576).preserve).toBe(8_000);
    // A small window still keeps a usable amount.
    expect(contextBudget(32_000).preserve).toBe(3_000);
    expect(contextBudget(24_000).preserve).toBe(2_000);
  });
});

describe("shouldCompact", () => {
  it("waits until the conversation actually exceeds the budget", () => {
    expect(shouldCompact({ usedTokens: 179_999, contextWindow: 200_000 })).toBe(false);
    expect(shouldCompact({ usedTokens: 180_000, contextWindow: 200_000 })).toBe(true);
  });

  it("never compacts on a guess", () => {
    // Throwing away real conversation because we do not know the window would
    // be worse than letting the request fail and say so.
    expect(shouldCompact({ usedTokens: 5_000_000, contextWindow: null })).toBe(false);
  });
});

describe("estimateTokens", () => {
  it("approximates four characters per token", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });
});

describe("splitForCompaction", () => {
  const message = (role: string, size: number) => ({ role, size });
  const sizeOf = (entry: { size: number }) => entry.size;

  it("keeps the system message out of the summary", () => {
    // It is instructions, not history. Summarising it changes how the agent
    // behaves for the rest of the session.
    const split = splitForCompaction({
      messages: [message("system", 100), message("user", 100), message("assistant", 100)],
      preserveTokens: 50,
      sizeOf,
    });

    expect(split.system).toHaveLength(1);
    expect(split.summarise.every((entry) => entry.role !== "system")).toBe(true);
  });

  it("keeps the most recent messages within the preserve budget", () => {
    const split = splitForCompaction({
      messages: [
        message("user", 100),
        message("assistant", 100),
        message("user", 30),
        message("assistant", 30),
      ],
      preserveTokens: 70,
      sizeOf,
    });

    expect(split.keep).toHaveLength(2);
    expect(split.summarise).toHaveLength(2);
  });

  it("never starts the kept portion on an orphaned tool result", () => {
    // A tool result whose call was summarised away is a malformed history and
    // the provider rejects the next request outright.
    const split = splitForCompaction({
      messages: [
        message("user", 100),
        message("assistant", 100),
        message("tool", 10),
        message("tool", 10),
      ],
      preserveTokens: 25,
      sizeOf,
    });

    expect(split.keep[0]?.role).not.toBe("tool");
  });

  it("summarises nothing when everything fits", () => {
    const split = splitForCompaction({
      messages: [message("user", 10), message("assistant", 10)],
      preserveTokens: 1_000,
      sizeOf,
    });

    expect(split.summarise).toEqual([]);
    expect(split.keep).toHaveLength(2);
  });
});
