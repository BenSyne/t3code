// @effect-diagnostics nodeBuiltinImport:off
/**
 * Conversations that survive a restart.
 *
 * Sessions live in memory, which is fine until the server restarts and every
 * thread the user was working in becomes an empty box that still appears in
 * their sidebar. This writes each thread's conversation to a file so it can be
 * picked up again.
 *
 * NDJSON, one message per line, and the reader skips a line it cannot parse
 * rather than giving up on the file — so a write torn by a crash costs the tail
 * of the conversation instead of all of it.
 *
 * Each write replaces the file. Appending only the newest messages would be
 * cheaper, but it means holding an index into a conversation that compaction
 * can replace underneath you, and an index that goes stale drops a turn from
 * the file silently and permanently. The conversation is small enough that
 * rewriting it costs nothing next to the network round trip that produced it.
 *
 * @module agent/state/TranscriptStore
 */
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type { ThreadId } from "@t3tools/contracts";
import * as Prompt from "effect/unstable/ai/Prompt";

export interface TranscriptStore {
  /** Read a thread back, or an empty prompt if there is nothing to read. */
  readonly read: (threadId: ThreadId) => Effect.Effect<Prompt.Prompt>;
  /**
   * Write a thread's conversation, replacing whatever was there.
   *
   * Never fails: losing history is not worth losing a turn.
   */
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

  return { read, replace, forget };
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
