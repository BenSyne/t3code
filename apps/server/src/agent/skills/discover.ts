// @effect-diagnostics nodeBuiltinImport:off
/**
 * Finding the skills available in a project.
 *
 * Looks in the places the ecosystem already puts them, so a folder written for
 * another agent works here with no changes. Project skills beat global ones of
 * the same name: a repository that ships a skill has decided how that name
 * should behave inside it.
 *
 * ## Progressive disclosure
 *
 * Only the name and description of each skill go into the system prompt. The
 * body — which can be thousands of words — is loaded by the `skill` tool when
 * the model decides to use it. Ten skills therefore cost ten lines of context,
 * not ten documents.
 *
 * @module agent/skills/discover
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";

import { parseSkillFile } from "./frontmatter.ts";

export interface DiscoveredSkill {
  readonly name: string;
  readonly description: string;
  /** Absolute path to the `SKILL.md`, so the tool can read the body later. */
  readonly location: string;
  readonly scope: "project" | "global";
  /**
   * The instructions, when they are compiled in rather than on disk.
   *
   * Built-in knowledge has no file to read — and must not, because a packaged
   * build has no repository to read it from.
   */
  readonly body?: string | undefined;
}

export interface SkillDiscovery {
  readonly skills: ReadonlyArray<DiscoveredSkill>;
  /**
   * Files that looked like skills but could not be read.
   *
   * Carries `scope` because it decides who hears about it. A malformed skill
   * in the project is about the work at hand and worth surfacing; one in the
   * home directory belongs to some other tool's setup, and repeating it in
   * every thread of every project is noise the user cannot act on from here.
   */
  readonly rejected: ReadonlyArray<{
    readonly path: string;
    readonly reason: string;
    readonly scope: "project" | "global";
  }>;
}

export const EMPTY_DISCOVERY: SkillDiscovery = { skills: [], rejected: [] };

/** Where skills live, checked in this order. Project first, so it wins. */
const PROJECT_SKILL_ROOTS = [".claude/skills", ".opencode/skills", ".t3/skills", "skills"];
const GLOBAL_SKILL_ROOTS = [".claude/skills", ".config/t3/skills"];

/** A skill folder deeper than this is almost certainly a mistake. */
const MAX_DEPTH = 3;
/** Enough for any real project; a cap stops a pathological tree from hanging a turn. */
const MAX_SKILLS = 100;

/**
 * Discover every skill visible from this workspace.
 *
 * Never fails. A directory that cannot be read contributes nothing.
 */
export const discoverSkills = Effect.fnUntraced(function* (input: {
  readonly workspaceRoot: string;
  readonly homeDirectory: string;
}) {
  const found = new Map<string, DiscoveredSkill>();
  const rejected: Array<SkillDiscovery["rejected"][number]> = [];

  // Global first, so a project skill of the same name overwrites it.
  for (const [scope, roots, base] of [
    ["global", GLOBAL_SKILL_ROOTS, input.homeDirectory],
    ["project", PROJECT_SKILL_ROOTS, input.workspaceRoot],
  ] as const) {
    for (const root of roots) {
      const entries = yield* Effect.promise(() =>
        collectSkillFiles(NodePath.join(base, root), MAX_DEPTH),
      );
      for (const file of entries) {
        if (found.size >= MAX_SKILLS) {
          break;
        }
        const parsed = yield* Effect.promise(() => readSkill(file, scope));
        if (parsed._tag === "Invalid") {
          rejected.push({ path: file, reason: parsed.reason, scope });
          continue;
        }
        found.set(parsed.skill.name, parsed.skill);
      }
    }
  }

  return {
    skills: Array.from(found.values()).sort((left, right) => left.name.localeCompare(right.name)),
    rejected,
  } satisfies SkillDiscovery;
});

/**
 * The block that goes into the system prompt.
 *
 * One line per skill. This is the entire context cost of having skills
 * available, which is what makes it reasonable to have many.
 */
export function skillCatalogBlock(skills: ReadonlyArray<DiscoveredSkill>): string {
  if (skills.length === 0) {
    return "";
  }
  return [
    "Available skills. Call the `skill` tool with a name to load its full instructions before using it.",
    ...skills.map((skill) => `- **${skill.name}**: ${skill.description}`),
  ].join("\n");
}

async function collectSkillFiles(root: string, depth: number): Promise<ReadonlyArray<string>> {
  if (depth < 0) {
    return [];
  }
  let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
  try {
    entries = await NodeFSP.readdir(root, { withFileTypes: true });
  } catch {
    // A skills directory that does not exist is the normal case.
    return [];
  }

  const files: Array<string> = [];
  for (const entry of entries) {
    const full = NodePath.join(root, entry.name);
    if (entry.isFile() && entry.name === "SKILL.md") {
      files.push(full);
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...(await collectSkillFiles(full, depth - 1)));
    }
  }
  return files;
}

async function readSkill(
  file: string,
  scope: "project" | "global",
): Promise<{ _tag: "Parsed"; skill: DiscoveredSkill } | { _tag: "Invalid"; reason: string }> {
  let content: string;
  try {
    content = await NodeFSP.readFile(file, "utf8");
  } catch {
    return { _tag: "Invalid", reason: "could not be read" };
  }

  const parsed = parseSkillFile(content);
  if (parsed._tag === "Invalid") {
    return parsed;
  }

  return {
    _tag: "Parsed",
    skill: {
      name: parsed.frontmatter.name,
      description: parsed.frontmatter.description,
      location: file,
      scope,
    },
  };
}
