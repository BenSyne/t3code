import { describe, expect, it } from "vite-plus/test";

import { asReasoningEffort, REASONING_EFFORT_LABELS, REASONING_EFFORTS } from "./reasoning.ts";

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
