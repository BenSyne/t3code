// @effect-diagnostics nodeBuiltinImport:off
/**
 * Project instructions, read from the repository.
 *
 * @module agent/prompt/agentsMd
 */
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";

/** Checked in order, and all matches are used. */
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

/** Read whichever instruction files this repository has. */
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
