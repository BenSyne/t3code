import { describe, expect, it } from "vite-plus/test";

import {
  rateOf,
  selectCatalog,
  selectRates,
  type OpenRouterApiModel,
} from "./openRouterCatalog.ts";

/** Selection compares `created` values to each other, so any fixed epoch does. */
const EPOCH = 1_790_000_000;
/** Days-old helper so "newest" reads as intent instead of unix arithmetic. */
const daysAgo = (days: number): number => EPOCH - days * 86_400;

const model = (overrides: Partial<OpenRouterApiModel> & { id: string }): OpenRouterApiModel => ({
  name: overrides.id,
  created: daysAgo(30),
  context_length: 200_000,
  supported_parameters: ["tools"],
  ...overrides,
});

describe("selecting the OpenRouter catalogue", () => {
  it("refuses models an agent cannot run on", () => {
    const picked = selectCatalog([
      model({ id: "vendor/no-tools", supported_parameters: ["temperature"] }),
      model({ id: "vendor/free-variant:free" }),
      model({ id: "vendor/no-window", context_length: 0 }),
      model({ id: "vendor/fine" }),
    ]);

    expect(picked.map((entry) => entry.id)).toEqual(["vendor/fine"]);
  });

  it("shelves the newest of each family first, in a fixed vendor order", () => {
    const picked = selectCatalog([
      // Listed oldest-first and out of vendor order on purpose: the shelf must
      // come out newest-per-family in SHELF order regardless of input order.
      model({ id: "deepseek/deepseek-v4-flash", created: daysAgo(200) }),
      model({ id: "deepseek/deepseek-v5", created: daysAgo(3) }),
      model({ id: "anthropic/claude-opus-5", created: daysAgo(60) }),
      model({ id: "anthropic/claude-opus-6", created: daysAgo(1) }),
      model({ id: "openai/gpt-5.6", created: daysAgo(5) }),
    ]);

    // Anthropic before OpenAI before DeepSeek, and within Anthropic the newer
    // release leads. This is the rule that keeps the shelf current without
    // anyone editing a list when a vendor ships.
    expect(picked.map((entry) => entry.id)).toEqual([
      "anthropic/claude-opus-6",
      "anthropic/claude-opus-5",
      "openai/gpt-5.6",
      "deepseek/deepseek-v5",
      "deepseek/deepseek-v4-flash",
    ]);
  });

  it("keeps at most three of a family on the shelf; the rest ride below by recency", () => {
    const picked = selectCatalog([
      model({ id: "anthropic/newest", created: daysAgo(1) }),
      model({ id: "anthropic/second", created: daysAgo(2) }),
      model({ id: "anthropic/third", created: daysAgo(3) }),
      model({ id: "anthropic/fourth", created: daysAgo(4) }),
      model({ id: "openai/only", created: daysAgo(9) }),
    ]);

    expect(picked.map((entry) => entry.id)).toEqual([
      "anthropic/newest",
      "anthropic/second",
      "anthropic/third",
      "openai/only",
      // Off the shelf, but still findable.
      "anthropic/fourth",
    ]);
  });

  it("names the vendor even when the API name carries no prefix", () => {
    // Anthropic's rows read "Claude Opus 5" with no "Anthropic:" — the picker
    // still needs to say who makes it.
    const picked = selectCatalog([model({ id: "anthropic/claude-opus-5", name: "Claude Opus 5" })]);
    expect(picked[0]?.vendor).toBe("Anthropic");
  });

  it("splits OpenRouter's 'Vendor: Name' into a label and a vendor", () => {
    // "google" is not one we curate, so the feed's own spelling is used.
    const picked = selectCatalog([
      model({ id: "google/gemini-3.6-flash", name: "Google: Gemini 3.6 Flash" }),
    ]);

    expect(picked[0]).toMatchObject({
      id: "google/gemini-3.6-flash",
      label: "Gemini 3.6 Flash",
      vendor: "Google",
    });
  });

  it("prefers our spelling of a vendor over the feed's", () => {
    // OpenRouter respells vendors from time to time — "Moonshot AI" became
    // "MoonshotAI" — and letting that through silently renames rows in the
    // picker. The label still comes off the feed; only the vendor is ours.
    const picked = selectCatalog([
      model({ id: "z-ai/glm-5.2", name: "Z.AI: GLM 5.2", context_length: 202_752 }),
      model({ id: "moonshotai/kimi-k3", name: "MoonshotAI: Kimi K3" }),
    ]);

    expect(picked.find((entry) => entry.id === "z-ai/glm-5.2")).toMatchObject({
      label: "GLM 5.2",
      vendor: "Z.ai",
      contextWindow: 202_752,
    });
    expect(picked.find((entry) => entry.id === "moonshotai/kimi-k3")?.vendor).toBe("Moonshot AI");
  });

  it("offers the reasoning picker only where the API vouches for reasoning", () => {
    const picked = selectCatalog([
      model({ id: "vendor/thinks", supported_parameters: ["tools", "reasoning"] }),
      model({ id: "vendor/does-not" }),
    ]);

    const bySlug = new Map(picked.map((entry) => [entry.id, entry]));
    expect(bySlug.get("vendor/thinks")?.reasoningEfforts).toBeDefined();
    expect(bySlug.get("vendor/does-not")?.reasoningEfforts).toBeUndefined();
  });

  it("caps the list rather than shipping the whole catalogue", () => {
    // The cap is a websocket payload budget — the snapshot is re-sent on every
    // provider-status refresh — so this asserts the exact number rather than an
    // upper bound. Raising it should be a deliberate act with a payload
    // measurement behind it, not something a passing test waves through.
    const flood = Array.from({ length: 400 }, (_, index) =>
      model({ id: `vendor/model-${index}`, created: daysAgo(index) }),
    );

    expect(selectCatalog(flood)).toHaveLength(60);
  });
});

