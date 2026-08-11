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

  it("names no person as the source of the standard", () => {
    // The skill used to tell the agent to work the way a specific, named
    // maintainer would want. Holding work to a high standard is the job;
    // sourcing that standard from a real person means every judgement it makes
    // is implicitly attributed to someone who never agreed to it.
    expect(body).not.toMatch(/\bTheo\b/);
    expect(body).toMatch(/this repository/i);
  });

  it("forbids inventing a position and offers what to say instead", () => {
    expect(body).toContain("Do not put opinions in anyone's mouth");
    expect(body).toMatch(/stated publicly.*or say you do not know/s);
  });

  it("puts the repository above any inherited opinion", () => {
    // Conventions in the code are checkable and current; a remembered talk is
    // neither. When they disagree the code has to win.
    expect(body).toMatch(/govern and win\s+any disagreement/);
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

  it("forbids naming a model it has not looked up", () => {
    // The failure this exists for: asked which model to use, the agent either
    // invented a plausible slug or hedged about what the user's picker showed.
    // Both are the same mistake — answering from memory when one tool call
    // would have given the real list.
    expect(body).toContain("Never name a model you have not seen in");
    expect(body).toContain("list_models");
  });

  it("names hedging as a failure, not a safe fallback", () => {
    expect(body).toMatch(/Hedging is not the fix/);
  });

  it("tells the agent that leaving the model unset is usually right", () => {
    // Overriding a maintainer's default is a claim to know better about a
    // specific task. Left unsaid, a model with a list in front of it will pick
    // from the list every time.
    expect(body).toMatch(/Most of the time: \*\*do not\.\*\*/);
  });

  it("puts effort above model tier, since that is the call that pays off", () => {
    expect(body).toContain("Effort usually matters more than tier");
  });

  it("refuses to rank models by name, which is what would go stale", () => {
    // Deliberate: lineups turn over every few weeks, so the skill teaches how
    // to read `list_models` rather than what any particular model is good at.
    // A slug hardcoded here would be wrong within two releases.
    expect(body).toMatch(/Nothing\s+in a slug tells you where on that ladder it sits/);
  });

  it("teaches that a blocked thread is not a slow one", () => {
    // The three states look identical from outside. Without this the agent
    // waits on a thread that has stopped and will never move again.
    expect(body).toContain("awaitingInput");
    expect(body).toMatch(/will never move on its own/);
  });

  it("sends the agent to wait_for_thread rather than checking in a loop", () => {
    // Checking by hand costs a whole turn per look; the server can answer for
    // free. The skill has to say so, or the model does the expensive thing.
    expect(body).toContain("wait_for_thread");
    expect(body).toMatch(/every check you make by hand is a whole turn/);
  });

  it("sends corrections into the existing thread rather than a new one", () => {
    expect(body).toContain("send_to_thread");
    expect(body).toMatch(/Starting over throws away/);
  });

  it("leaves approvals to the user even where it can answer questions", () => {
    expect(body).toContain("Approvals are the user's call");
  });

  it("names every effort level the delegation tool accepts", () => {
    for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh", "max"]) {
      expect(body).toContain(effort);
    }
  });
});

describe("the routing skill on what it cannot do", () => {
  const body = BUILTIN_SKILLS.find((skill) => skill.name === "t3-choosing-an-agent")?.body ?? "";

  it("says plainly that nothing wakes it when a delegation finishes", () => {
    // Observed live: it told the user "I'll keep an eye on it" and then had no
    // mechanism to do so. A promise the system cannot keep is worse than a
    // missing feature — the user waits for a message that never comes.
    expect(body).toContain("You will not be told when a delegated thread finishes");
    expect(body).toMatch(/never say you will watch/i);
  });
});
