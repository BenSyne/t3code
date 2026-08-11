/**
 * The tools the agent always has.
 *
 * @module agent/tools/core
 */
import * as Effect from "effect/Effect";

import { makeEditTool } from "./fs/edit.ts";
import { makeGlobTool } from "./fs/glob.ts";
import { makeGrepTool } from "./fs/grep.ts";
import { makeReadTool } from "./fs/read.ts";
import { makeWriteTool } from "./fs/write.ts";
import { makeUpdatePlanTool } from "./plan/updatePlan.ts";
import { withApproval, type AgentToolContext, type ToolContributor } from "./registry.ts";
import { makeBashTool } from "./shell/bash.ts";
import { makeWebFetchTool } from "./web/fetch.ts";

export const CORE_TOOL_NAMES = [
  "read",
  "write",
  "edit",
  "glob",
  "grep",
  "bash",
  "webfetch",
  "update_plan",
] as const;

/** What the user is shown when asked about a call: the command, path, or URL. */
const commandOf = (params: never): string =>
  String((params as { command?: unknown }).command ?? "");
const filePathOf = (params: never): string =>
  String((params as { filePath?: unknown }).filePath ?? "");
const urlOf = (params: never): string => String((params as { url?: unknown }).url ?? "");

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
      withApproval(makeWebFetchTool(context), context, urlOf),
      // No approval: the plan changes nothing outside the timeline.
      makeUpdatePlanTool(),
    ]),
};
