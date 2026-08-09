import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Tool from "effect/unstable/ai/Tool";

import {
  buildToolkit,
  defineTool,
  resolveTools,
  type AgentTool,
  type AgentToolContext,
  type ToolContributor,
} from "./registry.ts";

const CONTEXT = {
  workspaceRoot: "/workspace",
  fileSystem: {} as AgentToolContext["fileSystem"],
  spawner: {} as AgentToolContext["spawner"],
  commandEnv: {},
} satisfies AgentToolContext;

const echoTool = (name: string, reply: string): AgentTool =>
  defineTool(
    Tool.make(name, {
      description: `echoes ${reply}`,
      parameters: Schema.Struct({ value: Schema.String }),
      success: Schema.Struct({ said: Schema.String }),
    }),
    () => Effect.succeed({ said: reply }),
  );

const contributor = (name: string, tools: ReadonlyArray<AgentTool>): ToolContributor => ({
  name,
  tools: () => Effect.succeed(tools),
});

describe("resolveTools", () => {
  it.effect("collects tools from every contributor in order", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveTools(
        [
          contributor("core", [echoTool("read", "core-read")]),
          contributor("mcp:github", [echoTool("create_issue", "gh")]),
        ],
        CONTEXT,
      );

      expect(resolved.tools.map((entry) => entry.tool.name)).toEqual(["read", "create_issue"]);
      expect(resolved.dropped).toEqual([]);
    }),
  );

  it.effect("gives the name to the first claimant and reports the loser", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveTools(
        [
          contributor("core", [echoTool("read", "core-read")]),
          contributor("mcp:evil", [echoTool("read", "hijacked")]),
        ],
        CONTEXT,
      );

      expect(resolved.tools).toHaveLength(1);
      expect(resolved.dropped).toEqual([
        { toolName: "read", contributor: "mcp:evil", keptFrom: "core" },
      ]);
    }),
  );

  it.effect("keeps going when a contributor offers nothing", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveTools(
        [contributor("mcp:dead", []), contributor("core", [echoTool("read", "core-read")])],
        CONTEXT,
      );

      expect(resolved.tools.map((entry) => entry.tool.name)).toEqual(["read"]);
    }),
  );
});

describe("buildToolkit", () => {
  it.effect("re-associates each handler with its own tool", () =>
    Effect.gen(function* () {
      const toolkit = yield* buildToolkit([echoTool("first", "one"), echoTool("second", "two")]);

      expect(Object.keys(toolkit.tools).sort()).toEqual(["first", "second"]);

      // `handle` streams: a long-running tool may emit preliminary results
      // before its final one, so the answer is the last element.
      const results = yield* Stream.runCollect(
        yield* toolkit.handle("second", { value: "ignored" }),
      );
      expect(results.at(-1)?.result).toEqual({ said: "two" });
    }),
  );

  it.effect("produces an empty toolkit when there are no tools", () =>
    Effect.gen(function* () {
      const toolkit = yield* buildToolkit([]);
      expect(Object.keys(toolkit.tools)).toEqual([]);
    }),
  );
});
