import { T3AgentSettings } from "@t3tools/contracts";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import type { ResolvedCredential } from "../../agent/model/credentials.ts";
import { buildT3AgentSnapshot } from "./T3AgentProvider.ts";

const decodeSettings = Schema.decodeUnknownSync(T3AgentSettings);

const settings = (overrides: Record<string, unknown> = {}): T3AgentSettings =>
  decodeSettings(overrides);

const resolved: ResolvedCredential = {
  _tag: "Resolved",
  key: Redacted.make("sk-test"),
  variableName: "ANTHROPIC_API_KEY",
  source: "instance-environment",
};

const snapshot = (overrides: Record<string, unknown> = {}) =>
  buildT3AgentSnapshot({
    settings: settings(overrides),
    credential: resolved,
    checkedAt: "2026-08-09T10:00:00.000Z",
  });

describe("reasoning picker", () => {
  it("offers the reasoning control on models the catalogue vouches for", () => {
    const sonnet = snapshot().models.find((model) => model.slug === "claude-sonnet-5");
    const descriptors = sonnet?.capabilities?.optionDescriptors ?? [];

    expect(descriptors).toHaveLength(1);
    const descriptor = descriptors[0];
    expect(descriptor?.id).toBe("reasoningEffort");
    expect(descriptor?.type).toBe("select");
  });

  it('puts "Default" first, selected, and honest about meaning "send nothing"', () => {
    const sonnet = snapshot().models.find((model) => model.slug === "claude-sonnet-5");
    const descriptor = sonnet?.capabilities?.optionDescriptors?.[0];
    const first = descriptor?.type === "select" ? descriptor.options[0] : undefined;

    expect(first?.id).toBe("default");
    expect(first?.isDefault).toBe(true);
    expect(first?.description).toContain("Nothing extra is sent");
  });

  it("offers only the levels the backend can honour", () => {
    const sonnet = snapshot().models.find((model) => model.slug === "claude-sonnet-5");
    const descriptor = sonnet?.capabilities?.optionDescriptors?.[0];
    const ids = descriptor?.type === "select" ? descriptor.options.map((o) => o.id) : [];

    // Anthropic's adaptive thinking: off plus three native levels. No xhigh,
    // no max — offering them would promise something the API rejects.
    expect(ids).toEqual(["default", "none", "low", "medium", "high"]);
  });

  it("gives a hand-typed custom model no picker — we cannot vouch for it", () => {
    const models = snapshot({ defaultModel: "my-fine-tune" }).models;
    const custom = models.find((model) => model.slug === "my-fine-tune");

    expect(custom).toBeDefined();
    expect(custom?.capabilities).toBeNull();
  });

  it("follows the backend: an OpenRouter instance advertises OpenRouter levels", () => {
    const models = snapshot({ backend: "openrouter" }).models;
    const deepseek = models.find((model) => model.slug === "deepseek/deepseek-v4-flash");
    const descriptor = deepseek?.capabilities?.optionDescriptors?.[0];
    const ids = descriptor?.type === "select" ? descriptor.options.map((o) => o.id) : [];

    expect(ids).toEqual(["default", "none", "low", "medium", "high"]);
  });
});
