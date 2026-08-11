/**
 * Reading Anthropic's own catalogue.
 *
 * The mapping is the whole risk. The network half is fail-soft by design and
 * falls back to the static list; the half that can quietly do damage is this
 * one — a wrong context window makes the usage meter lie, and an effort level
 * we cannot actually send makes the picker offer a control that does nothing.
 */
import { describe, expect, it } from "vite-plus/test";

import { effortsOf, selectAnthropicCatalog, type AnthropicApiModel } from "./anthropicCatalog.ts";

const model = (over: Partial<AnthropicApiModel>): AnthropicApiModel => ({
  id: "claude-sonnet-5",
  display_name: "Claude Sonnet 5",
  max_input_tokens: 1_000_000,
  ...over,
});

const withEfforts = (over: Record<string, { supported: boolean }>, supported = true) =>
  model({ capabilities: { effort: { supported, ...over } } });

describe("mapping Anthropic's catalogue", () => {
  it("takes the id, the name and the window the API reports", () => {
    // The window especially: this was written out by hand as a flat 200_000
    // for every model, against models that now serve five times that.
    expect(selectAnthropicCatalog([model({})])[0]).toMatchObject({
      id: "claude-sonnet-5",
      label: "Claude Sonnet 5",
      contextWindow: 1_000_000,
    });
  });

  it("falls back to the id when the API sends no display name", () => {
    const picked = selectAnthropicCatalog([model({ display_name: undefined })]);
    expect(picked[0]?.label).toBe("claude-sonnet-5");
  });

  it("drops a model with no usable context window", () => {
    // The API sends 0 for "not published", and a zero denominator renders the
    // usage meter as 0% forever. Dropping is honest; guessing is not.
    expect(selectAnthropicCatalog([model({ max_input_tokens: 0 })])).toEqual([]);
    expect(selectAnthropicCatalog([model({ max_input_tokens: undefined })])).toEqual([]);
  });

  it("drops an entry with no id rather than inventing one", () => {
    expect(selectAnthropicCatalog([model({ id: "   " })])).toEqual([]);
  });
});

describe("which efforts a model is offered", () => {
  it("lists only the levels the model reports, weakest first", () => {
    expect(
      effortsOf(
        withEfforts({
          low: { supported: true },
          medium: { supported: true },
          high: { supported: false },
        }),
      ),
    ).toEqual(["none", "low", "medium"]);
  });

  it("offers no picker at all for a model that does not reason", () => {
    // Absent, not empty: absent is what the UI reads as "no control here".
    expect(effortsOf(model({}))).toBeUndefined();
    expect(effortsOf(withEfforts({ low: { supported: true } }, false))).toBeUndefined();
    expect(effortsOf(withEfforts({ low: { supported: false } }))).toBeUndefined();
  });

  it("never offers max, which the client cannot send", () => {
    // Anthropic's ladder goes higher than ours can reach: the client layer
    // types the field as low/medium/high, so a "max" the user picked would
    // quietly leave as "high". Not offering it is the honest half.
    const efforts = effortsOf(
      withEfforts({
        low: { supported: true },
        medium: { supported: true },
        high: { supported: true },
        max: { supported: true },
      }),
    );
    expect(efforts).toEqual(["none", "low", "medium", "high"]);
    expect(efforts).not.toContain("max");
  });

  it("always pairs a reasoning model with a way to turn it off", () => {
    expect(effortsOf(withEfforts({ high: { supported: true } }))?.[0]).toBe("none");
  });
});
