/**
 * Which tools a turn can call, and where they come from.
 *
 * The loop never names a tool — it asks the registry for a toolkit and runs
 * whatever it gets back, so MCP servers, skills and cross-provider
 * orchestration can arrive later as {@link ToolContributor}s without the loop
 * changing.
 *
 * A registry whose contents are decided at runtime cannot be a statically-keyed
 * record, so the tool/handler pair is erased here and re-associated by name.
 * {@link defineTool} is the only way to build a pair and is fully typed, which
 * keeps the erasure contained to {@link buildToolkit}.
 *
 * @module agent/tools/registry
 */
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as AiError from "effect/unstable/ai/AiError";
import type * as Schema from "effect/Schema";
import type * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { toolFailure, type ToolFailure } from "./failure.ts";

/**
 * What a tool is allowed to reach.
 *
 * Services are resolved once when the session is built and handed over as plain
 * values, so handlers have no requirements of their own and `runTurn` stays
 * runnable against a stub with no platform layer.
 */
export interface AgentToolContext {
  /** Absolute path every file tool is confined to. */
  readonly workspaceRoot: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  /** From the provider instance, so commands see the same `PATH` and credentials. */
  readonly commandEnv: Record<string, string>;
  /**
   * Wrapped around handlers by {@link withApproval} rather than called inside
   * them: forgetting to ask then means no approval path at all rather than a
   * broken one.
   */
  readonly requestApproval: (input: {
    readonly toolName: string;
    readonly target: string;
  }) => Effect.Effect<ApprovalOutcome>;
}

export type ApprovalOutcome =
  | { readonly _tag: "Allowed" }
  | { readonly _tag: "Denied"; readonly reason: string };

/** A tool paired with the handler that runs it. Build one with {@link defineTool}. */
export interface AgentTool {
  readonly tool: Tool.Any;
  readonly handler: ErasedHandler;
}

/**
 * The success type genuinely varies per tool and is erased; the failure type
 * does not, and naming it keeps `unknown` out of the error channel where it
 * would disable the checking that catches an unhandled failure.
 */
type ErasedHandler = (
  params: never,
  context: never,
) => Effect.Effect<unknown, ToolFailure | AiError.AiError>;

/**
 * Pair a tool with its handler, checked against that tool's own schemas.
 *
 * Tools are built with `failureMode: "return"`, so a declared failure reaches
 * the model as a readable result. A *defect* bypasses that entirely and takes
 * the turn down — and a tool is the least trustworthy code in the loop, since
 * MCP servers are third-party by definition. So every handler is wrapped to
 * turn a defect into an ordinary tool failure.
 */
export function defineTool<T extends Tool.Any>(
  tool: T,
  handler: (
    params: Tool.Parameters<T>,
    context: Toolkit.HandlerContext<T>,
  ) => Effect.Effect<Tool.Success<T>, Tool.Failure<T> | AiError.AiError>,
): AgentTool {
  const contained = (params: Tool.Parameters<T>, context: Toolkit.HandlerContext<T>) =>
    Effect.catchDefect(handler(params, context), (defect) =>
      Effect.fail(
        toolFailure(`The ${tool.name} tool failed unexpectedly: ${describeDefect(defect)}`),
      ),
    );
  return { tool, handler: contained as ErasedHandler };
}

/**
 * Gate a tool behind approval.
 *
 * Wraps an already-defined tool so its handler cannot be written in a way that
 * skips permissions. A denial comes back as an ordinary tool failure, which the
 * model can respond to rather than infer from a crash.
 */
export function withApproval(
  entry: AgentTool,
  context: AgentToolContext,
  describeTarget: (params: never) => string,
): AgentTool {
  const gated: ErasedHandler = (params, handlerContext) =>
    Effect.flatMap(
      context.requestApproval({
        toolName: entry.tool.name,
        target: describeTarget(params),
      }),
      (outcome): Effect.Effect<unknown, ToolFailure | AiError.AiError> =>
        outcome._tag === "Allowed"
          ? entry.handler(params, handlerContext)
          : Effect.fail(toolFailure(outcome.reason)),
    );
  return { tool: entry.tool, handler: gated };
}

