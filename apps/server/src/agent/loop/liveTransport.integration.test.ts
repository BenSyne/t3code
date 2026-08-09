// @effect-diagnostics nodeBuiltinImport:off
/**
 * The turn loop against a real HTTP model endpoint.
 *
 * Every other test in `agent/` stubs the `LanguageModel` service, which proves
 * the loop's logic and nothing about the transport underneath it. This one runs
 * the whole path — `resolveLanguageModel` → an `@effect/ai` client → HTTP →
 * server-sent events → stream parts → `runTurn` → runtime events — against a
 * local server that speaks the OpenAI wire format.
 *
 * The server is a stub, so this does not prove any particular vendor's dialect.
 * What it does prove is that the plumbing carries a request out and a streamed
 * answer back, which is the part no amount of stubbing can check and the part
 * that fails silently when a version moves underneath us.
 *
 * It also exercises `openai-compat` specifically, which is the backend Ollama
 * and LM Studio use. If this passes, local inference works.
 */
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId, TurnId } from "@t3tools/contracts";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Prompt from "effect/unstable/ai/Prompt";
import { FetchHttpClient } from "effect/unstable/http";

import { resolveLanguageModel } from "../model/resolveLanguageModel.ts";
import { buildToolkit } from "../tools/registry.ts";
import { runTurn, type TurnEmitter } from "./runTurn.ts";

const THREAD = ThreadId.make("thread-live");
const TURN = TurnId.make("turn-live");

/**
 * The smallest thing that answers like an OpenAI-compatible server.
 *
 * Streams two content chunks and a finish, which is enough to prove deltas
 * arrive separately rather than as one lump at the end.
 */
function startStubServer(): Promise<{
  readonly baseUrl: string;
  readonly requests: Array<unknown>;
  readonly close: () => Promise<void>;
}> {
  const requests: Array<unknown> = [];

  const server = NodeHttp.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      try {
        requests.push(JSON.parse(body));
      } catch {
        requests.push(body);
      }

      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      // Shaped like a real `chat.completion.chunk`: the client validates these
      // against a schema, and a chunk missing `id` or `object` is dropped.
      const envelope = {
        id: "chatcmpl-stub",
        object: "chat.completion.chunk",
        created: 1_700_000_000,
        model: "stub-model",
      };
      for (const chunk of [
        { ...envelope, choices: [{ index: 0, delta: { role: "assistant", content: "Hello" } }] },
        { ...envelope, choices: [{ index: 0, delta: { content: " there" } }] },
        {
          ...envelope,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
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
        requests,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => {
              done();
            });
          }),
      });
    });
  });
}

const silentEmitter = (deltas: Array<string>): TurnEmitter => ({
  assistantText: ({ delta }) =>
    Effect.sync(() => {
      deltas.push(delta);
    }),
  reasoning: () => Effect.void,
  assistantMessageItem: () => Effect.void,
  toolItem: () => Effect.void,
  tokenUsage: () => Effect.void,
});

describe("the loop over a real HTTP transport", () => {
  it.live("sends a request and streams the answer back", () =>
    Effect.gen(function* () {
      const stub = yield* Effect.promise(() => startStubServer());
      const deltas: Array<string> = [];

      const result = yield* Effect.ensuring(
        Effect.gen(function* () {
          const toolkit = yield* buildToolkit([]);
          const modelLayer = resolveLanguageModel({
            backend: "openai-compat",
            credential: Redacted.make("not-required"),
            model: "stub-model",
            baseUrl: stub.baseUrl,
          });

          return yield* runTurn({
            threadId: THREAD,
            turnId: TURN,
            model: "stub-model",
            contextWindow: 128_000,
            prompt: Prompt.make([
              { role: "system", content: "be brief" },
              { role: "user", content: [{ type: "text", text: "say hello" }] },
            ]),
            toolkit,
            emitter: silentEmitter(deltas),
            isInterrupted: () => false,
          }).pipe(Effect.provide(modelLayer));
        }),
        Effect.promise(() => stub.close()),
      );

      // The answer came back over the wire, in pieces.
      expect(result.text).toBe("Hello there");
      expect(result.stopReason).toBe("completed");
      expect(deltas).toEqual(["Hello", " there"]);

      // And the request that went out carried the conversation.
      const sent = stub.requests[0] as {
        model?: string;
        messages?: ReadonlyArray<{ role: string }>;
      };
      expect(sent.model).toBe("stub-model");
      expect(sent.messages?.map((message) => message.role)).toEqual(["system", "user"]);

      // Usage came back from the provider rather than being guessed at.
      expect(result.usage.inputTokens).toBe(11);
      expect(result.usage.outputTokens).toBe(3);
    }).pipe(Effect.provide(FetchHttpClient.layer), Effect.provide(NodeServices.layer)),
  );
});
