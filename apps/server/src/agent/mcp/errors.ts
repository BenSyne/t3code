/**
 * Why an MCP server could not be used.
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
