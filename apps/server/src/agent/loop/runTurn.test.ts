import { ThreadId, TurnId } from "@t3tools/contracts";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as AiError from "effect/unstable/ai/AiError";
import * as LanguageModel from "effect/unstable/ai/LanguageModel";
import * as Prompt from "effect/unstable/ai/Prompt";
import type * as Response from "effect/unstable/ai/Response";
import * as Tool from "effect/unstable/ai/Tool";

import { ToolFailure } from "../tools/failure.ts";
import { buildToolkit, defineTool, type AgentTool } from "../tools/registry.ts";
import { runTurn, type TurnEmitter } from "./runTurn.ts";

const THREAD = ThreadId.make("thread-1");
const TURN = TurnId.make("turn-1");

/** Records every event the loop emits so a test can assert on the timeline. */
function recordingEmitter() {
  const events: Array<{ kind: string; detail?: string }> = [];
  const note = (kind: string, detail?: string) =>
    Effect.sync(() => {
      events.push(detail === undefined ? { kind } : { kind, detail });
    });

  const emitter: TurnEmitter = {
    assistantText: ({ delta }) => note("text", delta),
    reasoning: ({ delta }) => note("reasoning", delta),
    assistantMessageItem: ({ lifecycle }) => note(`message:${lifecycle}`),
    toolItem: ({ lifecycle, status, title }) => note(`tool:${lifecycle}:${status}`, title),
    tokenUsage: ({ usage }) => note("usage", String(usage.usedTokens)),
  };

  return { emitter, events };
}

const usagePart = (input: number, output: number): Response.StreamPartEncoded => ({
  type: "finish",
  reason: "stop",
  usage: { inputTokens: { total: input }, outputTokens: { total: output } },
});

/**
 * A model that replays a scripted response per step.
 *
 * Nothing here reaches the network, so the loop's behaviour — how many steps it
 * takes, what it remembers, what it emits — is fully determined by the script.
 */
function scriptedModel(steps: ReadonlyArray<ReadonlyArray<Response.StreamPartEncoded>>) {
  const seen: Array<Prompt.Prompt> = [];
  let index = 0;

  const layer = Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: (options) => {
        seen.push(options.prompt as Prompt.Prompt);
        const script = steps[Math.min(index, steps.length - 1)] ?? [];
        index += 1;
        return Stream.fromArray(script);
      },
    }),
  );

  return { layer, seen, stepCount: () => index };
}

/**
 * A model that fails to decode `failures` times, then replays the script.
 *
 * The real failure this stands in for is the model naming a tool that does not
 * exist: the toolkit cannot decode the response and the whole step fails. It
 * only happens against a misbehaving provider, so it is unreachable in a test
 * without forging it.
 */
function unreadableThenScriptedModel(
  failures: number,
  steps: ReadonlyArray<ReadonlyArray<Response.StreamPartEncoded>>,
) {
  let index = 0;
  const layer = Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: () => {
        const attempt = index;
        index += 1;
        if (attempt < failures) {
          return Stream.fail(
            new AiError.AiError({
              module: "TestModel",
              method: "streamText",
              reason: new AiError.InvalidOutputError({
                description: 'Expected "read" at [2]["name"]',
              }),
            }),
          );
        }
        return Stream.fromArray(steps[Math.min(attempt - failures, steps.length - 1)] ?? []);
      },
    }),
  );
  return { layer, callCount: () => index };
}

const okTool = (name: string, reply: string): AgentTool =>
  defineTool(
    Tool.make(name, {
      description: "test tool",
      parameters: Schema.Struct({ value: Schema.String }),
      success: Schema.Struct({ said: Schema.String }),
      failure: ToolFailure,
      failureMode: "return",
    }),
    () => Effect.succeed({ said: reply }),
  );

