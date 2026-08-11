// @effect-diagnostics nodeBuiltinImport:off
/**
 * The containment check, with a filesystem attached.
 *
 * @module agent/tools/safePath
 */
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";

import { toolFailure, type ToolFailure } from "./failure.ts";
import { describeRejection, isWithinRoot, resolveWithinRoot } from "./paths.ts";

export interface SafePath {
  /** Real, symlink-resolved where it exists. Safe to open. */
  readonly absolutePath: string;
  /** Relative to the workspace root, `/`-separated. What we show the model. */
  readonly relativePath: string;
}

interface SafePathInput {
  readonly fileSystem: FileSystem.FileSystem;
  readonly workspaceRoot: string;
  readonly candidate: string;
}

/** Resolve a path that must already exist. */
export const resolveExisting = Effect.fnUntraced(function* (input: SafePathInput) {
  const resolved = yield* pureResolve(input);

  const real = yield* Effect.mapError(input.fileSystem.realPath(resolved.absolutePath), () =>
    toolFailure(`No such file or directory: ${resolved.relativePath}`),
  );

  return yield* confirmContained({ ...input, real, requested: resolved.relativePath });
});

/** Resolve a path that may not exist yet. */
export const resolveForWrite = Effect.fnUntraced(function* (input: SafePathInput) {
  const resolved = yield* pureResolve(input);

  let ancestor = NodePath.dirname(resolved.absolutePath);
  let realAncestor: string | null = null;
  // Bounded by the path depth: `dirname` of a root returns the root itself,
  // which ends the loop even on a malformed path.
  while (realAncestor === null) {
    const attempt = yield* Effect.option(input.fileSystem.realPath(ancestor));
    if (attempt._tag === "Some") {
      realAncestor = attempt.value;
      break;
    }
    const parent = NodePath.dirname(ancestor);
    if (parent === ancestor) {
      return yield* toolFailure(`Cannot write to ${resolved.relativePath}: no such directory.`);
    }
    ancestor = parent;
  }

  // Everything below the existing ancestor is still to be created, so it is
  // carried across verbatim. Rebuilding from the basename alone would flatten
  // `deep/nested/new.txt` onto the ancestor and write to the wrong place.
  const remainder = NodePath.relative(ancestor, resolved.absolutePath);
  const absolutePath = NodePath.join(realAncestor, remainder);

  const realRoot = yield* Effect.mapError(input.fileSystem.realPath(input.workspaceRoot), () =>
    toolFailure("The workspace directory is unavailable."),
  );
  if (!isWithinRoot(realRoot, absolutePath)) {
    return yield* toolFailure(
      `Path "${resolved.relativePath}" resolves outside the workspace. Use a path inside the project.`,
    );
  }

  return { absolutePath, relativePath: resolved.relativePath } satisfies SafePath;
});

const pureResolve = (input: SafePathInput): Effect.Effect<SafePath, ToolFailure> => {
  const resolved = resolveWithinRoot({
    root: input.workspaceRoot,
    candidate: input.candidate,
  });
  return resolved._tag === "Rejected"
    ? Effect.fail(toolFailure(describeRejection(resolved)))
    : Effect.succeed({
        absolutePath: resolved.absolutePath,
        relativePath: resolved.relativePath,
      });
};

const confirmContained = Effect.fnUntraced(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly workspaceRoot: string;
  readonly real: string;
  readonly requested: string;
}) {
  const realRoot = yield* Effect.mapError(input.fileSystem.realPath(input.workspaceRoot), () =>
    toolFailure("The workspace directory is unavailable."),
  );

  if (!isWithinRoot(realRoot, input.real)) {
    // Deliberately vague about where it actually points: the model asked for
    // something outside the workspace and does not need to learn what is there.
    return yield* toolFailure(
      `Path "${input.requested}" resolves outside the workspace. Use a path inside the project.`,
    );
  }

  return {
    absolutePath: input.real,
    relativePath: toPosix(NodePath.relative(realRoot, input.real)),
  } satisfies SafePath;
});

function toPosix(value: string): string {
  return NodePath.sep === "/" ? value : value.split(NodePath.sep).join("/");
}
