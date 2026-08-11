// @effect-diagnostics nodeBuiltinImport:off
/**
 * Search file contents by regular expression.
 *
 * @module agent/tools/fs/grep
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";

import { ToolFailure, toolFailure } from "../failure.ts";
import { defineTool, type AgentTool, type AgentToolContext } from "../registry.ts";
import { resolveSearchRoot } from "./glob.ts";
import { isIgnoredPath } from "./ignore.ts";
import { optionalParam } from "../optionalParam.ts";

const MAX_MATCHES = 100;
const MAX_FILES_SCANNED = 5000;
/** Files above this are treated as data, not source. */
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_LINE_LENGTH = 400;

const GrepTool = Tool.make("grep", {
  description:
    "Search file contents with a regular expression. Returns matching lines with their file and line number. " +
    "Build output and dependency directories are skipped.",
  parameters: Schema.Struct({
    pattern: Schema.String.annotate({
      description: 'JavaScript regular expression, e.g. "function\\\\s+parse".',
    }),
    path: optionalParam(
      Schema.String.annotate({
        description: "Directory to search in. Defaults to the project root.",
      }),
    ),
    include: optionalParam(
      Schema.String.annotate({
        description: 'Glob limiting which files are searched, e.g. "**/*.ts".',
      }),
    ),
    caseInsensitive: optionalParam(
      Schema.Boolean.annotate({ description: "Ignore case. Defaults to false." }),
    ),
  }),
  success: Schema.Struct({
    matches: Schema.Array(
      Schema.Struct({
        path: Schema.String,
        line: Schema.Number,
        text: Schema.String,
      }),
    ),
    filesSearched: Schema.Number,
    /** True when the search stopped at a cap rather than at the end. */
    truncated: Schema.Boolean,
  }),
  failure: ToolFailure,
  failureMode: "return",
});

export function makeGrepTool(context: AgentToolContext): AgentTool {
  return defineTool(
    GrepTool,
    Effect.fnUntraced(function* (params) {
      const searchRoot = yield* resolveSearchRoot(context, params.path);

      const matcher = compilePattern(params.pattern, params.caseInsensitive ?? false);
      if (matcher._tag === "Invalid") {
        return yield* toolFailure(matcher.message);
      }

      return yield* Effect.promise(() =>
        search({
          root: searchRoot.absolutePath,
          displayPrefix: searchRoot.relativePath,
          include: params.include ?? "**/*",
          matcher: matcher.regex,
        }),
      );
    }),
  );
}

type CompiledPattern =
  | { readonly _tag: "Compiled"; readonly regex: RegExp }
  | { readonly _tag: "Invalid"; readonly message: string };

/** Compile the model's pattern, reporting a bad one as a tool failure. */
export function compilePattern(pattern: string, caseInsensitive: boolean): CompiledPattern {
  try {
    return { _tag: "Compiled", regex: new RegExp(pattern, caseInsensitive ? "i" : "") };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : "not a valid regular expression";
    return { _tag: "Invalid", message: `Invalid pattern "${pattern}": ${detail}` };
  }
}

interface SearchResult {
  readonly matches: ReadonlyArray<{
    readonly path: string;
    readonly line: number;
    readonly text: string;
  }>;
  readonly filesSearched: number;
  readonly truncated: boolean;
}

async function search(input: {
  readonly root: string;
  readonly displayPrefix: string;
  readonly include: string;
  readonly matcher: RegExp;
}): Promise<SearchResult> {
  const matches: Array<{ path: string; line: number; text: string }> = [];
  let filesSearched = 0;
  let truncated = false;

  const iterator = NodeFSP.glob(input.include, {
    cwd: input.root,
    exclude: isIgnoredPath,
  });

  for await (const relative of iterator) {
    if (filesSearched >= MAX_FILES_SCANNED) {
      truncated = true;
      break;
    }

    const absolute = NodePath.join(input.root, relative);
    const content = await readSearchableFile(absolute);
    if (content === null) {
      continue;
    }
    filesSearched += 1;

    const displayPath = joinForDisplay(input.displayPrefix, relative);
    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      // `lastIndex` never advances because the pattern is compiled without
      // the global flag, so `test` is safe to call in a loop.
      if (!input.matcher.test(line)) {
        continue;
      }
      if (matches.length >= MAX_MATCHES) {
        return { matches, filesSearched, truncated: true };
      }
      matches.push({ path: displayPath, line: index + 1, text: clip(line) });
    }
  }

  return { matches, filesSearched, truncated };
}

/** Returns null for anything that is not worth searching, without complaining. */
async function readSearchableFile(absolutePath: string): Promise<string | null> {
  try {
    const info = await NodeFSP.stat(absolutePath);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) {
      return null;
    }
    const content = await NodeFSP.readFile(absolutePath, "utf8");
    return content.includes("\0") ? null : content;
  } catch {
    return null;
  }
}

const clip = (line: string): string =>
  line.length <= MAX_LINE_LENGTH ? line : `${line.slice(0, MAX_LINE_LENGTH)}…`;

function joinForDisplay(prefix: string, relative: string): string {
  const normalised = relative.split(NodePath.sep).join("/");
  return prefix === "" ? normalised : `${prefix}/${normalised}`;
}
