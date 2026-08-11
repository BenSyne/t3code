// @effect-diagnostics nodeBuiltinImport:off
/**
 * What survives a restart.
 *
 * The adapter keeps a conversation in memory and mirrors it to an NDJSON file.
 * Every other test watches one adapter's lifetime, which cannot see the thing
 * that actually breaks: whether a *second* adapter, built over the same
 * directory the way a restarted server builds one, picks the conversation back
 * up — and whether what the first one left behind is well-formed when it was
 * killed mid-turn rather than allowed to finish.
 */
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as Crypto from "effect/Crypto";
import * as FileSystem from "effect/FileSystem";
import * as Redacted from "effect/Redacted";
import type * as Prompt from "effect/unstable/ai/Prompt";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { FetchHttpClient, type HttpClient } from "effect/unstable/http";

import { makeTranscriptStore } from "../../agent/state/TranscriptStore.ts";
import type { ResolvedCredential } from "../../agent/model/credentials.ts";
import type { T3AgentAdapterOptions } from "../Services/T3AgentAdapter.ts";
import { makeT3AgentAdapter } from "./T3AgentAdapter.ts";

const THREAD = ThreadId.make("thread-lifecycle-test");

const credential: ResolvedCredential = {
  _tag: "Resolved",
  key: Redacted.make("not-required"),
  variableName: "OPENAI_API_KEY",
  source: "instance-environment",
};

/** What building an adapter needs; provided once at the bottom of this file. */
type AdapterServices =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient;

type Behaviour = { readonly reply: string } | { readonly hang: true };

function startStubServer(script: ReadonlyArray<Behaviour>): Promise<{
  readonly baseUrl: string;
  readonly streamCalls: () => number;
  readonly requests: Array<{ messages?: Array<{ role: string; content: unknown }> }>;
  readonly close: () => Promise<void>;
}> {
  let streamed = 0;
  const requests: Array<{ messages?: Array<{ role: string; content: unknown }> }> = [];
  const openResponses = new Set<NodeHttp.ServerResponse>();

  const server = NodeHttp.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      const parsed = JSON.parse(body) as {
        stream?: boolean;
        messages?: Array<{ role: string; content: unknown }>;
      };
      requests.push(parsed);
      const envelope = {
        id: "chatcmpl-lifecycle",
        object: "chat.completion.chunk",
        created: 1_700_000_000,
        model: "stub-model",
      };

      if (parsed.stream !== true) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            ...envelope,
            object: "chat.completion",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "A summary." },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
        );
        return;
      }

      const behaviour = script[Math.min(streamed, script.length - 1)] ?? { hang: true as const };
      streamed += 1;

      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      openResponses.add(response);
      response.on("close", () => openResponses.delete(response));

      if ("hang" in behaviour) {
        response.write(
          `data: ${JSON.stringify({
            ...envelope,
            choices: [{ index: 0, delta: { role: "assistant", content: "Working" } }],
          })}\n\n`,
        );
        return;
      }

      for (const chunk of [
        {
          ...envelope,
          choices: [{ index: 0, delta: { role: "assistant", content: behaviour.reply } }],
        },
        {
          ...envelope,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
        },
      ]) {
        response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as NodeNet.AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        streamCalls: () => streamed,
        requests,
        close: () =>
          new Promise<void>((done) => {
            for (const open of openResponses) {
              open.destroy();
            }
            server.close(() => done());
          }),
      });
    });
  });
}

// A system message's content is a bare string; every other role carries parts.
const texts = (prompt: Prompt.Prompt): ReadonlyArray<string> =>
  prompt.content.flatMap((message) =>
    typeof message.content === "string"
      ? [message.content]
      : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
  );

const eventually = <E>(predicate: Effect.Effect<boolean, E>, what: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 250; attempt += 1) {
      if (yield* predicate) {
        return;
      }
      yield* Effect.sleep(20);
    }
    return yield* Effect.die(`Timed out waiting for ${what}`);
  });

/**
 * One stub server and one transcript directory, across as many adapter
 * lifetimes as the test wants.
 *
 * The directory outliving the adapter is the whole point: a restarted server
 * builds a new adapter over state the old one left, and that is the seam these
 * tests are aimed at.
 */
const withRestartableAdapter = <A, E>(
  script: ReadonlyArray<Behaviour>,
  body: (context: {
    runAdapter: <B, F>(
      use: (adapter: Effect.Success<ReturnType<typeof makeT3AgentAdapter>>) => Effect.Effect<B, F>,
    ) => Effect.Effect<B, F, AdapterServices>;
    transcripts: ReturnType<typeof makeTranscriptStore>;
    streamCalls: () => number;
    requests: Array<{ messages?: Array<{ role: string; content: unknown }> }>;
  }) => Effect.Effect<A, E, AdapterServices>,
) =>
  Effect.gen(function* () {
    const stub = yield* Effect.promise(() => startStubServer(script));

    return yield* Effect.ensuring(
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const directory = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3-agent-lifecycle-test-",
          });

          const options: T3AgentAdapterOptions = {
            credential: () => credential,
            backend: "openai-compat",
            baseUrl: stub.baseUrl,
            defaultModel: "stub-model",
            commandEnv: {},
            contextWindowFor: () => 200_000,
            permissionRules: [],
            transcriptDirectory: directory,
            mcpServers: {},
            rateTable: Effect.succeed(new Map()),
            homeDirectory: directory,
            conductor: null,
          };

          const runAdapter = <B, F>(
            use: (
              adapter: Effect.Success<ReturnType<typeof makeT3AgentAdapter>>,
            ) => Effect.Effect<B, F>,
          ) =>
            Effect.scoped(
              Effect.gen(function* () {
                const adapter = yield* makeT3AgentAdapter(options);
                return yield* use(adapter);
              }),
            );

          return yield* body({
            runAdapter,
            transcripts: makeTranscriptStore({ fileSystem, directory }),
            streamCalls: stub.streamCalls,
            requests: stub.requests,
          });
        }),
      ),
      Effect.promise(() => stub.close()),
    );
  }).pipe(Effect.provide(FetchHttpClient.layer), Effect.provide(NodeServices.layer));

