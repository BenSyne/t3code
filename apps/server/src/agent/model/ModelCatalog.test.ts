import { describe, expect, it } from "vite-plus/test";

import { KNOWN_MODELS } from "./ModelCatalog.ts";
import { REASONING_EFFORTS } from "./reasoning.ts";

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
