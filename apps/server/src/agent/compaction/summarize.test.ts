import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as LanguageModel from "effect/unstable/ai/LanguageModel";
import * as Prompt from "effect/unstable/ai/Prompt";
import type * as Response from "effect/unstable/ai/Response";

import { compactPrompt } from "./summarize.ts";

const summariser = (reply: string) =>
  Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      generateText: () =>
        Effect.succeed([
          { type: "text", text: reply },
          {
            type: "finish",
            reason: "stop",
            usage: { inputTokens: {}, outputTokens: {} },
          },
        ] satisfies Array<Response.PartEncoded>),
      streamText: () => Stream.empty,
    }),
  );

const brokenSummariser = Layer.effect(
  LanguageModel.LanguageModel,
  LanguageModel.make({
    generateText: () => Effect.die(new Error("upstream is down")),
    streamText: () => Stream.empty,
  }),
);

const conversation = (exchanges: number) =>
  Prompt.make([
    { role: "system" as const, content: "you are an agent" },
    ...Array.from({ length: exchanges }, (_, index) => [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: `question ${index}` }],
      },
      {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: `answer ${index}` }],
      },
    ]).flat(),
  ]);

describe("compactPrompt", () => {
  it.effect("replaces old messages with a summary and keeps the system prompt", () =>
    Effect.gen(function* () {
      const outcome = yield* compactPrompt({
        prompt: conversation(10),
        preserveTokens: 40,
      }).pipe(Effect.provide(summariser("They asked ten questions.")));

      expect(outcome._tag).toBe("Compacted");
      if (outcome._tag !== "Compacted") return;

      const roles = outcome.prompt.content.map((message) => message.role);
      expect(roles[0]).toBe("system");
      expect(outcome.prompt.content.length).toBeLessThan(21);
      const summaryMessage = outcome.prompt.content.find(
        (message) =>
          message.role === "user" &&
          message.content.some(
            (part) => part.type === "text" && part.text.includes("They asked ten questions."),
          ),
      );
      expect(summaryMessage).toBeDefined();
    }),
  );

  it.effect("does nothing when there is barely any history", () =>
    Effect.gen(function* () {
      const outcome = yield* compactPrompt({
        prompt: conversation(1),
        preserveTokens: 10,
      }).pipe(Effect.provide(summariser("...")));

      // Summarising two messages risks losing the only thing that mattered and
      // saves nothing worth having.
      expect(outcome._tag).toBe("NotNeeded");
    }),
  );

  it.effect("reports a failed summary as a value rather than losing the turn", () =>
    Effect.gen(function* () {
      const outcome = yield* compactPrompt({
        prompt: conversation(10),
        preserveTokens: 40,
      }).pipe(
        Effect.provide(brokenSummariser),
        Effect.orElseSucceed(() => null),
      );

      // The caller continues on the original conversation. Dying here would
      // cost the user their turn over a failed optimisation.
      expect(outcome).not.toBeNull();
      expect(outcome?._tag).toBe("Failed");
    }),
  );

  it.effect("treats an empty summary as a failure, not a successful erasure", () =>
    Effect.gen(function* () {
      const outcome = yield* compactPrompt({
        prompt: conversation(10),
        preserveTokens: 40,
      }).pipe(Effect.provide(summariser("   ")));

      expect(outcome._tag).toBe("Failed");
    }),
  );
});
