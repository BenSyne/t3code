/**
 * The `task` tool: hand a self-contained job to a fresh agent.
 *
 * Worth having for one reason — context. A search that reads forty files to
 * find three costs the main conversation forty files' worth of context whether
 * or not they mattered. A sub-agent reads them in its own conversation and
 * returns a paragraph.
 *
 * ## The depth cap is not optional
 *
 * A sub-agent with a `task` tool can spawn a sub-agent. Without a cap that is
 * an unbounded fan-out of paid API calls, started by a model, on a user's key,
 * and the first they would know is the bill. Children are created at depth + 1
 * and lose the tool entirely at the cap, so the recursion cannot continue even
 * if a model tries.
 *
 * @module agent/subagent/taskTool
 */
import type { ThreadId, TurnId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as LanguageModel from "effect/unstable/ai/LanguageModel";
import * as Prompt from "effect/unstable/ai/Prompt";
import * as Tool from "effect/unstable/ai/Tool";

import { runTurn, type TurnEmitter } from "../loop/runTurn.ts";
import { ToolFailure, toolFailure } from "../tools/failure.ts";
import {
  defineTool,
  type AgentTool,
  type AgentToolkit,
  type ToolContributor,
} from "../tools/registry.ts";

/**
 * Two levels: the main agent may delegate, and its child may delegate once
 * more. Three has never been needed for a coding task and doubles the worst
 * case again.
 */
export const MAX_SUBAGENT_DEPTH = 2;

/** A sub-agent gets fewer steps than a main turn: its job is meant to be narrow. */
const SUBAGENT_STEP_LIMITS = { maxSteps: 15, maxToolCalls: 60 };

const TaskTool = Tool.make("task", {
  description:
    "Delegate a self-contained piece of work to a fresh agent and get back a summary. " +
    "Use for searches that would read many files, or for work whose details you do not need to keep. " +
    "The sub-agent cannot ask you questions, so give it everything it needs in one go.",
  parameters: Schema.Struct({
    description: Schema.String.annotate({
      description: "A few words naming the job, shown to the user.",
    }),
    prompt: Schema.String.annotate({
      description: "The complete instructions. The sub-agent sees nothing else from this session.",
    }),
  }),
  success: Schema.Struct({ result: Schema.String }),
  failure: ToolFailure,
  failureMode: "return",
});

export interface SubagentContext {
  /** How deep the *current* agent is. Children run at one more. */
  readonly depth: number;
  /**
   * Read when the tool runs, not when it is built.
   *
   * The prompt names the tools available, and the tools include this one, so
   * taking it by value here is a cycle — and one that only shows up at runtime,
   * as a "cannot access before initialization" on the first turn.
   */
  readonly systemPrompt: () => string;
  readonly contextWindow: number | null;
  /**
   * Build the child's tools at the given depth.
   *
   * A function rather than a value because the child's toolkit differs from the
   * parent's: at the cap it must not contain `task`.
   */
  readonly toolkitForDepth: (depth: number) => Effect.Effect<AgentToolkit>;
  /** The model the child talks to. The same one the parent is using. */
  readonly modelLayer: Layer.Layer<LanguageModel.LanguageModel>;
  /** Reports the child's progress into the parent's timeline. */
  readonly emitter: TurnEmitter;
  readonly threadId: ThreadId;
  /**
   * Read when the tool runs, not when it is built.
   *
   * A sub-agent runs inside its parent's turn, and that turn's id is only known
   * once the turn starts — long after the toolkit was assembled.
   */
  readonly resolveTurnId: () => TurnId | undefined;
  readonly isInterrupted: () => boolean;
}

export function makeTaskTool(context: SubagentContext): AgentTool {
  return defineTool(
    TaskTool,
    Effect.fnUntraced(function* (params) {
      const childDepth = context.depth + 1;
      if (childDepth > MAX_SUBAGENT_DEPTH) {
        return yield* toolFailure("Sub-agents cannot be nested any deeper. Do this work yourself.");
      }

      const turnId = context.resolveTurnId();
      if (turnId === undefined) {
        return yield* toolFailure("There is no turn in progress to delegate from.");
      }

      const toolkit = yield* context.toolkitForDepth(childDepth);

      const outcome = yield* Effect.result(
        runTurn({
          threadId: context.threadId,
          turnId,
          model: "",
          contextWindow: context.contextWindow,
          prompt: Prompt.make([
            { role: "system", content: `${context.systemPrompt()}\n\n${SUBAGENT_ADDENDUM}` },
            { role: "user", content: [{ type: "text", text: params.prompt }] },
          ]),
          toolkit,
          emitter: context.emitter,
          limits: SUBAGENT_STEP_LIMITS,
          isInterrupted: context.isInterrupted,
        }).pipe(Effect.provide(context.modelLayer)),
      );

      if (outcome._tag === "Failure") {
        return yield* toolFailure(`The sub-agent failed: ${describe(outcome.failure)}`);
      }
      if (outcome.success.text.trim() === "") {
        return yield* toolFailure("The sub-agent finished without reporting anything.");
      }

      return { result: outcome.success.text };
    }),
  );
}

/**
 * Contributed only below the cap.
 *
 * Absent rather than present-and-refusing at the deepest level: a tool the
 * model can see is a tool it will try, and spending a step to be told no is
 * worse than never offering it.
 */
export function subagentContributor(context: SubagentContext): ToolContributor {
  return {
    name: "subagent",
    tools: () => Effect.succeed(context.depth >= MAX_SUBAGENT_DEPTH ? [] : [makeTaskTool(context)]),
  };
}

const SUBAGENT_ADDENDUM = `You are a sub-agent working on one delegated task. You cannot ask questions — finish with what you were given.

End with a short report of what you found or did. That report is the only thing the agent that delegated to you will see, so put the answer in it rather than describing where the answer is.`;

function describe(error: unknown): string {
  return error instanceof Error && error.message !== "" ? error.message : "unknown error";
}