/** A tool whose handler throws rather than failing. The defect-containment case. */
const throwingTool = (name: string): AgentTool =>
  defineTool(
    Tool.make(name, {
      description: "explodes",
      parameters: Schema.Struct({ value: Schema.String }),
      success: Schema.Struct({ said: Schema.String }),
      failure: ToolFailure,
      failureMode: "return",
    }),
    () =>
      Effect.sync(() => {
        throw new Error("boom");
      }),
  );

const run = (input: {
  script: ReadonlyArray<ReadonlyArray<Response.StreamPartEncoded>>;
  tools?: ReadonlyArray<AgentTool>;
  interrupted?: () => boolean;
  limits?: { maxSteps: number; maxToolCalls: number };
}) =>
  Effect.gen(function* () {
    const model = scriptedModel(input.script);
    const { emitter, events } = recordingEmitter();
    const toolkit = yield* buildToolkit(input.tools ?? []);

    const result = yield* runTurn({
      threadId: THREAD,
      turnId: TURN,
      model: "test-model",
      contextWindow: 200_000,
      prompt: Prompt.make([{ role: "user", content: [{ type: "text", text: "hi" }] }]),
      toolkit,
      emitter,
      isInterrupted: input.interrupted ?? (() => false),
      ...(input.limits === undefined ? {} : { limits: input.limits }),
    }).pipe(Effect.provide(model.layer));

    return { result, events, model };
  });

