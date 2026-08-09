/**
 * Why an MCP server could not be used.
 *
 * Tagged rather than a bare `Error` so it stays distinguishable in a failure
 * channel it may share with others. The message is written for the warning the
 * user sees, which is the only place these surface — nothing here ever reaches
 * the model or ends a turn.
 *
 * @module agent/mcp/errors
 */
import * as Schema from "effect/Schema";

export class McpServerError extends Schema.TaggedErrorClass<McpServerError>()("McpServerError", {
  serverName: Schema.String,
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

export const mcpServerError = (serverName: string, detail: string): McpServerError =>
  new McpServerError({ serverName, detail });
