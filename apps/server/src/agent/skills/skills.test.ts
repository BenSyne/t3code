import { describe, expect, it } from "vite-plus/test";

import { skillCatalogBlock, type DiscoveredSkill } from "./discover.ts";
import { parseSkillFile } from "./frontmatter.ts";

const skill = (name: string, description: string): DiscoveredSkill => ({
  name,
  description,
  location: `/workspace/.claude/skills/${name}/SKILL.md`,
  scope: "project",
});

describe("parseSkillFile", () => {
  it("reads the name, description, and body", () => {
    const result = parseSkillFile(
      ["---", "name: review", "description: Reviews a diff", "---", "", "Do the thing."].join("\n"),
    );

    expect(result._tag).toBe("Parsed");
    if (result._tag !== "Parsed") return;
    expect(result.frontmatter).toEqual({ name: "review", description: "Reviews a diff" });
    expect(result.body.trim()).toBe("Do the thing.");
  });

  it("accepts quoted values", () => {
    const result = parseSkillFile(
      ["---", 'name: "review"', "description: 'Reviews a diff'", "---", "body"].join("\n"),
    );

    expect(result._tag).toBe("Parsed");
    if (result._tag !== "Parsed") return;
    expect(result.frontmatter.name).toBe("review");
    expect(result.frontmatter.description).toBe("Reviews a diff");
  });

  it("requires a description, because that is all the model sees to choose by", () => {
    const result = parseSkillFile(["---", "name: review", "---", "body"].join("\n"));
    expect(result).toEqual({ _tag: "Invalid", reason: "no description" });
  });

  it("reports malformed files rather than throwing", () => {
    // A user's broken skill must not stop a turn from starting.
    expect(parseSkillFile("no frontmatter here")).toEqual({
      _tag: "Invalid",
      reason: "missing frontmatter",
    });
    expect(parseSkillFile("---\nname: x\ndescription: y")).toEqual({
      _tag: "Invalid",
      reason: "frontmatter is not closed",
    });
  });

  it("treats a multi-line YAML value as missing rather than reading it wrongly", () => {
    const result = parseSkillFile(
      ["---", "name: review", "description: |", "  long text", "---", "body"].join("\n"),
    );
    expect(result._tag).toBe("Invalid");
  });

  it("tolerates a byte-order mark at the start of the file", () => {
    const result = parseSkillFile("﻿---\nname: a\ndescription: b\n---\nbody");
    expect(result._tag).toBe("Parsed");
  });
});

describe("skillCatalogBlock", () => {
  it("costs one line per skill, which is what makes many skills affordable", () => {
    const block = skillCatalogBlock([skill("review", "Reviews a diff"), skill("ship", "Ships it")]);

    expect(block).toContain("- **review**: Reviews a diff");
    expect(block).toContain("- **ship**: Ships it");
    // The bodies are not in the prompt; the `skill` tool fetches them on demand.
    expect(block.split("\n")).toHaveLength(3);
  });

  it("says nothing at all when there are no skills", () => {
    expect(skillCatalogBlock([])).toBe("");
  });
});
