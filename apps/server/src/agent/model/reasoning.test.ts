import { describe, expect, it } from "vite-plus/test";

import {
  asReasoningEffort,
  reasoningEffortsFor,
  REASONING_EFFORT_LABELS,
  REASONING_EFFORTS,
} from "./reasoning.ts";

describe("asReasoningEffort", () => {
  it("accepts every effort on the scale", () => {
    for (const effort of REASONING_EFFORTS) {
      expect(asReasoningEffort(effort)).toBe(effort);
    }
  });

  it('treats the "default" picker choice as no effort, because it means send nothing', () => {
    expect(asReasoningEffort("default")).toBeUndefined();
  });

  it("treats an unrecognised stored value as absent rather than failing the turn", () => {
    // Selections outlive builds: a thread configured under a future version
    // must still run under this one.
    expect(asReasoningEffort("hyperthink")).toBeUndefined();
    expect(asReasoningEffort("")).toBeUndefined();
    expect(asReasoningEffort(undefined)).toBeUndefined();
  });
});

describe("labels", () => {
  it("has a label for every effort, so the picker never shows a raw id", () => {
    for (const effort of REASONING_EFFORTS) {
      expect(REASONING_EFFORT_LABELS[effort]).toBeTruthy();
    }
  });
});

describe("reading which efforts a model accepts", () => {
  const descriptor = (options: ReadonlyArray<{ id: string }>) => ({
    optionDescriptors: [{ id: "reasoningEffort", label: "Reasoning", type: "select", options }],
  });

  it("returns the levels the model's own picker offers", () => {
    expect(
      reasoningEffortsFor(descriptor([{ id: "low" }, { id: "medium" }, { id: "high" }])),
    ).toEqual(["low", "medium", "high"]);
  });

  it("drops the Default choice, which is not a level anyone can ask for", () => {
    expect(reasoningEffortsFor(descriptor([{ id: "default" }, { id: "high" }]))).toEqual(["high"]);
  });

  it("drops levels this build has never heard of rather than passing them on", () => {
    // Selections outlive builds. Reporting an unknown level as available would
    // have the agent choose one the provider then rejects at the first request.
    expect(reasoningEffortsFor(descriptor([{ id: "ludicrous" }, { id: "low" }]))).toEqual(["low"]);
  });

  it("reports nothing for a model with no reasoning control", () => {
    // Distinct from "we do not know": sending an effort to one of these is
    // silently meaningless, so the agent should be able to see that it is.
    expect(reasoningEffortsFor(null)).toEqual([]);
    expect(reasoningEffortsFor({})).toEqual([]);
    expect(
      reasoningEffortsFor({ optionDescriptors: [{ id: "webSearch", type: "boolean" }] }),
    ).toEqual([]);
  });

  it("ignores a reasoning control that is not a set of choices", () => {
    expect(
      reasoningEffortsFor({ optionDescriptors: [{ id: "reasoningEffort", type: "boolean" }] }),
    ).toEqual([]);
  });
});
