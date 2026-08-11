// @effect-diagnostics nodeBuiltinImport:off
/**
 * The permission gate, driven the way a person drives it.
 *
 * Every other test of the permission machinery stubs `requestApproval` to allow
 * everything, which proves the decision table and nothing about the wait. These
 * build the real adapter, let a model ask to run a command, and answer through
 * `respondToRequest` — so what is under test is the part that can hang: a tool
 * parked on a `Deferred` until a human, or a closing session, releases it.
 */
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ApprovalRequestId, ProviderRuntimeEvent, ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/unstable/http";

import { makeApprovalGate } from "../../agent/permission/Gate.ts";
import type { ResolvedCredential } from "../../agent/model/credentials.ts";
import type { T3AgentAdapterOptions } from "../Services/T3AgentAdapter.ts";
import { makeT3AgentAdapter } from "./T3AgentAdapter.ts";

const THREAD = ThreadId.make("thread-permissions-test");

const credential: ResolvedCredential = {
  _tag: "Resolved",
  key: Redacted.make("not-required"),
  variableName: "OPENAI_API_KEY",
  source: "instance-environment",
};

/** Ask to run a command, then — once its result is back — say something and stop. */
type Step = { readonly call: { name: string; args: Record<string, unknown> } } | { reply: string };

/**
 * An OpenAI-compatible server that can also ask for a tool.
 *
 * Tool calls stream as `delta.tool_calls`, the same shape a real server sends,
 * so the client's own parser is what turns them back into a call. A stub that
 * handed the loop a pre-built tool call would skip the wire and prove less.
 */
