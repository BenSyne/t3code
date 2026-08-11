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

describe("naming who powers each model", () => {
  const openrouter = () => snapshot({ backend: "openrouter" }).models;
  const find = (slug: string) => openrouter().find((model) => model.slug === slug);

  it("names the vendor behind an aggregated model", () => {
    // Without it an OpenRouter list is a wall of names with no way to tell a
    // frontier model from somebody's fine-tune.
    expect(find("anthropic/claude-sonnet-5")?.subProvider).toBe("Anthropic");
    expect(find("moonshotai/kimi-k3")?.subProvider).toBe("Moonshot AI");
  });

  it("stays quiet when the model's own name already opens with the vendor", () => {
    // The picker strips a leading vendor word off the label, so claiming
    // "DeepSeek" here turned "DeepSeek V4 Pro" into a row reading "V4 Pro",
    // which names nothing. Seen in the running app, not reasoned about.
    expect(find("deepseek/deepseek-v4-pro")?.subProvider).toBeUndefined();
    expect(find("deepseek/deepseek-v4-pro")?.name).toBe("DeepSeek V4 Pro");
  });

  it("shows the vendor when it is a different word from the model family", () => {
    // "GLM 4.7" does not start with "Z.ai", so both fit without repetition.
    const glm = snapshot({ backend: "cerebras" }).models.find((m) => m.slug === "zai-glm-4.7");
    expect(glm?.subProvider).toBe("Z.ai");
  });

  it("leaves a hand-typed model unlabelled rather than guessing", () => {
    const custom = snapshot({ defaultModel: "my-fine-tune" }).models.find(
      (model) => model.slug === "my-fine-tune",
    );
    expect(custom?.subProvider).toBeUndefined();
  });
});

describe("reasoning picker", () => {
  it("offers the reasoning control on models the catalogue vouches for", () => {
    const sonnet = snapshot({ backend: "anthropic" }).models.find(
      (model) => model.slug === "claude-sonnet-5",
    );
    const descriptors = sonnet?.capabilities?.optionDescriptors ?? [];

    expect(descriptors).toHaveLength(1);
    const descriptor = descriptors[0];
    expect(descriptor?.id).toBe("reasoningEffort");
    expect(descriptor?.type).toBe("select");
  });

  it('puts "Default" first, selected, and honest about meaning "send nothing"', () => {
    const sonnet = snapshot({ backend: "anthropic" }).models.find(
      (model) => model.slug === "claude-sonnet-5",
    );
    const descriptor = sonnet?.capabilities?.optionDescriptors?.[0];
    const first = descriptor?.type === "select" ? descriptor.options[0] : undefined;

    expect(first?.id).toBe("default");
    expect(first?.isDefault).toBe(true);
    expect(first?.description).toContain("Nothing extra is sent");
  });

  it("offers only the levels the backend can honour", () => {
    const sonnet = snapshot({ backend: "anthropic" }).models.find(
      (model) => model.slug === "claude-sonnet-5",
    );
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
