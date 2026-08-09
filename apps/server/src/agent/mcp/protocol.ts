/**
 * The bits of MCP this agent needs, and nothing more.
 *
 * MCP is JSON-RPC 2.0 over a stream. We use three calls — `initialize`,
 * `tools/list`, `tools/call` — so the protocol layer is a message framer and a
 * request/response table rather than a client library.
 *
 * Writing this instead of taking a dependency is a deliberate trade. The
 * official SDK would bring a package into a repository whose whole selling
 * point for this feature is that it added none, to save perhaps a hundred lines
 * of well-specified framing. Resources, prompts, sampling and OAuth are all out
 * of scope; a server that needs them is unsupported rather than half-supported.
 *
 * @module agent/mcp/protocol
 */

export const PROTOCOL_VERSION = "2025-06-18";

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

/** One tool as an MCP server describes it. */
export interface McpToolDescriptor {
  readonly name: string;
  readonly description: string;
  /** Raw JSON Schema. Passed to the model as-is; we do not re-model it. */
  readonly inputSchema: Record<string, unknown>;
}

export function initializeRequest(id: number): JsonRpcRequest {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      // No capabilities claimed: we call tools and nothing else, and claiming
      // more invites a server to send notifications nobody handles.
      capabilities: {},
      clientInfo: { name: "t3-agent", version: "1.0.0" },
    },
  };
}

export function listToolsRequest(id: number): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method: "tools/list" };
}

export function callToolRequest(id: number, name: string, args: unknown): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

/**
 * Read the tool list out of a `tools/list` result.
 *
 * Tolerant on purpose: a server that omits a description or sends a malformed
 * entry loses that entry, not the whole connection.
 */
export function parseToolList(result: unknown): ReadonlyArray<McpToolDescriptor> {
  const tools = (result as { tools?: unknown } | null)?.tools;
  if (!Array.isArray(tools)) {
    return [];
  }

  const parsed: Array<McpToolDescriptor> = [];
  for (const entry of tools) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const name = record["name"];
    if (typeof name !== "string" || name === "") {
      continue;
    }
    parsed.push({
      name,
      description: typeof record["description"] === "string" ? record["description"] : name,
      inputSchema: isRecord(record["inputSchema"])
        ? record["inputSchema"]
        : { type: "object", properties: {} },
    });
  }
  return parsed;
}

/**
 * Flatten a `tools/call` result into text.
 *
 * MCP returns a list of content blocks. The model reads text, so images and
 * other blocks are named rather than embedded — saying "[image]" is more useful
 * than silently dropping it or spending the context on base64.
 */
export function renderToolResult(result: unknown): {
  readonly text: string;
  readonly isError: boolean;
} {
  const record = result as { content?: unknown; isError?: unknown } | null;
  const isError = record?.isError === true;
  const content = record?.content;

  if (!Array.isArray(content)) {
    return { text: "", isError };
  }

  const parts: Array<string> = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) {
      continue;
    }
    const typed = block as Record<string, unknown>;
    if (typed["type"] === "text" && typeof typed["text"] === "string") {
      parts.push(typed["text"]);
      continue;
    }
    parts.push(`[${typeof typed["type"] === "string" ? typed["type"] : "unknown"} content]`);
  }

  return { text: parts.join("\n"), isError };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
