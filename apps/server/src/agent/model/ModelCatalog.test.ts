import { describe, expect, it } from "vite-plus/test";

import { contextWindowFor, KNOWN_MODELS } from "./ModelCatalog.ts";
import { REASONING_EFFORTS } from "./reasoning.ts";
import { BACKEND_KINDS } from "./resolveLanguageModel.ts";

describe("catalogue reasoning declarations", () => {
  const everyModel = Object.values(KNOWN_MODELS).flat();

  it("only declares efforts that exist on the shared scale", () => {
    for (const model of everyModel) {
      for (const effort of model.reasoningEfforts ?? []) {
        expect(REASONING_EFFORTS).toContain(effort);
      }
    }
  });

  it("lists efforts weakest first, so the picker reads as a dial", () => {
    for (const model of everyModel) {
      const efforts = model.reasoningEfforts ?? [];
      const positions = efforts.map((effort) => REASONING_EFFORTS.indexOf(effort));
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    }
  });

  it("declares an empty set for no model — absent means absent", () => {
    // An empty array would grow a picker offering only "Default", which reads
    // as a broken control. A model that does not reason declares nothing.
    for (const model of everyModel) {
      expect(model.reasoningEfforts?.length).not.toBe(0);
    }
  });
});

describe("catalogue coverage", () => {
  it("has an entry for every backend, so a lookup never falls off the table", () => {
    for (const backend of BACKEND_KINDS) {
      expect(KNOWN_MODELS[backend]).toBeDefined();
    }
  });

  it("quotes Cerebras' free-tier windows, not the paid ones", () => {
    // Deliberately the smaller pair. Claiming the paid 131k means compaction
    // never fires for a free-tier user, so the first they hear about the limit
    // is a rejected request. Erring low only costs an early summarisation.
    expect(contextWindowFor("cerebras", "zai-glm-4.7")).toBe(64_000);
    expect(contextWindowFor("cerebras", "gpt-oss-120b")).toBe(65_000);
  });

  it("declares Cerebras' per-model effort sets, which genuinely differ", () => {
    const models = KNOWN_MODELS.cerebras;
    const efforts = (id: string) => models.find((m) => m.id === id)?.reasoningEfforts;

    // Straight from Cerebras' own table: GLM only lets you turn reasoning off,
    // GPT-OSS always reasons so has no "none", Gemma offers the full set.
    expect(efforts("zai-glm-4.7")).toEqual(["none"]);
    expect(efforts("gpt-oss-120b")).toEqual(["low", "medium", "high"]);
    expect(efforts("gemma-4-31b")).toEqual(["none", "low", "medium", "high"]);
  });
});
