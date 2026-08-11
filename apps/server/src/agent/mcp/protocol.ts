/**
 * The bits of MCP this agent needs, and nothing more.
 *
 * @module agent/mcp/protocol
 */
import * as Schema from "effect/Schema";
import * as McpSchema from "effect/unstable/ai/McpSchema";

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

/** One tool as an MCP server describes it, reduced to what the toolkit needs. */
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

/** Just enough of the envelope to find the tools. */
const ToolListEnvelope = Schema.Struct({ tools: Schema.Array(Schema.Unknown) });
const decodeEnvelope = Schema.decodeUnknownOption(ToolListEnvelope);
const decodeTool = Schema.decodeUnknownOption(McpSchema.Tool);

/** A tool result's envelope, with its blocks left undecoded. */
const CallResultEnvelope = Schema.Struct({
  content: Schema.Array(Schema.Unknown),
  isError: Schema.optional(Schema.Boolean),
});
const decodeCallResult = Schema.decodeUnknownOption(CallResultEnvelope);
const decodeTextBlock = Schema.decodeUnknownOption(McpSchema.TextContent);
const decodeBlockKind = Schema.decodeUnknownOption(Schema.Struct({ type: Schema.String }));

/** A `tools/list` result: either the catalogue, or why we could not read one. */
export type ToolListOutcome =
  | { readonly _tag: "Tools"; readonly tools: ReadonlyArray<McpToolDescriptor> }
  | { readonly _tag: "Unreadable"; readonly reason: string };

/** Read the tool list, strict about the envelope and forgiving about entries. */
export function parseToolList(result: unknown): ToolListOutcome {
  const envelope = decodeEnvelope(result);
  if (envelope._tag === "None") {
    return { _tag: "Unreadable", reason: "its tools/list response had no tool list" };
  }

  const tools: Array<McpToolDescriptor> = [];
  for (const entry of envelope.value.tools) {
    const decoded = decodeTool(entry);
    if (decoded._tag === "None") {
      continue;
    }
    const tool = decoded.value;
    tools.push({
      name: tool.name,
      // A tool with no description still gets offered: the model can often
      // infer the job from a good name, and dropping it helps nobody.
      description: tool.description ?? tool.name,
      inputSchema: isRecord(tool.inputSchema)
        ? tool.inputSchema
        : { type: "object", properties: {} },
    });
  }
  return { _tag: "Tools", tools };
}

/** Flatten a `tools/call` result into text. */
export function renderToolResult(result: unknown): {
  readonly text: string;
  readonly isError: boolean;
} {
  const decoded = decodeCallResult(result);
  if (decoded._tag === "None") {
    return { text: "The tool returned a result this agent could not read.", isError: true };
  }

  const parts = decoded.value.content.map((block) => {
    const text = decodeTextBlock(block);
    if (text._tag === "Some") {
      return text.value.text;
    }
    // Named by its own `type` where it has one. A block we cannot decode is
    // still worth mentioning: "[image content]" tells the model something
    // came back, where silence would suggest the tool returned nothing.
    const kind = decodeBlockKind(block);
    return `[${kind._tag === "Some" ? kind.value.type : "unknown"} content]`;
  });
  return { text: parts.join("\n"), isError: decoded.value.isError ?? false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
