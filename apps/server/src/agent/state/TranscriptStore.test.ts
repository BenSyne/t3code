import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Prompt from "effect/unstable/ai/Prompt";
import type { ThreadId } from "@t3tools/contracts";

import { makeTranscriptStore } from "./TranscriptStore.ts";

const thread = "thread-1" as ThreadId;

const userMessage = (text: string): Prompt.Message => ({
  role: "user",
  content: [{ type: "text", text }],
});

const texts = (prompt: Prompt.Prompt): ReadonlyArray<string> =>
  prompt.content.flatMap((message) =>
    message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
  );

const withStore = <A>(
  body: (
    store: ReturnType<typeof makeTranscriptStore>,
    directory: string,
  ) => Effect.Effect<A, unknown, FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-transcript-test-" });
    return yield* body(makeTranscriptStore({ fileSystem, directory }), directory);
  }).pipe(Effect.provide(NodeServices.layer));

describe("TranscriptStore", () => {
  it.effect("reads back an empty prompt for a thread that has never been written", () =>
    withStore((store) =>
      Effect.gen(function* () {
        assert.deepEqual(texts(yield* store.read(thread)), []);
      }),
    ),
  );

  it.effect("round-trips a conversation", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.replace(thread, Prompt.make([userMessage("one"), userMessage("two")]));
        assert.deepEqual(texts(yield* store.read(thread)), ["one", "two"]);
      }),
    ),
  );

  it.effect("shrinks the file when the conversation shrinks", () =>
    withStore((store) =>
      Effect.gen(function* () {
        // What compaction and rollback both do. If the write only ever grew the
        // file, restarting would resurrect the messages that were just replaced
        // by a summary or undone by the user.
        yield* store.replace(
          thread,
          Prompt.make([userMessage("one"), userMessage("two"), userMessage("three")]),
        );
        yield* store.replace(thread, Prompt.make([userMessage("summary")]));

        assert.deepEqual(texts(yield* store.read(thread)), ["summary"]);
      }),
    ),
  );

  it.effect("keeps the messages it can parse when a line is torn", () =>
    withStore((store, directory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        yield* store.replace(thread, Prompt.make([userMessage("kept")]));

        const file = `${directory}/${thread}.ndjson`;
        const whole = yield* fileSystem.readFileString(file);
        // A crash mid-write leaves the last line half-written. Losing it should
        // cost that message, not the conversation.
        yield* fileSystem.writeFileString(file, `${whole}{"role":"user","cont`);

        assert.deepEqual(texts(yield* store.read(thread)), ["kept"]);
      }),
    ),
  );

  it.effect("forgets a thread", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.replace(thread, Prompt.make([userMessage("one")]));
        yield* store.forget(thread);
        assert.deepEqual(texts(yield* store.read(thread)), []);
      }),
    ),
  );
});