describe("runTurn", () => {
  it.effect("returns the model's answer and stops when it stops asking for tools", () =>
    Effect.gen(function* () {
      const { result, model } = yield* run({
        script: [[{ type: "text-delta", id: "t", delta: "All done." }, usagePart(10, 5)]],
      });

      expect(result.text).toBe("All done.");
      expect(result.stopReason).toBe("completed");
      expect(result.steps).toBe(1);
      expect(model.stepCount()).toBe(1);
    }),
  );

  it.effect("streams text as it arrives rather than in one lump at the end", () =>
    Effect.gen(function* () {
      const { events } = yield* run({
        script: [
          [
            { type: "text-delta", id: "t", delta: "Hel" },
            { type: "text-delta", id: "t", delta: "lo" },
            usagePart(10, 5),
          ],
        ],
      });

      expect(events.filter((e) => e.kind === "text").map((e) => e.detail)).toEqual(["Hel", "lo"]);
      // The deltas are wrapped, so the client knows where the message begins
      // and ends. Usage lands after the message closes, so compare positions
      // rather than assuming the close is last.
      const kinds = events.map((e) => e.kind);
      expect(kinds[0]).toBe("message:item.started");
      expect(kinds.indexOf("message:item.completed")).toBeGreaterThan(kinds.lastIndexOf("text"));
    }),
  );

  it.effect("takes another step after a tool call and feeds the result back", () =>
    Effect.gen(function* () {
      const { result, model } = yield* run({
        tools: [okTool("lookup", "42")],
        script: [
          [
            { type: "tool-call", id: "call-1", name: "lookup", params: { value: "x" } },
            usagePart(10, 5),
          ],
          [{ type: "text-delta", id: "t", delta: "The answer is 42." }, usagePart(20, 6)],
        ],
      });

      expect(model.stepCount()).toBe(2);
      expect(result.text).toBe("The answer is 42.");
      expect(result.steps).toBe(2);

      // The second request must carry the call and its result, or the provider
      // rejects the malformed history.
      const secondRequest = model.seen[1];
      const roles = secondRequest?.content.map((message) => message.role);
      expect(roles).toContain("assistant");
      expect(roles).toContain("tool");
    }),
  );

  it.effect("marks a tool call started and completed in the timeline", () =>
    Effect.gen(function* () {
      const { events } = yield* run({
        tools: [okTool("lookup", "42")],
        script: [
          [
            { type: "tool-call", id: "call-1", name: "lookup", params: { value: "x" } },
            usagePart(10, 5),
          ],
          [{ type: "text-delta", id: "t", delta: "done" }, usagePart(20, 6)],
        ],
      });

      expect(events.map((e) => e.kind)).toContain("tool:item.started:inProgress");
      expect(events.map((e) => e.kind)).toContain("tool:item.completed:completed");
    }),
  );

  it.effect("survives a tool that throws instead of failing", () =>
    Effect.gen(function* () {
      const { result } = yield* run({
        tools: [throwingTool("explode")],
        script: [
          [
            { type: "tool-call", id: "call-1", name: "explode", params: { value: "x" } },
            usagePart(10, 5),
          ],
          [{ type: "text-delta", id: "t", delta: "Recovered." }, usagePart(20, 6)],
        ],
      });

      // The turn must reach its own ending, not die with the tool.
      expect(result.stopReason).toBe("completed");
      expect(result.text).toBe("Recovered.");
    }),
  );

  it.effect("stops at the step limit when the model never stops asking", () =>
    Effect.gen(function* () {
      const { result } = yield* run({
        tools: [okTool("lookup", "42")],
        limits: { maxSteps: 3, maxToolCalls: 100 },
        script: [
          [
            { type: "tool-call", id: "call-1", name: "lookup", params: { value: "x" } },
            usagePart(10, 5),
          ],
        ],
      });

      expect(result.stopReason).toBe("step_limit");
      expect(result.steps).toBe(3);
      expect(result.text).toContain("3 steps");
    }),
  );

  it.effect("stops between steps when interrupted", () =>
    Effect.gen(function* () {
      const { result } = yield* run({
        tools: [okTool("lookup", "42")],
        interrupted: () => true,
        script: [
          [
            { type: "tool-call", id: "call-1", name: "lookup", params: { value: "x" } },
            usagePart(10, 5),
          ],
        ],
      });

      expect(result.stopReason).toBe("interrupted");
      expect(result.text).toContain("your request");
    }),
  );

  it.effect("keeps no orphaned tool call when stopped while the tool runs", () =>
    Effect.gen(function* () {
      // Stop pressed mid-tool cuts the stream between the call and its result.
      // A call without a result must not reach the remembered conversation:
      // that history is persisted, providers reject it as malformed, and every
      // later turn on the thread then fails. This flag flips inside the
      // handler, which is exactly when a real stop lands.
      let interrupted = false;
      const stopDuringTool = defineTool(
        Tool.make("slow", {
          description: "test tool",
          parameters: Schema.Struct({ value: Schema.String }),
          success: Schema.Struct({ said: Schema.String }),
          failure: ToolFailure,
          failureMode: "return" as const,
        }),
        () =>
          Effect.sync(() => {
            interrupted = true;
            return { said: "too late" };
          }),
      );

      const { result, events } = yield* run({
        tools: [stopDuringTool],
        interrupted: () => interrupted,
        script: [
          [
            { type: "text-delta", id: "t", delta: "Working on it." },
            { type: "tool-call", id: "call-1", name: "slow", params: { value: "x" } },
            usagePart(10, 5),
          ],
        ],
      });

      expect(result.stopReason).toBe("interrupted");
      // The text that already streamed is kept; the dangling call is not.
      expect(result.text).toContain("Working on it.");
      for (const message of result.prompt.content) {
        if (typeof message.content === "string") {
          continue;
        }
        for (const part of message.content) {
          expect(part.type).not.toBe("tool-call");
        }
      }
      // And the timeline item is closed rather than left spinning.
      expect(events.map((e) => e.kind)).toContain("tool:item.completed:failed");
    }),
  );

  it.effect("accumulates usage across steps and reports it", () =>
    Effect.gen(function* () {
      const { result, events } = yield* run({
        tools: [okTool("lookup", "42")],
        script: [
          [
            { type: "tool-call", id: "call-1", name: "lookup", params: { value: "x" } },
            usagePart(10, 5),
          ],
          [{ type: "text-delta", id: "t", delta: "done" }, usagePart(30, 7)],
        ],
      });

      expect(result.usage.inputTokens).toBe(40);
      expect(result.usage.outputTokens).toBe(12);
      // Context is the last request's size, not the lifetime sum.
      expect(result.usage.contextTokens).toBe(37);
      expect(events.filter((e) => e.kind === "usage")).toHaveLength(2);
    }),
  );

  it.effect("emits reasoning separately from the answer", () =>
    Effect.gen(function* () {
      const { events } = yield* run({
        script: [
          [
            { type: "reasoning-delta", id: "r", delta: "thinking" },
            { type: "text-delta", id: "t", delta: "answer" },
            usagePart(10, 5),
          ],
        ],
      });

      expect(events.filter((e) => e.kind === "reasoning").map((e) => e.detail)).toEqual([
        "thinking",
      ]);
      expect(events.filter((e) => e.kind === "text").map((e) => e.detail)).toEqual(["answer"]);
    }),
  );

  it.effect("appends nothing for a step that produced no text", () =>
    Effect.gen(function* () {
      const { result, events } = yield* run({
        script: [[usagePart(10, 0)]],
      });

      expect(result.text).toBe("");
      expect(events.some((e) => e.kind.startsWith("message:"))).toBe(false);
    }),
  );
});

