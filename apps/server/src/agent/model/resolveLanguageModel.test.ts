import { describe, expect, it } from "vite-plus/test";

import {
  anthropicReasoningConfig,
  compatReasoningConfig,
  openAiReasoningConfig,
  openRouterReasoningConfig,
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
