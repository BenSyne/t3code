// @effect-diagnostics nodeBuiltinImport:off
/**
 * Keeping tools inside the workspace.
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

/** Is `candidate` the root or somewhere beneath it? */
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

/** Resolve a model-supplied path against the workspace root. */
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

/** The sentence the model sees when a path is refused. */
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
