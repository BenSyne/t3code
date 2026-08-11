/**
 * Why a backend's own rates beat the shared table.
 *
 * The table is keyed by bare model name, which is right for transcripts — a
 * Claude transcript records `claude-opus-5` and nothing else — and wrong for an
 * aggregator, where the same name is served by several vendors at different
 * prices. These tests pin the failure that motivates `priceUsageAtRate`.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  lookupRate,
  parseRateTable,
  priceUsage,
  priceUsageAtRate,
  type ModelRate,
} from "./usagePricing.ts";

const totals = {
  uncachedInputTokens: 1_000,
  cachedInputTokens: 500,
  cacheCreationTokens: 0,
  outputTokens: 200,
  reasoningTokens: 0,
};

const rate: ModelRate = {
  inputCostPerToken: 0.000002,
  outputCostPerToken: 0.00001,
  cacheReadCostPerToken: 0.0000002,
  cacheCreationCostPerToken: 0.0000025,
};

describe("pricing at a resolved rate", () => {
  it("charges cached input at the cache rate and output at the output rate", () => {
    // 1000 * 2e-6 + 500 * 2e-7 + 200 * 1e-5
    const priced = priceUsageAtRate(rate, totals, null);
    expect(priced.costUsd).toBeCloseTo(0.0041, 10);
    expect(priced.costSource).toBe("modelPriced");
  });

  it("reports no rate as unpriced rather than as free", () => {
    expect(priceUsageAtRate(null, totals, null)).toEqual({ costUsd: 0, costSource: "unpriced" });
  });

  it("lets a figure the provider reported win over any rate", () => {
    expect(priceUsageAtRate(rate, totals, 0.5)).toEqual({
      costUsd: 0.5,
      costSource: "providerReported",
    });
  });
});

describe("the shared table on an aggregator's ids", () => {
  // LiteLLM lists this model only under Fireworks' serving of it. The table
  // strips everything before the last slash, so an OpenRouter id lands on the
  // same key.
  const table = parseRateTable({
    "fireworks_ai/accounts/fireworks/models/kimi-k2-thinking": {
      input_cost_per_token: 0.0000006,
      output_cost_per_token: 0.0000025,
    },
  });

  it("matches another vendor's serving of the same model", () => {
    // Not an assertion that this is desirable — it is the bug. Pricing an
    // OpenRouter turn through the table bills Moonshot tokens at whichever
    // reseller LiteLLM happened to list, and the number looks authoritative.
    expect(lookupRate(table, "moonshotai/kimi-k2-thinking")).not.toBeNull();
    expect(priceUsage(table, "moonshotai/kimi-k2-thinking", totals, null).costSource).toBe(
      "modelPriced",
    );
  });

  it("is bypassed entirely when the backend publishes its own rate", () => {
    // The feed's rate is used verbatim, so the reseller's number never gets a
    // say — which is the whole point of resolving the rate before pricing.
    expect(priceUsageAtRate(rate, totals, null).costUsd).toBeCloseTo(0.0041, 10);
  });
});
