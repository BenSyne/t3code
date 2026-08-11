import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { HttpClient } from "effect/unstable/http";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { unavailableOrchestrationClient } from "../conductor/ConductorClient.ts";
import { conductorContributor } from "../conductor/conductorTools.ts";
import { CORE_TOOL_NAMES } from "../tools/core.ts";
import type { AgentToolContext } from "../tools/registry.ts";
import { BUILTIN_SKILLS } from "./builtinSkills.ts";

const capabilities = BUILTIN_SKILLS.find((skill) => skill.name === "t3-agent-capabilities");

/** Every orchestration tool, including ones a stricter policy would withhold. */
const conductorToolNames = Effect.gen(function* () {
  // The conductor's tools never touch this context, but the contributor
  // interface promises one, so build the real thing rather than lie with a cast.
  const toolContext: AgentToolContext = {
    workspaceRoot: "/",
    fileSystem: yield* FileSystem.FileSystem,
    spawner: yield* ChildProcessSpawner.ChildProcessSpawner,
    httpClient: HttpClient.make(() => Effect.die(new Error("no HTTP in this test"))),
    commandEnv: {},
    requestApproval: () => Effect.succeed({ _tag: "Allowed" as const }),
  };

  const tools = yield* conductorContributor({
    client: unavailableOrchestrationClient,
    policy: { allowSelfTargeting: true, allowApprovingRequests: true },
    selfDriverKind: "t3agent",
    nextId: Effect.succeed("id"),
    nowIso: Effect.succeed("2026-01-01T00:00:00.000Z"),
  }).tools(toolContext);

  return tools.map((entry) => entry.tool.name);
}).pipe(Effect.provide(NodeServices.layer));

/** Named in the skill for reasons other than being an orchestration tool. */
// From the real list, not a copy of it — a copy is the staleness this file warns about.
const CORE_TOOLS = new Set<string>([...CORE_TOOL_NAMES, "skill", "task"]);

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
