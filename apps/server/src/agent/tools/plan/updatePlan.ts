/**
 * The agent's working plan, kept where the user can see it.
 *
 * The tool stores nothing: the conversation already carries every call, and
 * the timeline renders the latest one. What the handler adds is validation
 * with readable errors, and a summary line so the timeline can show "2/5 done"
 * without parsing the plan itself.
 *
 * @module agent/tools/plan/updatePlan
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";

import { toolFailure, ToolFailure } from "../failure.ts";
import { defineTool, type AgentTool } from "../registry.ts";
import { optionalParam } from "../optionalParam.ts";

export const PLAN_STATUSES = ["pending", "in_progress", "completed"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export interface PlanStep {
  readonly step: string;
  readonly status: PlanStatus;
}

const UpdatePlanTool = Tool.make("update_plan", {
  description:
    "Keep a short step-by-step plan the user can watch. Send the whole plan each time, " +
    "with one step in_progress. Use it for work that takes several actions in sequence; " +
    "skip it for anything you can just do. Do not repeat the plan in your reply — the " +
    "user already sees it.",
  parameters: Schema.Struct({
    plan: Schema.Array(
      // Validated in the handler rather than the schema, like reasoning
      // efforts: a readable "not a status" beats a decode error the model
      // cannot act on.
      Schema.Struct({
        step: Schema.String.annotate({ description: "One short sentence." }),
        status: Schema.String.annotate({
          description: 'One of "pending", "in_progress", or "completed".',
        }),
      }),
    ),
    explanation: optionalParam(
      Schema.String.annotate({
        description: "Only when the plan changed shape: one line on why.",
      }),
    ),
  }),
  success: Schema.Struct({
    /** e.g. "2/5 done — in progress: wire the adapter". */
    summary: Schema.String,
  }),
  failure: ToolFailure,
  failureMode: "return",
});

export function makeUpdatePlanTool(): AgentTool {
  return defineTool(
    UpdatePlanTool,
    Effect.fnUntraced(function* (params) {
      if (params.plan.length === 0) {
        return yield* toolFailure("An empty plan says nothing. Send at least one step.");
      }
      for (const entry of params.plan) {
        if (!isPlanStatus(entry.status)) {
          return yield* toolFailure(
            `"${entry.status}" is not a status. Use one of: ${PLAN_STATUSES.join(", ")}.`,
          );
        }
        if (entry.step.trim() === "") {
          return yield* toolFailure("Every step needs words in it.");
        }
      }
      return { summary: summarizePlan(params.plan as ReadonlyArray<PlanStep>) };
    }),
  );
}

function isPlanStatus(value: string): value is PlanStatus {
  return (PLAN_STATUSES as ReadonlyArray<string>).includes(value);
}

export function summarizePlan(plan: ReadonlyArray<PlanStep>): string {
  const done = plan.filter((entry) => entry.status === "completed").length;
  const current = plan.find((entry) => entry.status === "in_progress");
  const progress = `${done}/${plan.length} done`;
  return current === undefined ? progress : `${progress} — in progress: ${current.step}`;
}
