import { describe, expect, it } from "vite-plus/test";

import * as Redacted from "effect/Redacted";

import {
  anthropicReasoningConfig,
  BACKEND_KINDS,
  CEREBRAS_BASE_URL,
  compatBaseUrl,
  compatReasoningConfig,
  DEFAULT_LOCAL_BASE_URL,
  openAiReasoningConfig,
  openRouterReasoningConfig,
  resolveLanguageModel,
} from "./resolveLanguageModel.ts";

describe("anthropic effort translation", () => {
  it("sends nothing when no effort was chosen", () => {
    expect(anthropicReasoningConfig(undefined)).toBeUndefined();
  });

  it('"none" disables thinking outright', () => {
    expect(anthropicReasoningConfig("none")).toEqual({ thinking: { type: "disabled" } });
  });

  it("maps the middle of the scale to adaptive thinking at a native level", () => {
    expect(anthropicReasoningConfig("medium")).toEqual({
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
    });
  });

  it("clamps levels Anthropic cannot express to the nearest it can", () => {
    // These normally never fire — the picker only offers what the catalogue
    // declares — but stored selections outlive builds, and slightly less
    // effort than asked beats a turn that does not run.
    expect(anthropicReasoningConfig("minimal")).toEqual({
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
    });
    expect(anthropicReasoningConfig("xhigh")).toEqual({
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
    });
    expect(anthropicReasoningConfig("max")).toEqual({
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
    });
  });
});

describe("openai effort translation", () => {
  it("sends nothing when no effort was chosen", () => {
    expect(openAiReasoningConfig(undefined)).toBeUndefined();
  });

  it("passes the scale through directly", () => {
    expect(openAiReasoningConfig("minimal")).toEqual({ reasoning: { effort: "minimal" } });
    expect(openAiReasoningConfig("xhigh")).toEqual({ reasoning: { effort: "xhigh" } });
  });

  it('clamps "max", the one level OpenAI does not have', () => {
    expect(openAiReasoningConfig("max")).toEqual({ reasoning: { effort: "xhigh" } });
  });
});

describe("openrouter effort translation", () => {
  it("sends nothing when no effort was chosen", () => {
    expect(openRouterReasoningConfig(undefined)).toBeUndefined();
  });

  it("passes the whole scale verbatim — it is their vocabulary", () => {
    expect(openRouterReasoningConfig("none")).toEqual({ reasoning_effort: "none" });
    expect(openRouterReasoningConfig("max")).toEqual({ reasoning_effort: "max" });
  });
});

describe("openai-compat effort translation", () => {
  it("sends nothing when no effort was chosen", () => {
    expect(compatReasoningConfig(undefined)).toBeUndefined();
  });

  it("passes reasoning_effort through for the server to honour or ignore", () => {
    expect(compatReasoningConfig("high")).toEqual({ reasoning_effort: "high" });
  });
});

describe("resolving a backend to a layer", () => {
  const credential = Redacted.make("test-key");

  it("builds a layer for every declared backend", () => {
    // The switch is exhaustive by type, but a backend added to the list and
    // forgotten in the switch would only surface at runtime, on the first turn
    // a user takes — long after it shipped.
    for (const backend of BACKEND_KINDS) {
      expect(resolveLanguageModel({ backend, credential, model: "some-model" })).toBeDefined();
    }
  });

  it("pins Cerebras to its own endpoint", () => {
    expect(compatBaseUrl("cerebras", undefined)).toBe(CEREBRAS_BASE_URL);
  });

  it("ignores a Base URL typed on a Cerebras instance", () => {
    // The address is what makes this backend Cerebras. Honouring an override
    // would let a stray value silently point it at something else while the
    // UI still names Cerebras and the picker still offers its models.
    expect(compatBaseUrl("cerebras", "http://localhost:9999/v1")).toBe(CEREBRAS_BASE_URL);
  });

  it("honours a Base URL for a self-hosted server, and falls back to Ollama's", () => {
    expect(compatBaseUrl("openai-compat", "http://localhost:1234/v1")).toBe(
      "http://localhost:1234/v1",
    );
    expect(compatBaseUrl("openai-compat", undefined)).toBe(DEFAULT_LOCAL_BASE_URL);
  });
});
