import { describe, expect, it } from "vite-plus/test";

import { selectCatalog, type OpenRouterApiModel } from "./openRouterCatalog.ts";

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
    const picked = selectCatalog([
      model({ id: "z-ai/glm-5.2", name: "Z.AI: GLM 5.2", context_length: 202_752 }),
    ]);

    expect(picked[0]).toMatchObject({
      id: "z-ai/glm-5.2",
      label: "GLM 5.2",
      vendor: "Z.AI",
      contextWindow: 202_752,
    });
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
    const flood = Array.from({ length: 400 }, (_, index) =>
      model({ id: `vendor/model-${index}`, created: daysAgo(index) }),
    );

    expect(selectCatalog(flood).length).toBeLessThanOrEqual(150);
  });
});
