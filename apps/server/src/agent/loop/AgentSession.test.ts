import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as LanguageModel from "effect/unstable/ai/LanguageModel";
import type * as Response from "effect/unstable/ai/Response";
import * as Prompt from "effect/unstable/ai/Prompt";
import { describe, expect, it } from "vite-plus/test";

import {
  closeSession,
  runTurn,
  setSessionStatus,
  type AgentSessionContext,
} from "./AgentSession.ts";

/**
 * A language model that answers with fixed text and records what it was asked.
 * Keeps these tests offline and deterministic.
 */
function stubModel(reply: string) {
  const seen: Array<Prompt.Prompt> = [];
  const layer = Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      generateText: (options) =>
        Effect.sync(() => {
          seen.push(options.prompt);
          return [
            { type: "text", text: reply },
            // `inputTokens`/`outputTokens` are required keys whose own fields
            // are optional — omitting them fails decoding, not typechecking.
            { type: "finish", reason: "stop", usage: { inputTokens: {}, outputTokens: {} } },
          ] satisfies Array<Response.PartEncoded>;
        }),
      streamText: () => Stream.empty,
    }),
  );
  return { layer, seen };
}

function makeContext(layer: AgentSessionContext["modelLayer"]): AgentSessionContext {
  return {
    session: {
      provider: "t3agent" as AgentSessionContext["session"]["provider"],
      status: "ready",
      runtimeMode: "default" as AgentSessionContext["session"]["runtimeMode"],
      threadId: ThreadId.make("thread-1"),
      createdAt: "2026-08-08T22:00:00.000Z",
      updatedAt: "2026-08-08T22:00:00.000Z",
    },
    model: "claude-sonnet-5",
    modelLayer: layer,
    prompt: Prompt.empty,
    stopped: false,
  };
}

describe("runTurn", () => {
  it("returns the assistant reply", async () => {
    const { layer } = stubModel("Hello there");
    const context = makeContext(layer);

    const result = await Effect.runPromise(runTurn(context, { text: "hi" }));

    expect(result.text).toBe("Hello there");
    expect(result.finishReason).toBe("stop");
  });

  it("carries the conversation into the next turn", async () => {
    const { layer, seen } = stubModel("second");
    const context = makeContext(layer);

    await Effect.runPromise(runTurn(context, { text: "first question" }));
    await Effect.runPromise(runTurn(context, { text: "second question" }));

    // The second request must contain the whole exchange, or the agent has
    // amnesia between turns.
    const roles = seen[1]?.content.map((message) => message.role);
    expect(roles).toEqual(["user", "assistant", "user"]);
  });

  it("keeps the user message when the model fails", async () => {
    const failing = Layer.effect(
      LanguageModel.LanguageModel,
      LanguageModel.make({
        generateText: () => Effect.die(new Error("upstream is down")),
        streamText: () => Stream.empty,
      }),
    );
    const context = makeContext(failing);

    await Effect.runPromise(Effect.exit(runTurn(context, { text: "hi" })));

    // Dropping it would silently rewrite history the user watched arrive.
    expect(context.prompt.content.map((message) => message.role)).toEqual(["user"]);
  });

  it("does not append an empty assistant message", async () => {
    const { layer } = stubModel("");
    const context = makeContext(layer);

    await Effect.runPromise(runTurn(context, { text: "hi" }));

    expect(context.prompt.content.map((message) => message.role)).toEqual(["user"]);
  });
});

describe("session lifecycle", () => {
  it("closes once and reports whether it did the closing", () => {
    const { layer } = stubModel("x");
    const context = makeContext(layer);

    expect(closeSession(context, "2026-08-08T22:01:00.000Z")).toBe(true);
    expect(context.session.status).toBe("closed");
    // Idempotent: stopping a stopped session must not emit a second exit event.
    expect(closeSession(context, "2026-08-08T22:02:00.000Z")).toBe(false);
  });

  it("updates status without disturbing the rest of the record", () => {
    const { layer } = stubModel("x");
    const context = makeContext(layer);

    setSessionStatus(context, "running", "2026-08-08T22:03:00.000Z");

    expect(context.session.status).toBe("running");
    expect(context.session.threadId).toBe(ThreadId.make("thread-1"));
    expect(context.session.updatedAt).toBe("2026-08-08T22:03:00.000Z");
  });
});
