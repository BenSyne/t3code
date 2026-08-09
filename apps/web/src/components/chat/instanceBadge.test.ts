import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { shouldShowInstanceBadge } from "./instanceBadge.ts";

const entry = (id: string, driver: string, slugs: ReadonlyArray<string>, accentColor?: string) => ({
  instanceId: ProviderInstanceId.make(id),
  driverKind: ProviderDriverKind.make(driver),
  ...(accentColor === undefined ? {} : { accentColor }),
  models: slugs.map((slug) => ({ slug })),
});

describe("shouldShowInstanceBadge", () => {
  it("stays off for the only instance of its driver", () => {
    const codex = entry("codex", "codex", ["gpt-5.6-sol"]);

    expect(
      shouldShowInstanceBadge({
        entries: [codex],
        activeEntry: codex,
        activeModelSlug: "gpt-5.6-sol",
      }),
    ).toBe(false);
  });

  it("shows for two accounts serving the same model — the trigger is genuinely ambiguous", () => {
    const work = entry("codex", "codex", ["gpt-5.6-sol"]);
    const personal = entry("codex_personal", "codex", ["gpt-5.6-sol"]);

    expect(
      shouldShowInstanceBadge({
        entries: [work, personal],
        activeEntry: work,
        activeModelSlug: "gpt-5.6-sol",
      }),
    ).toBe(true);
  });

  it("stays off when the model belongs to exactly one instance", () => {
    // Two T3 Agent instances on different backends. "Kimi K3" can only be the
    // OpenRouter one, so the badge would cover the icon to say nothing.
    const openrouter = entry("t3agent", "t3agent", ["moonshotai/kimi-k3"]);
    const cerebras = entry("t3agent_cerebras", "t3agent", ["zai-glm-4.7"]);

    expect(
      shouldShowInstanceBadge({
        entries: [openrouter, cerebras],
        activeEntry: openrouter,
        activeModelSlug: "moonshotai/kimi-k3",
      }),
    ).toBe(false);
  });

  it("shows again when two instances happen to overlap on one model", () => {
    // Same driver, mostly different catalogues, one model in common. Only that
    // model is ambiguous, and only there does the badge appear.
    const a = entry("t3agent", "t3agent", ["anthropic/claude-sonnet-5", "moonshotai/kimi-k3"]);
    const b = entry("t3agent_other", "t3agent", ["anthropic/claude-sonnet-5"]);

    expect(
      shouldShowInstanceBadge({
        entries: [a, b],
        activeEntry: a,
        activeModelSlug: "anthropic/claude-sonnet-5",
      }),
    ).toBe(true);
    expect(
      shouldShowInstanceBadge({
        entries: [a, b],
        activeEntry: a,
        activeModelSlug: "moonshotai/kimi-k3",
      }),
    ).toBe(false);
  });

  it("always honours an accent colour the user chose", () => {
    const marked = entry("t3agent", "t3agent", ["moonshotai/kimi-k3"], "violet");

    expect(
      shouldShowInstanceBadge({
        entries: [marked],
        activeEntry: marked,
        activeModelSlug: "moonshotai/kimi-k3",
      }),
    ).toBe(true);
  });

  it("falls back to showing when there is no model to compare", () => {
    // A thread still resolving its selection. Something may be ambiguous and
    // we cannot prove otherwise, so keep the old behaviour rather than guess.
    const a = entry("t3agent", "t3agent", ["moonshotai/kimi-k3"]);
    const b = entry("t3agent_cerebras", "t3agent", ["zai-glm-4.7"]);

    expect(
      shouldShowInstanceBadge({ entries: [a, b], activeEntry: a, activeModelSlug: null }),
    ).toBe(true);
  });

  it("shows nothing when no instance is active", () => {
    expect(shouldShowInstanceBadge({ entries: [], activeEntry: null, activeModelSlug: "x" })).toBe(
      false,
    );
  });
});
