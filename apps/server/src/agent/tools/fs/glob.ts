// @effect-diagnostics nodeBuiltinImport:off
/**
 * Find files by name.
 *
 * Backed by Node's own `fs.glob`, which is why this adds no dependency. Results
 * are sorted newest-first, because when a model asks for `**\/*.test.ts` it is
 * almost always looking for the tests near the code it just touched.
 *
 * @module agent/tools/fs/glob
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";

import { ToolFailure, toolFailure } from "../failure.ts";
import { defineTool, type AgentTool, type AgentToolContext } from "../registry.ts";
import { resolveExisting } from "../safePath.ts";
import { isIgnoredPath } from "./ignore.ts";

/** Enough to see the shape of a codebase; beyond this the model should narrow. */
const MAX_RESULTS = 200;

const GlobTool = Tool.make("glob", {
  description:
    "Find files whose paths match a glob pattern, newest first. " +
    "Build output and dependency directories are skipped.",
  parameters: Schema.Struct({
    pattern: Schema.String.annotate({
      description: 'Glob pattern, e.g. "src/**/*.ts" or "**/*.test.ts".',
    }),
    path: Schema.optional(
      Schema.String.annotate({
        description: "Directory to search in. Defaults to the project root.",
      }),
    ),
  }),
  success: Schema.Struct({
    paths: Schema.Array(Schema.String),
    /** True when more files matched than were returned. */
    truncated: Schema.Boolean,
  }),
  failure: ToolFailure,
  failureMode: "return",
});

export function makeGlobTool(context: AgentToolContext): AgentTool {
  return defineTool(
    GlobTool,
    Effect.fnUntraced(function* (params) {
      const searchRoot = yield* resolveSearchRoot(context, params.path);

      const matches = yield* Effect.tryPromise({
        try: () => collectMatches(searchRoot.absolutePath, params.pattern),
        catch: () => toolFailure(`Invalid glob pattern: ${params.pattern}`),
      });

      const ranked = yield* Effect.promise(() => sortByRecency(searchRoot.absolutePath, matches));

      return {
        paths: ranked
          .slice(0, MAX_RESULTS)
          .map((relative) => joinForDisplay(searchRoot.relativePath, relative)),
        truncated: ranked.length > MAX_RESULTS,
      };
    }),
  );
}

/**
 * Resolve the directory to search, defaulting to the workspace root.
 *
 * Shared with `grep`, which takes the same optional `path` and needs the same
 * containment guarantee.
 */
export const resolveSearchRoot = Effect.fnUntraced(function* (
  context: AgentToolContext,
  path: string | undefined,
) {
  return yield* resolveExisting({
    fileSystem: context.fileSystem,
    workspaceRoot: context.workspaceRoot,
    candidate: path ?? ".",
  });
});

async function collectMatches(root: string, pattern: string): Promise<Array<string>> {
  const found: Array<string> = [];
  const iterator = NodeFSP.glob(pattern, {
    cwd: root,
    exclude: isIgnoredPath,
  });
  for await (const match of iterator) {
    found.push(match);
    // Collect a margin above the cap so `truncated` is honest without walking
    // an entire monorepo to count matches nobody will read.
    if (found.length >= MAX_RESULTS * 5) {
      break;
    }
  }
  return found;
}

/**
 * Newest first, unreadable entries last.
 *
 * A file that vanished between the walk and the `stat` is not an error worth
 * failing the tool over — it just sorts to the bottom.
 */
async function sortByRecency(root: string, matches: ReadonlyArray<string>): Promise<Array<string>> {
  const stamped = await Promise.all(
    matches.map(async (relative) => {
      try {
        const info = await NodeFSP.stat(NodePath.join(root, relative));
        return { relative, modifiedAt: info.mtimeMs, isFile: info.isFile() };
      } catch {
        return { relative, modifiedAt: 0, isFile: true };
      }
    }),
  );
  return stamped
    .filter((entry) => entry.isFile)
    .sort((left, right) => right.modifiedAt - left.modifiedAt)
    .map((entry) => entry.relative);
}

/** Paths are reported relative to the project root, not to the search directory. */
function joinForDisplay(searchRootRelative: string, matchRelative: string): string {
  const normalised = matchRelative.split(NodePath.sep).join("/");
  return searchRootRelative === "" ? normalised : `${searchRootRelative}/${normalised}`;
}