describe("pricing from the feed", () => {
  const priced = (pricing: Record<string, string>, id = "vendor/model") => model({ id, pricing });

  it("reads the per-token rates the feed publishes", () => {
    expect(
      rateOf(
        priced({
          prompt: "0.000002",
          completion: "0.00001",
          input_cache_read: "0.0000002",
          input_cache_write: "0.0000025",
        }),
      ),
    ).toEqual({
      inputCostPerToken: 0.000002,
      outputCostPerToken: 0.00001,
      cacheReadCostPerToken: 0.0000002,
      cacheCreationCostPerToken: 0.0000025,
    });
  });

  it("prices uncharged cache reads at the full input rate, not at zero", () => {
    // A third of the catalogue quotes no cache rate. Treating that as free
    // understates every conversation that reuses its prefix, which is most of
    // them once caching is on.
    const rate = rateOf(priced({ prompt: "0.000003", completion: "0.000015" }));
    expect(rate?.cacheReadCostPerToken).toBe(0.000003);
    expect(rate?.cacheCreationCostPerToken).toBe(0.000003);
  });

  it("keeps a genuinely free model at zero rather than reading it as missing", () => {
    expect(rateOf(priced({ prompt: "0", completion: "0" }))).toMatchObject({
      inputCostPerToken: 0,
      outputCostPerToken: 0,
    });
  });

  it("reports a model the feed does not price as unpriced", () => {
    expect(rateOf(model({ id: "vendor/model" }))).toBeNull();
    expect(rateOf(priced({ prompt: "0.000002" }))).toBeNull();
    expect(rateOf(priced({ prompt: "not-a-number", completion: "0.00001" }))).toBeNull();
  });

  it("prices every model in the feed, not just the ones the list shows", () => {
    // The list is capped at sixty for payload reasons, but the picker takes a
    // typed slug and `customModels` pins one — so a model that never appears
    // can still be the one being billed. Pricing only the shelf would show
    // "unknown" for exactly those deliberate choices.
    const flood = Array.from({ length: 400 }, (_, index) =>
      priced({ prompt: "0.000001", completion: "0.000002" }, `vendor/model-${index}`),
    );

    expect(selectCatalog(flood)).toHaveLength(60);
    expect(selectRates(flood).size).toBe(400);
  });

  it("keys rates on the id sent on the wire, variants included", () => {
    // `:free` is dropped from the list as an alternate serving, but it bills
    // differently from its base slug and a user can pick it by typing it.
    const rates = selectRates([
      priced({ prompt: "0.000002", completion: "0.00001" }, "vendor/model"),
      priced({ prompt: "0", completion: "0" }, "vendor/model:free"),
    ]);

    expect(rates.get("vendor/model")?.inputCostPerToken).toBe(0.000002);
    expect(rates.get("vendor/model:free")?.inputCostPerToken).toBe(0);
  });
});
