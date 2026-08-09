// @effect-diagnostics nodeBuiltinImport:off
/**
 * Project instructions, read from the repository.
 *
 * Every agent has settled on a markdown file at the repo root holding the
 * project's own rules, and every one of them picked a different name. Reading
 * all of the common ones costs one directory listing and means a user who
 * already wrote `CLAUDE.md` for another tool does not have to write it again.
 *
 * Failure is never fatal. A missing file is the normal case; an unreadable one
 * is the user's problem to see in a warning, not a reason the turn cannot run.
 *
 * @module agent/prompt/agentsMd
 */
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";

/**
 * Checked in order, and all matches are used.
 *
 * A repo with both `AGENTS.md` and `CLAUDE.md` usually has them saying
 * different things on purpose, and silently ignoring one is worse than
 * including both.
 */
export const PROJECT_INSTRUCTION_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  ".cursorrules",
  ".github/copilot-instructions.md",
] as const;

/** Past this, we take the head and say so. Instructions are charged every step. */
const MAX_BYTES_PER_FILE = 32 * 1024;

export interface ProjectContext {
  /** Concatenated contents, ready to append to the system prompt. */
  readonly text: string;
  /** Which files contributed, for a warning or a debug log. */
  readonly sources: ReadonlyArray<string>;
}

export const EMPTY_PROJECT_CONTEXT: ProjectContext = { text: "", sources: [] };

/**
 * Read whichever instruction files this repository has.
 *
 * Never fails: an unreadable file is skipped, because a turn that refuses to
 * start over a permissions problem on an optional file is a worse outcome than
 * a turn that runs without project-specific guidance.
 */
export const readProjectContext = Effect.fnUntraced(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly workspaceRoot: string;
}) {
  const parts: Array<string> = [];
  const sources: Array<string> = [];

  for (const relativePath of PROJECT_INSTRUCTION_FILES) {
    const absolute = NodePath.join(input.workspaceRoot, relativePath);
    const content = yield* Effect.option(input.fileSystem.readFileString(absolute));
    if (content._tag === "None" || content.value.trim() === "") {
      continue;
    }
    sources.push(relativePath);
    parts.push(`--- ${relativePath} ---\n${clip(content.value)}`);
  }

  return { text: parts.join("\n\n"), sources } satisfies ProjectContext;
});

function clip(content: string): string {
  if (Buffer.byteLength(content, "utf8") <= MAX_BYTES_PER_FILE) {
    return content;
  }
  return `${content.slice(0, MAX_BYTES_PER_FILE)}\n\n[truncated — this file is longer than the agent reads]`;
}
