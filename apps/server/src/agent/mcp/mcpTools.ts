/**
 * MCP tools as agent tools.
 *
 * @module agent/mcp/mcpTools
 */
import * as Effect from "effect/Effect";
import * as Tool from "effect/unstable/ai/Tool";

import type { AgentTool, ToolContributor } from "../tools/registry.ts";
import type { ConnectedServer } from "./McpClientPool.ts";

/** `mcp__<server>__<tool>`, the convention every agent with MCP support uses. */
export function qualifiedName(serverName: string, toolName: string): string {
  return `mcp__${sanitise(serverName)}__${sanitise(toolName)}`;
}

export function toolsForServer(server: ConnectedServer): ReadonlyArray<AgentTool> {
  return server.tools.map((descriptor) => {
    const tool = Tool.dynamic(qualifiedName(server.name, descriptor.name), {
      description: descriptor.description,
      parameters: descriptor.inputSchema,
    });

    // `Tool.dynamic` with a JSON Schema hands the handler `unknown`, which is
    // correct: the schema is the server's, and validating it here would only
    // duplicate the check the server already has to do.
    const handler = (params: unknown) =>
      Effect.map(server.call(descriptor.name, params), (result) =>
        result.isError ? `The tool reported an error: ${result.text}` : result.text,
      );

    return { tool, handler: handler as AgentTool["handler"] };
  });
}

/** A contributor over an already-connected pool. */
export function mcpContributor(servers: ReadonlyArray<ConnectedServer>): ToolContributor {
  return {
    name: "mcp",
    tools: () => Effect.succeed(servers.flatMap(toolsForServer)),
  };
}

/** Tool names are matched by the model verbatim, so keep them boring. */
function sanitise(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}
