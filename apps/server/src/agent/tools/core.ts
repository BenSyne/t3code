/**
 * The tools the agent always has.
 *
 * Listed first among contributors, so nothing discovered at runtime — an MCP
 * server, a skill — can take one of these names out from under the model.
 *
 * @module agent/tools/core
 */
import * as Effect from "effect/Effect";

import { makeEditTool } from "./fs/edit.ts";
import { makeGlobTool } from "./fs/glob.ts";
import { makeGrepTool } from "./fs/grep.ts";
import { makeReadTool } from "./fs/read.ts";
import { makeWriteTool } from "./fs/write.ts";
import type { ToolContributor } from "./registry.ts";
import { makeBashTool } from "./shell/bash.ts";

export const CORE_TOOL_NAMES = ["read", "write", "edit", "glob", "grep", "bash"] as const;

export const coreTools: ToolContributor = {
  name: "core",
  tools: (context) =>
    Effect.succeed([
      makeReadTool(context),
      makeWriteTool(context),
      makeEditTool(context),
      makeGlobTool(context),
      makeGrepTool(context),
      makeBashTool(context),
    ]),
};
