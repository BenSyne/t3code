/**
 * How a user describes an MCP server.
 *
 * @module agent/mcp/serverConfig
 */
import * as Schema from "effect/Schema";

/** A server started as a subprocess and spoken to over its stdin and stdout. */
export const StdioMcpServer = Schema.Struct({
  transport: Schema.Literal("stdio"),
  command: Schema.String,
  args: Schema.optional(Schema.Array(Schema.String)),
  /** Extra environment for the server process, on top of the instance's own. */
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  enabled: Schema.optional(Schema.Boolean),
});

/** A server reached over HTTP. */
export const HttpMcpServer = Schema.Struct({
  transport: Schema.Literal("http"),
  url: Schema.String,
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  enabled: Schema.optional(Schema.Boolean),
});

export const McpServerConfig = Schema.Union([StdioMcpServer, HttpMcpServer]);
export type McpServerConfig = typeof McpServerConfig.Type;

export const McpServers = Schema.Record(Schema.String, McpServerConfig);
export type McpServers = typeof McpServers.Type;

/** Servers the user has not switched off, in a stable order. */
export function enabledServers(
  servers: McpServers,
): ReadonlyArray<{ readonly name: string; readonly config: McpServerConfig }> {
  return Object.entries(servers)
    .filter(([, config]) => config.enabled !== false)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, config]) => ({ name, config }));
}
