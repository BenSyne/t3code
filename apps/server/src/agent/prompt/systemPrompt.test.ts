import { describe, expect, it } from "vite-plus/test";

import { buildSystemPrompt } from "./systemPrompt.ts";

const base = { workspaceRoot: "/repo", projectContext: "" };

describe("buildSystemPrompt", () => {
  it("says nothing about running other agents when it cannot", () => {
    // Tokens on every request of every step. An instance with orchestration off
    // should not carry instructions for tools it does not have.
    const prompt = buildSystemPrompt({ ...base, toolNames: ["read", "bash"] });
    expect(prompt).not.toContain("delegate");
  });

  it("frames delegating as ordinary once the tool is there", () => {
    const prompt = buildSystemPrompt({
      ...base,
      toolNames: ["read", "bash", "delegate_to_agent"],
    });
    expect(prompt).toContain("run the other coding agents");
    // The behaviour worth paying for every turn: check the work, and know that
    // nothing will tell you when it lands.
    expect(prompt).toContain("read the thread back");
    expect(prompt).toContain("Nothing notifies you");
  });

  it("does not restate the tool descriptions the model already receives", () => {
    const prompt = buildSystemPrompt({
      ...base,
      toolNames: ["read", "delegate_to_agent", "list_providers", "stop_delegated_thread"],
    });
    // Named once, in the tool list. A second prose inventory is a copy that
    // goes stale silently.
    expect(prompt.split("stop_delegated_thread").length - 1).toBe(1);
  });

  it("puts project instructions last, so a repository can overrule the defaults", () => {
    const prompt = buildSystemPrompt({
      ...base,
      toolNames: [],
      projectContext: "Always use tabs.",
    });
    expect(prompt.trimEnd().endsWith("Always use tabs.")).toBe(true);
  });
});
