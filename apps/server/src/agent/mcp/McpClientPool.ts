/**
 * Connections to the user's MCP servers.
 *
 * One pool per agent instance, holding one connection per configured server.
 * The rule that shapes everything here: **a broken MCP server must never break
 * a turn.** Third-party servers are the least reliable thing in the loop — they
 * are other people's subprocesses — so every failure path ends in a warning and
 * zero tools, never in a failed effect.
 *
 * Byte caps exist for the same reason. A server that returns a megabyte of JSON
 * would otherwise spend the user's context and money on one tool call.
 *
 * ## Why there is no MCP dependency here
 *
 * MCP's stdio transport is JSON-RPC 2.0 as newline-delimited JSON, and this
 * agent uses three of its methods. Taking the official SDK would add a package
 * to a repository whose selling point for this feature is that it added none,
 * to save well-specified framing. Resources, prompts, sampling, and OAuth are
 * out of scope — a server needing them is unsupported rather than
 * half-supported, and says so.
 *
 * @module agent/mcp/McpClientPool
 */
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { mcpServerError, type McpServerError } from "./errors.ts";
import {
  callToolRequest,
  initializeRequest,
  listToolsRequest,
  parseToolList,
  renderToolResult,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpToolDescriptor,
} from "./protocol.ts";
import { enabledServers, type McpServerConfig, type McpServers } from "./serverConfig.ts";

/** Per tool call. Beyond this the result is clipped and says so. */
const MAX_RESULT_BYTES = 8 * 1024;
/** Per server, across its whole tool list. One server cannot flood the prompt. */
const MAX_CATALOG_BYTES = 64 * 1024;
/** A server that cannot start and list its tools in this long is unavailable. */
const STARTUP_TIMEOUT = Duration.seconds(15);
/** A single tool call that hangs must not hang the turn behind it. */
const CALL_TIMEOUT = Duration.seconds(120);

export interface McpServerStatus {
  readonly name: string;
  readonly state: "ready" | "failed";
  readonly toolCount: number;
  /** Why it failed, for the warning shown to the user. */
  readonly detail?: string | undefined;
}

export interface ConnectedServer {
  readonly name: string;
  readonly tools: ReadonlyArray<McpToolDescriptor>;
  readonly call: (
    toolName: string,
    args: unknown,
  ) => Effect.Effect<{ readonly text: string; readonly isError: boolean }>;
}

export interface McpPool {
  readonly servers: ReadonlyArray<ConnectedServer>;
  readonly statuses: ReadonlyArray<McpServerStatus>;
}

export const EMPTY_POOL: McpPool = { servers: [], statuses: [] };

/**
 * Connect to every enabled server, tolerating any that will not come up.
 *
 * Returns what did connect plus a status per server. Never fails.
 */
export const connectAll = Effect.fnUntraced(function* (input: {
  readonly servers: McpServers;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly baseEnv: Record<string, string>;
  readonly workspaceRoot: string;
}) {
  const connected: Array<ConnectedServer> = [];
  const statuses: Array<McpServerStatus> = [];

  for (const { name, config } of enabledServers(input.servers)) {
    const attempt = yield* Effect.result(
      connectOne({ name, config, ...input }).pipe(
        Effect.timeoutOption(STARTUP_TIMEOUT),
        Effect.catchDefect(
          (defect): Effect.Effect<never, McpServerError> => Effect.fail(asError(name, defect)),
        ),
      ),
    );

    if (attempt._tag === "Failure") {
      statuses.push({ name, state: "failed", toolCount: 0, detail: attempt.failure.message });
      continue;
    }
    if (attempt.success._tag === "None") {
      statuses.push({
        name,
        state: "failed",
        toolCount: 0,
        detail: "did not start and list its tools in time",
      });
      continue;
    }

    const server = attempt.success.value;
    connected.push(server);
    statuses.push({ name, state: "ready", toolCount: server.tools.length });
  }

  return { servers: connected, statuses } satisfies McpPool;
});

