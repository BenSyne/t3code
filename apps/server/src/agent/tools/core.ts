/**
 * The tools the agent always has.
 *
 * Listed first among contributors, so nothing discovered at runtime — an MCP
 * server, a skill — can take one of these names out from under the model.
 *
 * The tools that change something are wrapped in the approval gate here rather
 * than asking inside their own handlers. A tool that has to remember to ask is
 * a tool that will eventually forget, and the failure is silent.
 *
 * @module agent/tools/core
 */
import * as Effect from "effect/Effect";

import { makeEditTool } from "./fs/edit.ts";
import { makeGlobTool } from "./fs/glob.ts";
import { makeGrepTool } from "./fs/grep.ts";
import { makeReadTool } from "./fs/read.ts";
import { makeWriteTool } from "./fs/write.ts";
import { withApproval, type AgentToolContext, type ToolContributor } from "./registry.ts";
import { makeBashTool } from "./shell/bash.ts";

export const CORE_TOOL_NAMES = ["read", "write", "edit", "glob", "grep", "bash"] as const;

/** What the user is shown when asked about a call: the command, or the path. */
const commandOf = (params: never): string =>
  String((params as { command?: unknown }).command ?? "");
const filePathOf = (params: never): string =>
  String((params as { filePath?: unknown }).filePath ?? "");

export const coreTools: ToolContributor = {
  name: "core",
  tools: (context: AgentToolContext) =>
    Effect.succeed([
      makeReadTool(context),
      makeGlobTool(context),
      makeGrepTool(context),
      withApproval(makeWriteTool(context), context, filePathOf),
      withApproval(makeEditTool(context), context, filePathOf),
      withApproval(makeBashTool(context), context, commandOf),
    ]),
};
