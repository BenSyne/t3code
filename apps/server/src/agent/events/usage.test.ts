import { describe, expect, it } from "vite-plus/test";

import { EMPTY_USAGE, foldUsage, toPricingTotals, toUsageSnapshot } from "./usage.ts";

const request = (input: number, output: number, cacheRead = 0) => ({
  inputTokens: { total: input, cacheRead },
  outputTokens: { total: output },
});

describe("toPricingTotals", () => {
  it("separates cached input from uncached, because they bill differently", () => {
    // Counting the cached tokens at the full input rate would inflate the
    // figure the user is shown for a conversation that reuses its prefix.
    expect(toPricingTotals(request(1000, 50, 800))).toMatchObject({
      uncachedInputTokens: 200,
      cachedInputTokens: 800,
      outputTokens: 50,
    });
  });

  it("never lets a cache figure exceed the total it is part of", () => {
    const totals = toPricingTotals(request(100, 10, 999));
    expect(totals.uncachedInputTokens).toBe(0);
    expect(totals.cachedInputTokens).toBe(100);
  });

  it("treats missing fields as zero rather than dropping the request", () => {
    expect(toPricingTotals({ inputTokens: {}, outputTokens: {} })).toMatchObject({
      uncachedInputTokens: 0,
      outputTokens: 0,
    });
  });
});

describe("cost accumulation", () => {
  it("adds each request's cost to the running total and keeps the last one", () => {
    let usage = foldUsage(EMPTY_USAGE, request(100, 10), 0, {
      costUsd: 0.002,
      costSource: "modelPriced",
    });
    usage = foldUsage(usage, request(200, 20), 0, {
      costUsd: 0.003,
      costSource: "modelPriced",
    });

    expect(usage.costUsd).toBeCloseTo(0.005, 6);
    expect(usage.lastCostUsd).toBeCloseTo(0.003, 6);
  });

  it("stays unpriced once any leg could not be priced", () => {
    // A running total that silently omits a leg reads as authoritative when it
    // is a floor. Better to say the figure is incomplete.
    let usage = foldUsage(EMPTY_USAGE, request(100, 10), 0, {
      costUsd: 0,
      costSource: "unpriced",
    });
    usage = foldUsage(usage, request(100, 10), 0, {
      costUsd: 0.01,
      costSource: "modelPriced",
    });

    expect(usage.costSource).toBe("unpriced");
  });

  it("prefers a provider-reported figure over a computed one", () => {
    const usage = foldUsage(EMPTY_USAGE, request(100, 10), 0, {
      costUsd: 0.0042,
      costSource: "providerReported",
    });

    expect(usage.costSource).toBe("providerReported");
    expect(usage.costUsd).toBeCloseTo(0.0042, 6);
  });

  it("defaults to unpriced when nothing prices the step", () => {
    const usage = foldUsage(EMPTY_USAGE, request(100, 10), 0);
    expect(usage.costSource).toBe("unpriced");
    expect(usage.costUsd).toBe(0);
  });

  it("carries the cost onto the wire snapshot", () => {
    const usage = foldUsage(EMPTY_USAGE, request(100, 10), 0, {
      costUsd: 0.25,
      costSource: "modelPriced",
    });
    const snapshot = toUsageSnapshot(usage, 200_000);

    expect(snapshot.totalCostUsd).toBeCloseTo(0.25, 6);
    expect(snapshot.lastCostUsd).toBeCloseTo(0.25, 6);
    expect(snapshot.costSource).toBe("modelPriced");
  });
});