const connectOne = Effect.fnUntraced(function* (input: {
  readonly name: string;
  readonly config: McpServerConfig;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly baseEnv: Record<string, string>;
  readonly workspaceRoot: string;
}) {
  if (input.config.transport !== "stdio") {
    // Honest about the gap rather than half-supporting it: a remote server
    // usually also wants OAuth, and a broken auth flow is worse than a clear no.
    return yield* Effect.fail(mcpServerError(input.name, "HTTP MCP servers are not supported yet"));
  }

  // The outbound queue is created before the spawn because the child's stdin is
  // a stream supplied at construction — there is no writing to it afterwards.
  const outbound = yield* Queue.unbounded<string>();

  const child = yield* Effect.mapError(
    input.spawner.spawn(
      ChildProcess.make(input.config.command, [...(input.config.args ?? [])], {
        cwd: input.workspaceRoot,
        env: { ...input.baseEnv, ...(input.config.env ?? {}) },
        stdin: { stream: Stream.encodeText(Stream.fromQueue(outbound)) },
      }),
    ),
    (cause) => mcpServerError(input.name, `could not start: ${describe(cause)}`),
  );

  const pending = new Map<number, Deferred.Deferred<JsonRpcResponse>>();
  let counter = 0;

  // One reader fiber demultiplexes replies by id. It lives in the pool's scope,
  // so it goes away with the instance rather than leaking per turn.
  yield* Effect.forkScoped(
    Stream.runForEach(Stream.splitLines(Stream.decodeText(child.stdout)), (line) => {
      const response = parseResponse(line);
      if (response === null) {
        return Effect.void;
      }
      const waiting = pending.get(response.id);
      if (waiting === undefined) {
        return Effect.void;
      }
      pending.delete(response.id);
      return Deferred.succeed(waiting, response);
    }).pipe(Effect.ignore),
  );

  const request = Effect.fnUntraced(function* (build: (id: number) => JsonRpcRequest) {
    counter += 1;
    const id = counter;
    const waiting = yield* Deferred.make<JsonRpcResponse>();
    pending.set(id, waiting);

    yield* Queue.offer(outbound, `${encodeJson(build(id))}\n`);

    const response = yield* Effect.ensuring(
      Deferred.await(waiting),
      Effect.sync(() => {
        pending.delete(id);
      }),
    );

    if (response.error !== undefined) {
      return yield* Effect.fail(mcpServerError(input.name, response.error.message));
    }
    return response.result;
  });

  yield* request(initializeRequest);
  const listed = parseToolList(yield* request(listToolsRequest));
  if (listed._tag === "Unreadable") {
    // Failing the connection rather than continuing with no tools. A server we
    // cannot understand is not a server offering nothing, and reporting it as
    // the latter is how a broken connection comes to look like a working one.
    return yield* Effect.fail(mcpServerError(input.name, listed.reason));
  }
  const tools = capCatalog(listed.tools);

  return {
    name: input.name,
    tools,
    call: (toolName: string, args: unknown) =>
      request((id) => callToolRequest(id, toolName, args)).pipe(
        Effect.timeoutOption(CALL_TIMEOUT),
        Effect.map((result) =>
          result._tag === "None"
            ? { text: "The tool did not respond in time.", isError: true }
            : withClipping(renderToolResult(result.value)),
        ),
        // A failed tool call is a result the model can read and work around,
        // never a reason to end the turn.
        Effect.catchCause((cause) =>
          Effect.succeed({ text: `The tool failed: ${describe(cause)}`, isError: true }),
        ),
      ),
  } satisfies ConnectedServer;
});

function withClipping(rendered: { readonly text: string; readonly isError: boolean }) {
  return { text: clip(rendered.text), isError: rendered.isError };
}

/** Trim a server's tool list so one server cannot dominate the prompt. */
function capCatalog(tools: ReadonlyArray<McpToolDescriptor>): ReadonlyArray<McpToolDescriptor> {
  const kept: Array<McpToolDescriptor> = [];
  let bytes = 0;
  for (const tool of tools) {
    const size = Buffer.byteLength(encodeJson(tool), "utf8");
    if (bytes + size > MAX_CATALOG_BYTES) {
      break;
    }
    bytes += size;
    kept.push(tool);
  }
  return kept;
}

function clip(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= MAX_RESULT_BYTES) {
    return text;
  }
  return `${text.slice(0, MAX_RESULT_BYTES)}\n… result truncated …`;
}

const JsonLine = Schema.fromJsonString(Schema.Unknown);
const decodeJson = Schema.decodeUnknownSync(JsonLine);

/** Encoding is total here: every value written is one we just constructed. */
const encodeJson = Schema.encodeSync(JsonLine);

/**
 * A line the server sent.
 *
 * Anything unparseable is dropped rather than raised: servers write progress
 * chatter and log lines to stdout, and one of those must not kill the reader.
 */
function parseResponse(line: string): JsonRpcResponse | null {
  if (line.trim() === "") {
    return null;
  }
  try {
    const parsed = decodeJson(line) as JsonRpcResponse;
    // Notifications carry no id and nothing is waiting on them.
    return typeof parsed?.id === "number" ? parsed : null;
  } catch {
    return null;
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function asError(serverName: string, defect: unknown): McpServerError {
  return mcpServerError(serverName, defect instanceof Error ? defect.message : String(defect));
}