/** Every message the model was sent on its Nth request, flattened to text. */
const requestText = (
  requests: ReadonlyArray<{ messages?: Array<{ content: unknown }> }>,
  index: number,
): string => JSON.stringify(requests[index]?.messages ?? []);

describe("surviving a restart", () => {
  it.live("picks the conversation back up in a new adapter", () =>
    withRestartableAdapter(
      [{ reply: "Noted." }, { reply: "It was 41." }],
      ({ runAdapter, transcripts, requests }) =>
        Effect.gen(function* () {
          yield* runAdapter((adapter) =>
            Effect.gen(function* () {
              yield* adapter.startSession({
                threadId: THREAD,
                runtimeMode: "full-access",
                cwd: ".",
              });
              yield* adapter.sendTurn({ threadId: THREAD, input: "remember the number 41" });
              // `sendTurn` returns once the turn is running, so waiting on the
              // request alone would tear the adapter down mid-turn. A restart
              // worth testing happens after a turn has landed on disk.
              yield* eventually(
                Effect.map(transcripts.read(THREAD), (read) =>
                  texts(read).some((text) => text.includes("Noted.")),
                ),
                "the first turn to finish and reach the transcript",
              );
            }),
          );

          // The first adapter is gone — its Map, its sessions, its fibers. A new
          // one over the same directory is what a restarted server has.
          yield* runAdapter((adapter) =>
            Effect.gen(function* () {
              yield* adapter.startSession({
                threadId: THREAD,
                runtimeMode: "full-access",
                cwd: ".",
              });
              yield* adapter.sendTurn({ threadId: THREAD, input: "what was the number?" });
              yield* eventually(
                Effect.sync(() => requests.length >= 2),
                "the resumed turn to reach the model",
              );
            }),
          );

          // The restarted session sent the earlier exchange along with the new
          // message. Without that the model answers a question it cannot see.
          const resumed = requestText(requests, requests.length - 1);
          assert.include(resumed, "remember the number 41");
          assert.include(resumed, "what was the number?");
        }),
    ),
  );

  it.live("leaves a history a new adapter can continue from after a hard stop", () =>
    withRestartableAdapter(
      [{ hang: true }, { reply: "Carrying on." }],
      ({ runAdapter, transcripts, requests }) =>
        Effect.gen(function* () {
          yield* runAdapter((adapter) =>
            Effect.gen(function* () {
              yield* adapter.startSession({
                threadId: THREAD,
                runtimeMode: "full-access",
                cwd: ".",
              });
              yield* adapter.sendTurn({ threadId: THREAD, input: "start something long" });
              yield* eventually(
                Effect.sync(() => requests.length >= 1),
                "the turn to be in flight before stopping it",
              );

              // Two presses: the first sets the flag, and a step that never
              // returns never reads it, so the second is what actually stops it.
              yield* adapter.interruptTurn(THREAD);
              yield* adapter.interruptTurn(THREAD);
            }),
          );

          const afterStop = yield* transcripts.read(THREAD);
          // The message that started the killed turn has to be on disk — the turn
          // fiber died before its own write, so the adapter writes it instead.
          assert.isTrue(
            texts(afterStop).some((text) => text.includes("start something long")),
            "the interrupted turn's user message should survive the stop",
          );
          // No tool call was made, so nothing can be left dangling; what matters
          // is that the file is a conversation and not a torn fragment.
          assert.isAbove(afterStop.content.length, 0);

          yield* runAdapter((adapter) =>
            Effect.gen(function* () {
              yield* adapter.startSession({
                threadId: THREAD,
                runtimeMode: "full-access",
                cwd: ".",
              });
              yield* adapter.sendTurn({ threadId: THREAD, input: "try again" });
              yield* eventually(
                Effect.sync(() => requests.length >= 2),
                "the new adapter to run a turn on the recovered conversation",
              );
            }),
          );

          const recovered = requestText(requests, requests.length - 1);
          assert.include(recovered, "start something long");
          assert.include(recovered, "try again");
        }),
    ),
  );

  it.live("starts clean for a thread it has never seen", () =>
    withRestartableAdapter([{ reply: "Hello." }], ({ runAdapter, requests }) =>
      runAdapter((adapter) =>
        Effect.gen(function* () {
          const fresh = ThreadId.make("thread-never-seen");
          yield* adapter.startSession({
            threadId: fresh,
            runtimeMode: "full-access",
            cwd: ".",
          });
          yield* adapter.sendTurn({ threadId: fresh, input: "first words" });
          yield* eventually(
            Effect.sync(() => requests.length >= 1),
            "the turn to reach the model",
          );

          // A missing transcript is an empty conversation, not an error, and
          // must not smuggle another thread's history into this one.
          const sent = requestText(requests, 0);
          assert.include(sent, "first words");
          assert.notInclude(sent, "remember the number 41");
        }),
      ),
    ),
  );
});