function startStubServer(script: ReadonlyArray<Step>): Promise<{
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
        id: "chatcmpl-perm",
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

      const step = script[Math.min(streamed, script.length - 1)] ?? { reply: "Done." };
      streamed += 1;

      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      openResponses.add(response);
      response.on("close", () => openResponses.delete(response));

      const chunks =
        "call" in step
          ? [
              {
                ...envelope,
                choices: [
                  {
                    index: 0,
                    delta: {
                      role: "assistant",
                      tool_calls: [
                        {
                          index: 0,
                          id: "call_1",
                          type: "function",
                          function: {
                            name: step.call.name,
                            arguments: JSON.stringify(step.call.args),
                          },
                        },
                      ],
                    },
                  },
                ],
              },
              { ...envelope, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
            ]
          : [
              {
                ...envelope,
                choices: [{ index: 0, delta: { role: "assistant", content: step.reply } }],
              },
              {
                ...envelope,
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
              },
            ];

      for (const chunk of chunks) {
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

const withAdapter = <A, E>(
  input: { script: ReadonlyArray<Step>; runtimeMode: "full-access" | "approval-required" },
  body: (context: {
    adapter: Effect.Success<ReturnType<typeof makeT3AgentAdapter>>;
    events: Array<ProviderRuntimeEvent>;
    directory: string;
    streamCalls: () => number;
    requests: Array<{ messages?: Array<{ role: string; content: unknown }> }>;
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const stub = yield* Effect.promise(() => startStubServer(input.script));

    return yield* Effect.ensuring(
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const directory = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3-agent-permissions-test-",
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

          const adapter = yield* makeT3AgentAdapter(options);

          // Drained in the background: `request.opened` carries the id the test
          // has to answer with, and it only exists while a tool is parked.
          const events: Array<ProviderRuntimeEvent> = [];
          yield* Effect.forkScoped(
            Stream.runForEach(adapter.streamEvents, (event) =>
              Effect.sync(() => {
                events.push(event);
              }),
            ),
          );

          yield* adapter.startSession({
            threadId: THREAD,
            runtimeMode: input.runtimeMode,
            cwd: directory,
          });

          return yield* body({
            adapter,
            events,
            directory,
            streamCalls: stub.streamCalls,
            requests: stub.requests,
          });
        }),
      ),
      Effect.promise(() => stub.close()),
    );
  }).pipe(Effect.provide(FetchHttpClient.layer), Effect.provide(NodeServices.layer));

const openedRequest = (events: ReadonlyArray<ProviderRuntimeEvent>) =>
  events.find((event) => event.type === "request.opened");

/** Every message the model was sent, flattened to text, across all requests. */
const sentText = (requests: ReadonlyArray<{ messages?: Array<{ content: unknown }> }>): string =>
  JSON.stringify(requests.flatMap((request) => request.messages ?? []));

describe("the permission gate, end to end", () => {
  it.live("parks a command until the user answers, then declines it in words", () =>
    withAdapter(
      {
        runtimeMode: "approval-required",
        script: [
          { call: { name: "bash", args: { command: "rm -rf /tmp/nope" } } },
          { reply: "Understood." },
        ],
      },
      ({ adapter, events, requests }) =>
        Effect.gen(function* () {
          yield* adapter.sendTurn({ threadId: THREAD, input: "clean that up" });

          yield* eventually(
            Effect.sync(() => openedRequest(events) !== undefined),
            "the command to raise an approval request",
          );

          const opened = openedRequest(events);
          assert.isDefined(opened);
          // Nothing ran yet: the tool is parked, so the model has not been
          // called a second time and no result exists to send it.
          assert.strictEqual(requests.length, 1);

          yield* adapter.respondToRequest(
            THREAD,
            ApprovalRequestId.make((opened as { requestId: string }).requestId),
            "decline",
          );

          yield* eventually(
            Effect.sync(() => requests.length >= 2),
            "the turn to continue after the refusal",
          );

          // The refusal reaches the model as an ordinary tool result it can read
          // and answer, which is the whole point of denying rather than crashing.
          assert.include(sentText(requests), "declined");
          assert.isTrue(
            events.some((event) => event.type === "request.resolved"),
            "the request should be reported resolved, not left open",
          );
        }),
    ),
  );

  it.live("runs the command once the user approves it", () =>
    withAdapter(
      {
        runtimeMode: "approval-required",
        script: [
          { call: { name: "bash", args: { command: "echo approved-and-ran" } } },
          { reply: "Ran it." },
        ],
      },
      ({ adapter, events, requests }) =>
        Effect.gen(function* () {
          yield* adapter.sendTurn({ threadId: THREAD, input: "say hello" });

          yield* eventually(
            Effect.sync(() => openedRequest(events) !== undefined),
            "the command to raise an approval request",
          );
          const opened = openedRequest(events);
          assert.isDefined(opened);

          yield* adapter.respondToRequest(
            THREAD,
            ApprovalRequestId.make((opened as { requestId: string }).requestId),
            "accept",
          );

          yield* eventually(
            Effect.sync(() => requests.length >= 2),
            "the command's output to go back to the model",
          );
          assert.include(sentText(requests), "approved-and-ran");
        }),
    ),
  );

  it.live("does not ask at all in full access", () =>
    withAdapter(
      {
        runtimeMode: "full-access",
        script: [
          { call: { name: "bash", args: { command: "echo unattended" } } },
          { reply: "Done." },
        ],
      },
      ({ adapter, events, requests }) =>
        Effect.gen(function* () {
          yield* adapter.sendTurn({ threadId: THREAD, input: "just do it" });

          yield* eventually(
            Effect.sync(() => requests.length >= 2),
            "the command to run without being asked about",
          );
          assert.isUndefined(openedRequest(events), "full access should raise no approval request");
          assert.include(sentText(requests), "unattended");
        }),
    ),
  );

  it.live("stops cleanly while a tool is still waiting on the user", () =>
    withAdapter(
      {
        runtimeMode: "approval-required",
        script: [
          { call: { name: "bash", args: { command: "rm -rf /tmp/nope" } } },
          { reply: "Fine." },
        ],
      },
      ({ adapter, events }) =>
        Effect.gen(function* () {
          yield* adapter.sendTurn({ threadId: THREAD, input: "clean that up" });
          yield* eventually(
            Effect.sync(() => openedRequest(events) !== undefined),
            "the command to raise an approval request",
          );

          // Nobody answers. A liveness guard rather than an assertion about any
          // one mechanism: `stopSession` denies the gate *and* interrupts the
          // fiber, and either alone would release this tool. What must never
          // happen is both being got wrong at once, which shows up here as a
          // session that never finishes closing.
          yield* adapter.stopSession(THREAD);

          yield* eventually(
            Effect.sync(() => events.some((event) => event.type === "session.exited")),
            "the session to finish closing rather than hang on the parked tool",
          );
        }),
    ),
  );
});

describe("the approval gate itself", () => {
  it.live("resolves everything parked to a refusal when the session gives up", () =>
    Effect.gen(function* () {
      const gate = yield* makeApprovalGate;
      const parked = yield* Effect.forkChild(
        gate.await({ requestId: "request-1", toolName: "bash", target: "rm -rf /tmp/nope" }),
      );

      yield* eventually(
        Effect.map(gate.pending, (pending) => pending.length === 1),
        "the request to register as pending",
      );

      // The contract the adapter leans on when a session closes: a caller
      // parked here is answered, not abandoned. Nothing else can unstick it,
      // because the answer was always going to come from outside.
      yield* gate.rejectAll;

      assert.strictEqual(yield* Fiber.join(parked), "denied");
      assert.deepStrictEqual(yield* gate.pending, []);
    }),
  );

  it.live("forgets a request once it is answered, so a late answer changes nothing", () =>
    Effect.gen(function* () {
      const gate = yield* makeApprovalGate;
      const parked = yield* Effect.forkChild(
        gate.await({ requestId: "request-1", toolName: "bash", target: "echo hi" }),
      );

      yield* eventually(
        Effect.map(gate.pending, (pending) => pending.length === 1),
        "the request to register as pending",
      );

      assert.isTrue(yield* gate.resolve("request-1", "approved"));
      assert.strictEqual(yield* Fiber.join(parked), "approved");
      assert.isFalse(
        yield* gate.resolve("request-1", "denied"),
        "answering twice should report that there was nothing left to answer",
      );
    }),
  );
});
