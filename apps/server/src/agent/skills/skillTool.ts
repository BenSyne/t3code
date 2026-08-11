// @effect-diagnostics nodeBuiltinImport:off
/**
 * The `skill` tool: load a skill's instructions on demand.
 *
 * @module agent/skills/skillTool
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";

import { ToolFailure, toolFailure } from "../tools/failure.ts";
import { defineTool, type AgentTool, type ToolContributor } from "../tools/registry.ts";
import { parseSkillFile } from "./frontmatter.ts";
import type { DiscoveredSkill } from "./discover.ts";

/** A skill longer than this is truncated rather than allowed to fill the window. */
const MAX_BODY_BYTES = 32 * 1024;

const SkillTool = Tool.make("skill", {
  description:
    "Load the full instructions for one of the available skills. " +
    "Do this before following a skill, not after.",
  parameters: Schema.Struct({
    name: Schema.String.annotate({
      description: "The skill's name, exactly as listed in the available skills.",
    }),
  }),
  success: Schema.Struct({
    name: Schema.String,
    instructions: Schema.String,
  }),
  failure: ToolFailure,
  failureMode: "return",
});

export function makeSkillTool(skills: ReadonlyArray<DiscoveredSkill>): AgentTool {
  const byName = new Map(skills.map((skill) => [skill.name, skill]));

  return defineTool(
    SkillTool,
    Effect.fnUntraced(function* (params) {
      const skill = byName.get(params.name);
      if (skill === undefined) {
        const available = skills.map((entry) => entry.name).join(", ");
        return yield* toolFailure(
          available === ""
            ? "No skills are available in this project."
            : `No skill named "${params.name}". Available: ${available}.`,
        );
      }

      // Compiled-in knowledge has its text already; only disk skills are read.
      if (skill.body !== undefined) {
        return { name: skill.name, instructions: clip(skill.body) };
      }

      const content = yield* Effect.orElseSucceed(
        Effect.promise(() => NodeFSP.readFile(skill.location, "utf8")),
        () => null,
      );
      if (content === null) {
        return yield* toolFailure(`The skill "${skill.name}" could not be read.`);
      }

      const parsed = parseSkillFile(content);
      if (parsed._tag === "Invalid") {
        // It parsed at discovery, so this means it changed underneath us.
        return yield* toolFailure(
          `The skill "${skill.name}" is no longer valid: ${parsed.reason}.`,
        );
      }

      return {
        name: skill.name,
        instructions: [
          clip(parsed.body),
          "",
          `Files that come with this skill are in ${NodePath.dirname(skill.location)}.`,
        ].join("\n"),
      };
    }),
  );
}

/** Only contributed when there is at least one skill, so the tool list stays honest. */
export function skillContributor(skills: ReadonlyArray<DiscoveredSkill>): ToolContributor {
  return {
    name: "skills",
    tools: () => Effect.succeed(skills.length === 0 ? [] : [makeSkillTool(skills)]),
  };
}

function clip(body: string): string {
  if (Buffer.byteLength(body, "utf8") <= MAX_BODY_BYTES) {
    return body;
  }
  return `${body.slice(0, MAX_BODY_BYTES)}\n\n[truncated — this skill is longer than the agent loads at once]`;
}
