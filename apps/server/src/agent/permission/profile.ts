/**
 * What needs asking, given the mode the user chose.
 *
 * @module agent/permission/profile
 */
import type { RuntimeMode } from "@t3tools/contracts";

/** What a tool wants to do, from the permission system's point of view. */
export type PermissionSubject = "read" | "edit" | "command";

export type PermissionDecision = "allow" | "ask" | "deny";

export interface PermissionProfile {
  readonly read: PermissionDecision;
  readonly edit: PermissionDecision;
  readonly command: PermissionDecision;
  /**
   * Whether a command judged destructive still asks, even when commands are
   * otherwise allowed. Only `full-access` turns this off — that mode exists
   * precisely for someone who has decided to stop being asked.
   */
  readonly askBeforeDestructiveCommands: boolean;
}

/** Reading is never gated. */
export function profileFor(mode: RuntimeMode): PermissionProfile {
  switch (mode) {
    case "approval-required":
      return {
        read: "allow",
        edit: "ask",
        command: "ask",
        askBeforeDestructiveCommands: true,
      };
    case "auto-accept-edits":
      return {
        read: "allow",
        edit: "allow",
        command: "ask",
        askBeforeDestructiveCommands: true,
      };
    case "auto":
      return {
        read: "allow",
        edit: "allow",
        command: "allow",
        askBeforeDestructiveCommands: true,
      };
    case "full-access":
      return {
        read: "allow",
        edit: "allow",
        command: "allow",
        askBeforeDestructiveCommands: false,
      };
  }
}

/** Which subject a tool falls under. Unknown tools are treated as commands. */
export function subjectForTool(toolName: string): PermissionSubject {
  switch (toolName) {
    case "read":
    case "glob":
    case "grep":
      return "read";
    case "write":
    case "edit":
      return "edit";
    case "bash":
      return "command";
    default:
      // An MCP server's tool can do anything, and we cannot know what. Treating
      // it as the most privileged category is the only safe default.
      return "command";
  }
}
