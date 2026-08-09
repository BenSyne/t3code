import { describe, expect, it } from "vite-plus/test";

import { BUILTIN_SKILLS } from "./builtinSkills.ts";

describe("built-in knowledge", () => {
  it("gives every skill the two fields discovery requires", () => {
    // A skill with no description is silently skipped, and the name is all the
    // agent has to choose by. Shipping one malformed would fail invisibly.
    for (const skill of BUILTIN_SKILLS) {
      expect(skill.name.trim()).not.toBe("");
      expect(skill.description.trim()).not.toBe("");
      expect(skill.body?.trim()).toBeTruthy();
    }
  });

  it("keeps names unique, since a clash silently drops one", () => {
    const names = BUILTIN_SKILLS.map((skill) => skill.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("marks them as compiled in rather than pointing at a path", () => {
    // A packaged build has no repository to read these from, so a location
    // that looked like a real path would be a file that is never there.
    for (const skill of BUILTIN_SKILLS) {
      expect(skill.location.startsWith("<built-in>/")).toBe(true);
    }
  });
});

describe("the house style skill", () => {
  const house = BUILTIN_SKILLS.find((skill) => skill.name === "t3-house-style");
  const body = house?.body ?? "";

  it("frames the agent as an assistant rather than as the person", () => {
    // The distinction the whole skill turns on. Holding work to someone's
    // standard is the job; inventing opinions for a real person, inside that
    // person's own product, is the failure.
    expect(body).toContain("his assistant, not him");
  });

  it("forbids inventing a position and offers what to say instead", () => {
    expect(body).toContain("Never do the second");
    expect(body).toMatch(/publicly stated.*or say you do not know/s);
  });

  it("puts the repository above any inherited opinion", () => {
    // Conventions in the code are checkable and current; a remembered talk is
    // neither. When they disagree the code has to win.
    expect(body).toMatch(/govern and win any disagreement/);
  });

  it("requires disclosing work it would not sign off on", () => {
    expect(body).toContain("Discovering it is not");
  });
});

describe("the routing skill", () => {
  const routing = BUILTIN_SKILLS.find((skill) => skill.name === "t3-choosing-an-agent");
  const body = routing?.body ?? "";

  it("exists and is reachable by description", () => {
    expect(routing).toBeDefined();
    expect(routing?.description.toLowerCase()).toContain("delegate");
  });

  it("points at the live facts before its own opinions", () => {
    // The whole design: billing and availability are read from the running
    // system and cannot go stale. Everything else is a dated summary.
    expect(body).toContain("billing");
    expect(body).toContain("available");
    expect(body.indexOf("Check the facts first")).toBeLessThan(body.indexOf("Rough heuristics"));
  });

  it("dates its editorial claims rather than stating them as timeless", () => {
    // Model rankings move every few weeks. An undated claim reads as fact
    // long after it stopped being one.
    expect(body).toContain("August 2026");
  });

  it("tells the agent to ask when the call is close and expensive", () => {
    expect(body).toMatch(/then\s*\nask|then ask/);
  });

  it("names every effort level the delegation tool accepts", () => {
    for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh", "max"]) {
      expect(body).toContain(effort);
    }
  });
});
