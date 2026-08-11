// @effect-diagnostics nodeBuiltinImport:off
/**
 * Keeping tools inside the workspace.
 *
 * Every file tool takes a path from the model, and the model is not a trusted
 * caller. This module is the one place that decides whether a path is allowed,
 * expressed as pure string arithmetic so the rule can be tested exhaustively
 * without a filesystem.
 *
 * ## Two checks, not one
 *
 * String containment alone is not sufficient: `<root>/link` may be a symlink
 * pointing at `/etc`, and no amount of `path.resolve` will notice. So callers
 * check twice — {@link resolveWithinRoot} before touching the disk, which is
 * cheap and rejects the obvious cases, and {@link isWithinRoot} again on the
 * path returned by `realpath`, which is authoritative. The pre-check is an
 * optimisation and a better error message; the post-check is the security
 * boundary. A tool that skips the second one has a hole in it.
 *
 * ## Why not `WorkspacePaths.resolveRelativePathWithinRoot`
 *
 * That service answers a deliberately stricter question, for the file tree: it
 * refuses absolute paths outright and refuses the root itself. Both are correct
 * there and wrong here — a model routinely emits an absolute path it read out
 * of a stack trace, and `glob` legitimately starts at the root. This module
 * also returns a value rather than failing an `Effect`, because tool handlers
 * run with `failureMode: "return"` and need the rejection as data.
 *
 * @module agent/tools/paths
 */
import * as NodePath from "node:path";

export type PathRejection =
  /** Resolved outside the workspace root — traversal, or an unrelated absolute path. */
  | "outside_root"
  /** Empty or whitespace-only. */
  | "empty"
  /** Contains a NUL byte, which the filesystem layer would reject anyway. */
  | "nul_byte";

export type ResolvedPath =
  | {
      readonly _tag: "Allowed";
      /** Absolute, normalised. Safe to hand to the filesystem. */
      readonly absolutePath: string;
      /** Relative to the root, `/`-separated, for display. `""` means the root itself. */
      readonly relativePath: string;
    }
  | {
      readonly _tag: "Rejected";
      readonly reason: PathRejection;
      /** What the caller asked for, echoed back for the error message. */
      readonly requested: string;
    };

/**
 * Is `candidate` the root or somewhere beneath it?
 *
 * Both arguments must already be absolute and normalised. This is the check to
 * re-run against a `realpath` result — it is the authoritative one.
 */
export function isWithinRoot(root: string, candidate: string): boolean {
  const normalisedRoot = NodePath.resolve(root);
  const normalisedCandidate = NodePath.resolve(candidate);
  if (normalisedCandidate === normalisedRoot) {
    return true;
  }
  // `relative` is the reliable test: a prefix comparison would let
  // `/workspace-backup` pass as being inside `/workspace`.
  const relative = NodePath.relative(normalisedRoot, normalisedCandidate);
  return relative !== "" && !relative.startsWith("..") && !NodePath.isAbsolute(relative);
}

/**
 * Resolve a model-supplied path against the workspace root.
 *
 * Relative paths are taken as relative to the root, which is what a model means
 * by `src/index.ts`. Absolute paths are honoured but still have to land inside
 * the root, so pasting `/etc/passwd` fails the same way `../../etc/passwd` does.
 */
export function resolveWithinRoot(input: {
  readonly root: string;
  readonly candidate: string;
}): ResolvedPath {
  const requested = input.candidate;

  if (requested.includes("\0")) {
    return { _tag: "Rejected", reason: "nul_byte", requested };
  }
  if (requested.trim() === "") {
    return { _tag: "Rejected", reason: "empty", requested };
  }

  const root = NodePath.resolve(input.root);
  const absolutePath = NodePath.isAbsolute(requested)
    ? NodePath.normalize(requested)
    : NodePath.resolve(root, requested);

  if (!isWithinRoot(root, absolutePath)) {
    return { _tag: "Rejected", reason: "outside_root", requested };
  }

  return {
    _tag: "Allowed",
    absolutePath,
    relativePath: toPosix(NodePath.relative(root, absolutePath)),
  };
}

/**
 * The sentence the model sees when a path is refused.
 *
 * Written to be actionable: the model should learn what to do differently, not
 * just that something went wrong. It never echoes an absolute path outside the
 * root back into the transcript.
 */
export function describeRejection(rejection: {
  readonly reason: PathRejection;
  readonly requested: string;
}): string {
  switch (rejection.reason) {
    case "outside_root":
      return `Path "${rejection.requested}" is outside the workspace. Use a path inside the project.`;
    case "empty":
      return "Path is empty. Provide a path relative to the project root.";
    case "nul_byte":
      return "Path contains an invalid character.";
  }
}

/** Display paths are always `/`-separated, whatever the host does. */
function toPosix(value: string): string {
  return NodePath.sep === "/" ? value : value.split(NodePath.sep).join("/");
}
