/**
 * Read a file.
 *
 * The most-used tool by a wide margin, so its defaults matter: it numbers lines
 * (models cite them, and `edit` needs them to agree), it caps how much of a
 * large file comes back, and it says plainly when it truncated rather than
 * letting the model believe it saw the whole thing.
 *
 * @module agent/tools/fs/read
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";

import { describeFileSystemFailure, ToolFailure, toolFailure } from "../failure.ts";
import { defineTool, type AgentTool, type AgentToolContext } from "../registry.ts";
import { resolveExisting } from "../safePath.ts";
import { optionalParam } from "../optionalParam.ts";

/** Lines returned when the model does not ask for a range. */
const DEFAULT_LINE_LIMIT = 2000;
/**
 * Above this, we refuse rather than truncate. A minified bundle is one line of
 * two megabytes: truncating it produces garbage that looks like content, and
 * the model is better served by being told to search instead.
 */
const MAX_BYTES = 2 * 1024 * 1024;
/** Longer lines are clipped individually, so one huge line cannot flood a turn. */
const MAX_LINE_LENGTH = 2000;

const ReadTool = Tool.make("read", {
  description:
    "Read a text file from the project. Returns the file's contents with line numbers. " +
    "Use `offset` and `limit` to page through a long file.",
  parameters: Schema.Struct({
    filePath: Schema.String.annotate({
      description: "Path to the file, absolute or relative to the project root.",
    }),
    offset: optionalParam(
      Schema.Number.annotate({ description: "1-based line to start from. Defaults to 1." }),
    ),
    limit: optionalParam(
      Schema.Number.annotate({
        description: `Maximum lines to return. Defaults to ${DEFAULT_LINE_LIMIT}.`,
      }),
    ),
  }),
  success: Schema.Struct({
    content: Schema.String,
    totalLines: Schema.Number,
    /** True when the response stops short of the end of the file. */
    truncated: Schema.Boolean,
  }),
  failure: ToolFailure,
  failureMode: "return",
});

export function makeReadTool(context: AgentToolContext): AgentTool {
  return defineTool(
    ReadTool,
    Effect.fnUntraced(function* (params) {
      const target = yield* resolveExisting({
        fileSystem: context.fileSystem,
        workspaceRoot: context.workspaceRoot,
        candidate: params.filePath,
      });

      const info = yield* Effect.mapError(context.fileSystem.stat(target.absolutePath), (cause) =>
        describeFileSystemFailure({
          cause,
          displayPath: target.relativePath,
          operation: "read",
        }),
      );

      if (info.type === "Directory") {
        return yield* toolFailure(
          `${target.relativePath} is a directory. Use glob to list its contents.`,
        );
      }
      if (info.size > BigInt(MAX_BYTES)) {
        return yield* toolFailure(
          `${target.relativePath} is ${formatBytes(info.size)}, too large to read. Use grep to find what you need.`,
        );
      }

      const raw = yield* Effect.mapError(
        context.fileSystem.readFileString(target.absolutePath),
        (cause) =>
          describeFileSystemFailure({
            cause,
            displayPath: target.relativePath,
            operation: "read",
          }),
      );

      if (looksBinary(raw)) {
        return yield* toolFailure(`${target.relativePath} appears to be a binary file.`);
      }

      return formatSlice(raw, params.offset, params.limit);
    }),
  );
}

/**
 * Take the requested window of lines and number them.
 *
 * Exported for its own test: the off-by-one risk in 1-based offsets is real,
 * and `edit` depends on these numbers meaning what they say.
 */
export function formatSlice(
  raw: string,
  offset: number | undefined,
  limit: number | undefined,
): { readonly content: string; readonly totalLines: number; readonly truncated: boolean } {
  const lines = raw.split("\n");
  // A trailing newline produces a final empty element that is not a line.
  const totalLines =
    lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;

  const start = Math.max(0, (offset ?? 1) - 1);
  const count = Math.max(0, limit ?? DEFAULT_LINE_LIMIT);
  const end = Math.min(totalLines, start + count);

  const numbered: Array<string> = [];
  for (let index = start; index < end; index += 1) {
    numbered.push(`${index + 1}\t${clip(lines[index] ?? "")}`);
  }

  return {
    content: numbered.join("\n"),
    totalLines,
    truncated: end < totalLines,
  };
}

const clip = (line: string): string =>
  line.length <= MAX_LINE_LENGTH ? line : `${line.slice(0, MAX_LINE_LENGTH)}… [line truncated]`;

/**
 * A NUL byte in the first few kilobytes means binary. Cheap and reliable: no
 * text encoding we care about produces one.
 */
function looksBinary(raw: string): boolean {
  return raw.slice(0, 8192).includes("\0");
}

function formatBytes(size: bigint): string {
  const megabytes = Number(size) / (1024 * 1024);
  return `${megabytes.toFixed(1)} MB`;
}
