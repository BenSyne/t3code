/**
 * One turn: ask the model, run what it asked for, ask again, until it is done.
 *
 * This is the file to read to understand the agent. Everything else in
 * `agent/` exists to keep this one readable — the stopping rule is in
 * `stepPolicy`, the event vocabulary in `events/`, the tools behind a registry —
 * so that the shape of a turn fits on a screen and says what it does.
 *
 * ## The loop
 *
 * A *step* is one request to the model. The model streams back text, reasoning,
 * and tool calls; the AI stack runs the tools and streams their results. If the
 * step asked for tools, their results go into the prompt and we take another
 * step. If it did not, the model has answered and the turn is over.
 *
 * ## Two things that are easy to get wrong
 *
 * The prompt is rebuilt from the response *parts*, not from the text we
 * rendered. Tool calls and their results have to be in the history verbatim or
 * the next request is malformed, and providers reject it in ways that read like
 * a model failure rather than a bug here.
 *
 * A tool that throws — not fails, throws — must not take the turn with it. Tools
 * are built `failureMode: "return"`, and `Effect.catchDefect` at the turn
 * boundary catches what that does not.
 *
 * @module agent/loop/runTurn
 */
import type { RuntimeItemId, ThreadId, TurnId } from "@t3tools/contracts";
import { RuntimeItemId as makeRuntimeItemId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as LanguageModel from "effect/unstable/ai/LanguageModel";
import * as Prompt from "effect/unstable/ai/Prompt";
import type * as Response from "effect/unstable/ai/Response";

import { describeToolCall, describeToolResult } from "../events/toolItemMapping.ts";
import { EMPTY_USAGE, foldUsage, toUsageSnapshot, type UsageTally } from "../events/usage.ts";
import type { AgentToolkit } from "../tools/registry.ts";
import {
  DEFAULT_STEP_LIMITS,
  decideNextStep,
  describeStop,
  EMPTY_TALLY,
  recordStep,
  type StepLimits,
  type StepStopReason,
} from "./stepPolicy.ts";

/** What the loop needs to talk to the outside world. */
export interface TurnEmitter {
  readonly assistantText: (input: {
    threadId: ThreadId;
    turnId: TurnId;
    delta: string;
  }) => Effect.Effect<void>;
  readonly reasoning: (input: {
    threadId: ThreadId;
    turnId: TurnId;
    delta: string;
  }) => Effect.Effect<void>;
  readonly assistantMessageItem: (input: {
    threadId: ThreadId;
    turnId: TurnId;
    itemId: RuntimeItemId;
    lifecycle: "item.started" | "item.completed";
  }) => Effect.Effect<void>;
  readonly toolItem: (input: {
    threadId: ThreadId;
    turnId: TurnId;
    itemId: RuntimeItemId;
    lifecycle: "item.started" | "item.updated" | "item.completed";
    itemType: ReturnType<typeof describeToolCall>["itemType"];
    status: "inProgress" | "completed" | "failed";
    title: string;
    detail?: string | undefined;
    data?: Record<string, unknown> | undefined;
  }) => Effect.Effect<void>;
  readonly tokenUsage: (input: {
    threadId: ThreadId;
    usage: ReturnType<typeof toUsageSnapshot>;
  }) => Effect.Effect<void>;
}

export interface RunTurnInput {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly model: string;
  /** Context window for the usage meter, or null when we do not know it. */
  readonly contextWindow: number | null;
  readonly prompt: Prompt.Prompt;
  readonly toolkit: AgentToolkit;
  readonly emitter: TurnEmitter;
  readonly limits?: StepLimits | undefined;
  /** Checked between steps. Lets a stop request land without killing the fiber. */
  readonly isInterrupted: () => boolean;
}

export interface RunTurnResult {
  /** The conversation including this turn, ready to be the next turn's input. */
  readonly prompt: Prompt.Prompt;
  readonly text: string;
  readonly stopReason: StepStopReason;
  readonly usage: UsageTally;
  readonly steps: number;
}

/**
 * Run the turn.
 *
 * Requires a `LanguageModel` — the caller provides it, which is what lets this
 * be tested against a stub with no network and no platform layer.
 */
export const runTurn = Effect.fn("t3agent/runTurn")(function* (input: RunTurnInput) {
  const limits = input.limits ?? DEFAULT_STEP_LIMITS;
  let prompt = input.prompt;
  let tally = EMPTY_TALLY;
  let usage = EMPTY_USAGE;
  const replies: Array<string> = [];

  for (;;) {
    const step = yield* runStep({
      threadId: input.threadId,
      turnId: input.turnId,
      prompt,
      toolkit: input.toolkit,
      emitter: input.emitter,
      stepIndex: tally.steps,
    });

    // From the parts, not from the text we rendered: tool calls and results
    // must reach the next request exactly as the provider sent them.
    prompt = Prompt.concat(prompt, Prompt.fromResponseParts(step.parts));
    if (step.text !== "") {
      replies.push(step.text);
    }

    tally = recordStep(tally, step.toolCallCount);
    if (step.usage !== null) {
      usage = foldUsage(usage, step.usage, step.toolCallCount);
      yield* input.emitter.tokenUsage({
        threadId: input.threadId,
        usage: toUsageSnapshot(usage, input.contextWindow),
      });
    }

    const decision = decideNextStep({
      tally,
      limits,
      requestedTools: step.toolCallCount > 0,
      interrupted: input.isInterrupted(),
    });

    if (decision._tag === "Stop") {
      const note = describeStop(decision.reason, limits);
      if (note !== null) {
        replies.push(note);
      }
      return {
        prompt,
        text: replies.join("\n\n"),
        stopReason: decision.reason,
        usage,
        steps: tally.steps,
      } satisfies RunTurnResult;
    }
  }
});

interface StepOutcome {
  readonly parts: ReadonlyArray<Response.AnyPart>;
  readonly text: string;
  readonly toolCallCount: number;
  readonly usage: {
    inputTokens: { total?: number | undefined; cacheRead?: number | undefined };
    outputTokens: { total?: number | undefined; reasoning?: number | undefined };
  } | null;
}

/**
 * One request, consumed as it streams.
 *
 * Every branch does two things: emit the event that makes it visible, and
 * accumulate the part that makes it remembered. Losing either is a distinct
 * bug — the first shows a blank turn, the second gives the next step amnesia.
 */
const runStep = Effect.fnUntraced(function* (input: {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly prompt: Prompt.Prompt;
  readonly toolkit: AgentToolkit;
  readonly emitter: TurnEmitter;
  readonly stepIndex: number;
}) {
  const parts: Array<Response.AnyPart> = [];
  const textChunks: Array<string> = [];
  const toolCalls = new Map<string, { name: string; params: unknown }>();
  let usage: StepOutcome["usage"] = null;

  const messageItemId = makeRuntimeItemId.make(`${input.turnId}:assistant:${input.stepIndex}`);
  let messageOpen = false;

  const openMessage = Effect.suspend(() => {
    if (messageOpen) {
      return Effect.void;
    }
    messageOpen = true;
    return input.emitter.assistantMessageItem({
      threadId: input.threadId,
      turnId: input.turnId,
      itemId: messageItemId,
      lifecycle: "item.started",
    });
  });

  yield* Stream.runForEach(
    LanguageModel.streamText({ prompt: input.prompt, toolkit: input.toolkit }),
    (part) =>
      Effect.gen(function* () {
        parts.push(part as Response.AnyPart);

        switch (part.type) {
          case "text-delta": {
            if (part.delta === "") {
              return;
            }
            yield* openMessage;
            textChunks.push(part.delta);
            yield* input.emitter.assistantText({
              threadId: input.threadId,
              turnId: input.turnId,
              delta: part.delta,
            });
            return;
          }

          case "reasoning-delta": {
            if (part.delta === "") {
              return;
            }
            yield* input.emitter.reasoning({
              threadId: input.threadId,
              turnId: input.turnId,
              delta: part.delta,
            });
            return;
          }

          case "tool-call": {
            toolCalls.set(part.id, { name: part.name, params: part.params });
            const described = describeToolCall({ toolName: part.name, params: part.params });
            yield* input.emitter.toolItem({
              threadId: input.threadId,
              turnId: input.turnId,
              itemId: makeRuntimeItemId.make(part.id),
              lifecycle: "item.started",
              status: "inProgress",
              itemType: described.itemType,
              title: described.title,
              detail: described.detail,
              data: described.data,
            });
            return;
          }

          case "tool-result": {
            const call = toolCalls.get(part.id);
            const described = describeToolCall({
              toolName: part.name,
              params: call?.params ?? {},
            });
            const outcome = describeToolResult({ toolName: part.name, result: part.result });
            yield* input.emitter.toolItem({
              threadId: input.threadId,
              turnId: input.turnId,
              itemId: makeRuntimeItemId.make(part.id),
              lifecycle: "item.completed",
              status: outcome.status,
              itemType: described.itemType,
              title: described.title,
              detail: outcome.detail ?? described.detail,
              data: described.data,
            });
            return;
          }

          case "finish": {
            usage = part.usage;
            return;
          }

          default:
            return;
        }
      }),
  );

  if (messageOpen) {
    yield* input.emitter.assistantMessageItem({
      threadId: input.threadId,
      turnId: input.turnId,
      itemId: messageItemId,
      lifecycle: "item.completed",
    });
  }

  return {
    parts,
    text: textChunks.join(""),
    toolCallCount: toolCalls.size,
    usage,
  } satisfies StepOutcome;
});