describe("a response the toolkit cannot read", () => {
  const finishedTurn = [
    [
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "recovered" },
      { type: "text-end", id: "t" },
      usagePart(10, 5),
    ] as ReadonlyArray<Response.StreamPartEncoded>,
  ];

  it.effect("nudges the model and carries on rather than losing the turn", () =>
    Effect.gen(function* () {
      // Before this, one hallucinated tool name killed the whole turn and the
      // user saw a decode error with everything the agent had done discarded.
      const model = unreadableThenScriptedModel(1, finishedTurn);
      const { emitter } = recordingEmitter();
      const toolkit = yield* buildToolkit([]);

      const result = yield* runTurn({
        threadId: THREAD,
        turnId: TURN,
        prompt: Prompt.make([{ role: "user", content: [{ type: "text", text: "go" }] }]),
        model: "test-model",
        contextWindow: 200_000,
        toolkit,
        emitter,
        isInterrupted: () => false,
      }).pipe(Effect.provide(model.layer));

      expect(result.text).toBe("recovered");
      // One failure plus one successful retry.
      expect(model.callCount()).toBe(2);
    }),
  );

  it.effect("gives up rather than retrying a model that will not converge", () =>
    Effect.gen(function* () {
      // Every retry is a paid request. A model producing garbage repeatedly
      // should surface as a failure, not bill in a loop.
      const model = unreadableThenScriptedModel(99, finishedTurn);
      const { emitter } = recordingEmitter();
      const toolkit = yield* buildToolkit([]);

      const outcome = yield* Effect.result(
        runTurn({
          threadId: THREAD,
          turnId: TURN,
          prompt: Prompt.make([{ role: "user", content: [{ type: "text", text: "go" }] }]),
          model: "test-model",
          contextWindow: 200_000,
          toolkit,
          emitter,
          isInterrupted: () => false,
        }).pipe(Effect.provide(model.layer)),
      );

      expect(outcome._tag).toBe("Failure");
      expect(model.callCount()).toBeLessThanOrEqual(4);
    }),
  );
});

describe("cache breakpoints", () => {
  const optionsOf = (prompt: Prompt.Prompt) =>
    prompt.content.map(
      (message) =>
        (message.options as { anthropic?: { cacheControl?: { type?: string } } }).anthropic
          ?.cacheControl?.type,
    );

  it.effect("marks the request it sends, not the prompt it carries forward", () =>
    Effect.gen(function* () {
      const { result, model } = yield* run({
        script: [[{ type: "text-delta", id: "t", delta: "Done." }, usagePart(10, 5)]],
      });

      // The wire request is marked so Anthropic can bill the prefix as cached…
      expect(optionsOf(model.seen[0]!)).toEqual(["ephemeral"]);
      // …and the conversation the next turn starts from is not, because the
      // mark has to move to the new tail rather than accumulate. Anthropic
      // rejects a request with more than four marks outright.
      expect(optionsOf(result.prompt).every((mark) => mark === undefined)).toBe(true);
    }),
  );
});
