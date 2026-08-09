// @effect-diagnostics nodeBuiltinImport:off
/**
 * Conversations that survive a restart.
 *
 * Sessions live in memory, which is fine until the server restarts and every
 * thread the user was working in becomes an empty box that still appears in
 * their sidebar. This writes each thread's conversation to a file so it can be
 * picked up again.
 *
 * NDJSON, one message per line, appended. A crash mid-write costs the last
 * line rather than the file: the reader skips a line it cannot parse and keeps
 * the rest, which is the property a rewrite-the-whole-file format does not have.
 *
 * @module agent/state/TranscriptStore
 */
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type { ThreadId } from "@t3tools/contracts";
import * as Prompt from "effect/unstable/ai/Prompt";

export interface TranscriptStore {
  /** Append messages for a thread. Never fails: losing history is not worth losing a turn. */
  readonly append: (
    threadId: ThreadId,
    messages: ReadonlyArray<Prompt.Message>,
  ) => Effect.Effect<void>;
  /** Read a thread back, or an empty prompt if there is nothing to read. */
  readonly read: (threadId: ThreadId) => Effect.Effect<Prompt.Prompt>;
  /** Replace a thread's file wholesale. Used after compaction and rollback. */
  readonly replace: (threadId: ThreadId, prompt: Prompt.Prompt) => Effect.Effect<void>;
  readonly forget: (threadId: ThreadId) => Effect.Effect<void>;
}

export const makeTranscriptStore = (input: {
  readonly fileSystem: FileSystem.FileSystem;
  /** Directory under the T3 home. Created on first write. */
  readonly directory: string;
}): TranscriptStore => {
  const fileFor = (threadId: ThreadId) =>
    NodePath.join(input.directory, `${sanitise(threadId)}.ndjson`);

  const ensureDirectory = Effect.ignore(
    input.fileSystem.makeDirectory(input.directory, { recursive: true }),
  );

  const append: TranscriptStore["append"] = (threadId, messages) =>
    messages.length === 0
      ? Effect.void
      : Effect.ignore(
          Effect.andThen(
            ensureDirectory,
            input.fileSystem.writeFileString(
              fileFor(threadId),
              `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
              { flag: "a" },
            ),
          ),
        );

  const read: TranscriptStore["read"] = Effect.fnUntraced(function* (threadId: ThreadId) {
    const raw = yield* Effect.option(input.fileSystem.readFileString(fileFor(threadId)));
    if (raw._tag === "None") {
      return Prompt.empty;
    }

    const messages: Array<Prompt.Message> = [];
    for (const line of raw.value.split("\n")) {
      if (line.trim() === "") {
        continue;
      }
      const parsed = parseLine(line);
      if (parsed !== null) {
        messages.push(parsed);
      }
    }
    return Prompt.make(messages);
  });

  const replace: TranscriptStore["replace"] = (threadId, prompt) =>
    Effect.ignore(
      Effect.andThen(
        ensureDirectory,
        input.fileSystem.writeFileString(
          fileFor(threadId),
          `${prompt.content.map((message) => JSON.stringify(message)).join("\n")}\n`,
        ),
      ),
    );

  const forget: TranscriptStore["forget"] = (threadId) =>
    Effect.ignore(input.fileSystem.remove(fileFor(threadId)));

  return { append, read, replace, forget };
};

/**
 * A truncated file's last line is usually partial. Skipping it loses one
 * message; throwing would lose the conversation.
 */
function parseLine(line: string): Prompt.Message | null {
  try {
    return JSON.parse(line) as Prompt.Message;
  } catch {
    return null;
  }
}

/** Thread ids are ours, but a path separator in one would escape the directory. */
function sanitise(threadId: string): string {
  return threadId.replace(/[^a-zA-Z0-9_-]/g, "_");
}