/** One line, no stack: the model cannot act on a stack trace and pays for it. */
function describeDefect(defect: unknown): string {
  if (defect instanceof Error && defect.message !== "") {
    return defect.message;
  }
  return typeof defect === "string" && defect !== "" ? defect : "unknown error";
}

/**
 * A source of tools.
 *
 * Contributors are constructed with their services already provided, so
 * contributing cannot fail — a broken MCP server yields zero tools and a
 * warning rather than taking the turn down.
 */
export interface ToolContributor {
  /** Identifies the source in warnings, e.g. `"core"`, `"mcp:github"`. */
  readonly name: string;
  readonly tools: (context: AgentToolContext) => Effect.Effect<ReadonlyArray<AgentTool>>;
}

/** A tool that was dropped because something earlier claimed its name. */
export interface DroppedTool {
  readonly toolName: string;
  readonly contributor: string;
  readonly keptFrom: string;
}

export interface ResolvedTools {
  readonly tools: ReadonlyArray<AgentTool>;
  /**
   * Surfaced rather than resolved silently: an MCP server that shadows
   * `read_file` changes what the agent does to your disk.
   */
  readonly dropped: ReadonlyArray<DroppedTool>;
}

/**
 * Ask every contributor for its tools, first claim on a name wins. Order is the
 * priority order — core tools are listed first so nothing discovered at runtime
 * can take their names.
 */
export const resolveTools = Effect.fnUntraced(function* (
  contributors: ReadonlyArray<ToolContributor>,
  context: AgentToolContext,
) {
  const tools: Array<AgentTool> = [];
  const dropped: Array<DroppedTool> = [];
  const claimedBy = new Map<string, string>();

  for (const contributor of contributors) {
    const contributed = yield* contributor.tools(context);
    for (const candidate of contributed) {
      const name = candidate.tool.name;
      const owner = claimedBy.get(name);
      if (owner !== undefined) {
        dropped.push({ toolName: name, contributor: contributor.name, keptFrom: owner });
        continue;
      }
      claimedBy.set(name, contributor.name);
      tools.push(candidate);
    }
  }

  return { tools, dropped } satisfies ResolvedTools;
});

/**
 * `Tool.Any` with the requirements pinned to `never`.
 *
 * `Tool.Any` leaves them `any`, which spreads through every caller and disables
 * the checking that stops a service going unprovided. `defineTool` already
 * guarantees handlers need nothing, so stating it here loses no information.
 */
export interface SelfContainedTool extends Tool.Tool<
  string,
  {
    // `Schema.Top` would leave the decoding services `unknown`, which the
    // requirements channel picks up just as readily as `any`.
    readonly parameters: SelfContainedSchema;
    readonly success: SelfContainedSchema;
    readonly failure: SelfContainedSchema;
    readonly failureMode: Tool.FailureMode;
  },
  never
> {}

type SelfContainedSchema = Schema.Codec<any, any, never, never>;

export type AgentToolkit = Toolkit.WithHandler<Record<string, SelfContainedTool>>;

/** Turn resolved tools into something `streamText` accepts. */
export function buildToolkit(tools: ReadonlyArray<AgentTool>): Effect.Effect<AgentToolkit> {
  const toolkit = Toolkit.make(...tools.map((entry) => entry.tool));
  const handlers: Record<string, ErasedHandler> = {};
  for (const entry of tools) {
    handlers[entry.tool.name] = entry.handler;
  }
  // See the module note: names are known only at runtime, so the record cannot
  // be checked against the toolkit's key type. `defineTool` already checked
  // every handler against its own tool.
  return Effect.provide(
    toolkit,
    toolkit.toLayer(handlers as never),
  ) as unknown as Effect.Effect<AgentToolkit>;
}
