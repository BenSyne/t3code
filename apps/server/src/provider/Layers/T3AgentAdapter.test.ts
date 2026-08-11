// @effect-diagnostics nodeBuiltinImport:off
/**
 * The adapter end to end, against a local server speaking the OpenAI wire
 * format.
 *
 * Everything under `agent/` is tested with the `LanguageModel` stubbed, which
 * proves the loop and nothing about the adapter around it. These tests build
 * the real adapter — session store, transcripts, compaction, interrupts — and
 * drive it the way the orchestrator does. What they pin down is the part a
 * stubbed loop cannot: that a conversation survives the ways a turn can end.
 */
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Redacted from "effect/Redacted";
import type * as Prompt from "effect/unstable/ai/Prompt";
import { FetchHttpClient } from "effect/unstable/http";

import { unavailableOrchestrationClient } from "../../agent/conductor/ConductorClient.ts";
import { makeTranscriptStore } from "../../agent/state/TranscriptStore.ts";
import type { ResolvedCredential } from "../../agent/model/credentials.ts";
import type { T3AgentAdapterOptions } from "../Services/T3AgentAdapter.ts";
import { makeT3AgentAdapter } from "./T3AgentAdapter.ts";

const THREAD = ThreadId.make("thread-adapter-test");

const credential: ResolvedCredential = {
  _tag: "Resolved",
  key: Redacted.make("not-required"),
  variableName: "OPENAI_API_KEY",
  source: "instance-environment",
};

type StreamBehaviour =
  | { readonly reply: string; readonly promptTokens?: number }
  | { readonly hang: true };

/**
 * The smallest thing that answers like an OpenAI-compatible server.
 *
 * Streaming requests are answered from `script` in call order (the last entry
 * repeats). A `hang` entry sends one chunk and then holds the connection open,
 * which is what a turn mid-flight looks like from the adapter's side. The
 * non-streaming endpoint answers every request with `summary` — the only
 * non-streaming caller in the adapter is compaction.
 */
function startStubServer(input: {
  script: ReadonlyArray<StreamBehaviour>;
  summary: string;
}): Promise<{
  readonly baseUrl: string;
  readonly streamCalls: () => number;
  readonly requests: Array<{
    stream?: boolean;
    messages?: Array<{ role: string; content: unknown }>;
  }>;
  readonly close: () => Promise<void>;
}> {
  let streamed = 0;
  const requests: Array<{
    stream?: boolean;
    messages?: Array<{ role: string; content: unknown }>;
  }> = [];
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
        id: "chatcmpl-stub",
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
                message: { role: "assistant", content: input.summary },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
        );
        return;
      }

      const behaviour =
        input.script[Math.min(streamed, input.script.length - 1)] ?? ({ hang: true } as const);
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
        // Deliberately no end: the turn stays running until interrupted.
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
          // The reported usage is what the adapter's compaction check reads,
          // so a script entry can push the *next* turn over budget.
          usage: {
            prompt_tokens: behaviour.promptTokens ?? 100,
            completion_tokens: 5,
            total_tokens: (behaviour.promptTokens ?? 100) + 5,
          },
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
            server.close(() => {
              done();
            });
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

/** Poll until the predicate holds. Fails the test after ~5 seconds rather than hanging it. */
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
 * Build the real adapter against the stub server, in a temp workspace so
 * nothing discovers this repository's own skills or instructions.
 */
const withAdapter = <A, E>(
  input: {
    script: ReadonlyArray<StreamBehaviour>;
    summary?: string;
    contextWindow?: number;
    conductor?: T3AgentAdapterOptions["conductor"];
  },
  body: (context: {
    adapter: Effect.Success<ReturnType<typeof makeT3AgentAdapter>>;
    transcripts: ReturnType<typeof makeTranscriptStore>;
    directory: string;
    streamCalls: () => number;
    requests: Array<{ stream?: boolean; messages?: Array<{ role: string; content: unknown }> }>;
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const stub = yield* Effect.promise(() =>
      startStubServer({ script: input.script, summary: input.summary ?? "A summary." }),
    );

    return yield* Effect.ensuring(
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const directory = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3-agent-adapter-test-",
          });

          const options: T3AgentAdapterOptions = {
            credential: () => credential,
            backend: "openai-compat",
            baseUrl: stub.baseUrl,
            defaultModel: "stub-model",
            commandEnv: {},
            contextWindowFor: () => input.contextWindow ?? 200_000,
            permissionRules: [],
            transcriptDirectory: directory,
            mcpServers: {},
            rateTable: Effect.succeed(new Map()),
            homeDirectory: directory,
            conductor: input.conductor ?? null,
          };

          const adapter = yield* makeT3AgentAdapter(options);
          const transcripts = makeTranscriptStore({ fileSystem, directory });

          yield* adapter.startSession({
            threadId: THREAD,
            runtimeMode: "full-access",
            cwd: directory,
          });

          return yield* body({
            adapter,
            transcripts,
            directory,
            streamCalls: stub.streamCalls,
            requests: stub.requests,
          });
        }),
      ),
      Effect.promise(() => stub.close()),
    );
  }).pipe(Effect.provide(FetchHttpClient.layer), Effect.provide(NodeServices.layer));

