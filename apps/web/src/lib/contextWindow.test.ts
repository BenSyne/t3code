import { describe, expect, it } from "vite-plus/test";
import { EventId, type OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";

import { deriveLatestContextWindowSnapshot, formatContextWindowTokens } from "./contextWindow";

function makeActivity(id: string, kind: string, payload: unknown): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId: TurnId.make("turn-1"),
    createdAt: "2026-03-23T00:00:00.000Z",
  };
}

describe("contextWindow", () => {
  it("derives the latest valid context window snapshot", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 1000,
      }),
      makeActivity("activity-2", "tool.started", {}),
      makeActivity("activity-3", "context-window.updated", {
        usedTokens: 14_000,
        maxTokens: 258_000,
        compactsAutomatically: true,
      }),
    ]);

    expect(snapshot).not.toBeNull();
    expect(snapshot?.usedTokens).toBe(14_000);
    expect(snapshot?.totalProcessedTokens).toBeNull();
    expect(snapshot?.maxTokens).toBe(258_000);
    expect(snapshot?.compactsAutomatically).toBe(true);
  });

  it("ignores malformed payloads", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {}),
    ]);

    expect(snapshot).toBeNull();
  });

  it("keeps valid zero-usage snapshots", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 0,
        maxTokens: 100_000,
      }),
    ]);

    expect(snapshot).toMatchObject({
      usedTokens: 0,
      maxTokens: 100_000,
      remainingTokens: 100_000,
      usedPercentage: 0,
      remainingPercentage: 100,
    });
  });

  it("formats compact token counts", () => {
    expect(formatContextWindowTokens(999)).toBe("999");
    expect(formatContextWindowTokens(1400)).toBe("1.4k");
    expect(formatContextWindowTokens(14_000)).toBe("14k");
    expect(formatContextWindowTokens(258_000)).toBe("258k");
  });

  it("carries the cost figures through to the meter", () => {
    // These travel the whole way from the server and were dropped here, so the
    // meter read undefined and rendered nothing at all — a feature that existed
    // end to end and was invisible.
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 20_000,
        maxTokens: 1_000_000,
        totalCostUsd: 0.9412,
        lastCostUsd: 0.0312,
        costSource: "modelPriced",
      }),
    ]);

    expect(snapshot?.totalCostUsd).toBe(0.9412);
    expect(snapshot?.lastCostUsd).toBe(0.0312);
    expect(snapshot?.costSource).toBe("modelPriced");
  });

  it("reports an unrecognised cost source as absent rather than passing it on", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 20_000,
        totalCostUsd: 1.5,
        costSource: "guessed",
      }),
    ]);

    // The meter keys its whole cost block off the source, so an unknown one
    // hides the figures instead of labelling them wrongly.
    expect(snapshot?.costSource).toBeNull();
    expect(snapshot?.lastCostUsd).toBeNull();
  });

  it("includes total processed tokens when available", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 81_659,
        totalProcessedTokens: 748_126,
        maxTokens: 258_400,
        lastUsedTokens: 81_659,
      }),
    ]);

    expect(snapshot?.usedTokens).toBe(81_659);
    expect(snapshot?.totalProcessedTokens).toBe(748_126);
  });
});
