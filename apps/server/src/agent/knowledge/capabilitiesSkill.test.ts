import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { unavailableOrchestrationClient } from "../conductor/ConductorClient.ts";
import { conductorContributor } from "../conductor/conductorTools.ts";
import { BUILTIN_SKILLS } from "./builtinSkills.ts";

const capabilities = BUILTIN_SKILLS.find((skill) => skill.name === "t3-agent-capabilities");

/** Every orchestration tool, including ones a stricter policy would withhold. */
const conductorToolNames = conductorContributor({
  client: unavailableOrchestrationClient,
  policy: { allowSelfTargeting: true, allowApprovingRequests: true },
  selfDriverKind: "t3agent",
  nextId: Effect.succeed("id"),
  nowIso: Effect.succeed("2026-01-01T00:00:00.000Z"),
})
  .tools()
  .pipe(Effect.map((tools) => tools.map((entry) => entry.tool.name)));

/** Named in the skill for reasons other than being an orchestration tool. */
const CORE_TOOLS = new Set(["read", "write", "edit", "glob", "grep", "bash", "skill", "task"]);

describe("the capabilities skill", () => {
  // Prose listing tools goes stale the moment one is added, and the failure is
  // invisible: the agent reads its own documentation and tells the user it
  // cannot do something it can. That shipped once already — the skill claimed
  // seven orchestration tools when there were fourteen.
  it.effect("names every orchestration tool the agent is actually given", () =>
    Effect.gen(function* () {
      const names = yield* conductorToolNames;

      assert.isAbove(names.length, 0);
      for (const name of names) {
        assert.include(capabilities?.body ?? "", name);
      }
    }),
  );

  it.effect("names no orchestration tool that does not exist", () =>
    Effect.gen(function* () {
      const names = yield* conductorToolNames;
      const claimed = [...(capabilities?.body ?? "").matchAll(/`([a-z][a-z_]+)`/g)].map(
        (match) => match[1] as string,
      );

      for (const name of claimed) {
        if (CORE_TOOLS.has(name) || !name.includes("_")) {
          continue;
        }
        assert.include(names, name);
      }
    }),
  );
});