describe("T3AgentAdapter persistence", () => {
  it.live("a completed turn is on disk, not just in memory", () =>
    withAdapter({ script: [{ reply: "Reply one." }] }, ({ adapter, transcripts }) =>
      Effect.gen(function* () {
        yield* adapter.sendTurn({ threadId: THREAD, input: "hello there" });
        yield* eventually(
          Effect.map(transcripts.read(THREAD), (read) =>
            texts(read).some((text) => text.includes("Reply one.")),
          ),
          "the turn's reply to reach the transcript",
        );

        const written = texts(yield* transcripts.read(THREAD));
        assert.isTrue(written.some((text) => text.includes("hello there")));
      }),
    ),
  );

  it.live("a hard stop keeps the message that started the turn", () =>
    withAdapter({ script: [{ hang: true }] }, ({ adapter, transcripts, streamCalls }) =>
      Effect.gen(function* () {
        // The turn hangs mid-stream, which is what it looks like when someone
        // reaches for Stop. The first press asks politely; the fiber is parked
        // on the network and cannot answer. The second kills it — and the
        // killed fiber never reaches its own persistence, so the adapter must
        // write the file itself or a restart forgets the message.
        yield* adapter.sendTurn({ threadId: THREAD, input: "the message at stake" });
        yield* eventually(
          Effect.sync(() => streamCalls() >= 1),
          "the turn's request to reach the model",
        );
        yield* adapter.interruptTurn(THREAD);
        yield* adapter.interruptTurn(THREAD);

        yield* eventually(
          Effect.map(transcripts.read(THREAD), (read) =>
            texts(read).some((text) => text.includes("the message at stake")),
          ),
          "the interrupted turn's message to reach the transcript",
        );
      }),
    ),
  );

  it.live("a turn that compacted the conversation offers no rollback point", () =>
    withAdapter(
      {
        // Four quiet turns build up history; the fourth reports usage over
        // budget, so the fifth — and only the fifth — compacts before running.
        script: [
          { reply: "Reply 1." },
          { reply: "Reply 2." },
          { reply: "Reply 3." },
          { reply: "Reply 4.", promptTokens: 50_000 },
          { reply: "Final reply." },
        ],
        summary: "What happened earlier, condensed.",
        // Small enough that the 50k tokens each turn reports blow the budget.
        contextWindow: 21_000,
      },
      ({ adapter, transcripts }) =>
        Effect.gen(function* () {
          // Large messages, so the compaction split has something to summarise.
          const filler = "x".repeat(12_000);
          for (const label of ["1", "2", "3", "4"] as const) {
            yield* adapter.sendTurn({ threadId: THREAD, input: `turn ${label} ${filler}` });
            yield* eventually(
              Effect.map(transcripts.read(THREAD), (read) =>
                texts(read).some((text) => text.includes(`Reply ${label}.`)),
              ),
              `turn ${label} to complete`,
            );
          }

          yield* adapter.sendTurn({ threadId: THREAD, input: "the compacted turn" });
          yield* eventually(
            Effect.map(transcripts.read(THREAD), (read) =>
              texts(read).some((text) => text.includes("Final reply.")),
            ),
            "the compacted turn to complete",
          );

          const compacted = texts(yield* transcripts.read(THREAD));
          assert.isTrue(
            compacted.some((text) => text.includes("What happened earlier, condensed.")),
            "compaction should have replaced the early turns with the summary",
          );

          // The boundary recorded for this turn indexed the conversation that
          // compaction just replaced. Undoing the turn along it would slice
          // the compacted prompt at a meaningless point, so the adapter must
          // decline: no rollback points, and rolling back changes nothing.
          const snapshot = yield* adapter.readThread(THREAD);
          assert.deepEqual(snapshot.turns, []);

          yield* adapter.rollbackThread(THREAD, 1);
          const after = texts(yield* transcripts.read(THREAD));
          assert.deepEqual(after, compacted);
        }),
    ),
  );

  it.live("an orchestrating session opens already knowing its fleet", () =>
    withAdapter(
      {
        script: [{ reply: "Reply one." }],
        conductor: {
          // The unavailable client answers every listing with nothing, so the
          // overrides below are the entire fleet this test claims to have.
          client: {
            ...unavailableOrchestrationClient,
            listProviders: Effect.succeed([
              {
                instanceId: ProviderInstanceId.make("codex-1"),
                driverKind: "codex",
                displayName: "Codex",
                available: true,
                defaultModel: "gpt-5-codex",
                billing: "subscription" as const,
              },
            ]),
            listProjects: Effect.succeed([
              { id: ProjectId.make("project-1"), title: "Better T3", workspaceRoot: "/repo" },
            ]),
            listThreads: () =>
              Effect.succeed([
                {
                  threadId: ThreadId.make("thread-blocked"),
                  title: "Stuck migration",
                  providerInstanceId: ProviderInstanceId.make("codex-1"),
                  status: "ready",
                  updatedAt: "2026-08-10T00:00:00.000Z",
                  lifecycle: "active" as const,
                  isRunning: false,
                  awaitingInput: false,
                  awaitingApproval: true,
                },
              ]),
          },
          policy: { allowSelfTargeting: false, allowApprovingRequests: false },
          selfDriverKind: "t3agent",
          nextId: Effect.succeed("id"),
          nowIso: Effect.succeed("2026-08-10T00:00:00.000Z"),
        },
      },
      ({ adapter, transcripts, requests }) =>
        Effect.gen(function* () {
          yield* adapter.sendTurn({ threadId: THREAD, input: "hi" });
          yield* eventually(
            Effect.map(transcripts.read(THREAD), (read) =>
              texts(read).some((text) => text.includes("Reply one.")),
            ),
            "the turn to complete",
          );

          // The point of the snapshot: the very first request already tells the
          // model who it can route to, what that costs, and what is stuck.
          const system = requests[0]?.messages?.find((message) => message.role === "system");
          const content = typeof system?.content === "string" ? system.content : "";
          assert.include(content, "Codex");
          assert.include(content, "subscription");
          assert.include(content, '"Stuck migration" is waiting on an approval');
        }),
    ),
  );
});
