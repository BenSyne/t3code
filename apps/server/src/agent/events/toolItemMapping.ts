/**
 * How a tool call looks in the timeline.
 *
 * @module agent/events/toolItemMapping
 */
import type { CanonicalItemType } from "@t3tools/contracts";

import {
  summarizePlan,
  type PlanStatus,
  PLAN_STATUSES,
  type PlanStep,
} from "../tools/plan/updatePlan.ts";

export interface ToolItemDescriptor {
  readonly itemType: CanonicalItemType;
  /** One line, shown collapsed. Never empty — the UI hides an empty title. */
  readonly title: string;
  readonly detail?: string | undefined;
  readonly data?: Record<string, unknown> | undefined;
}

/** Describe a call the model just made. */
export function describeToolCall(input: {
  readonly toolName: string;
  readonly params: unknown;
}): ToolItemDescriptor {
  const params = asRecord(input.params);

  switch (input.toolName) {
    case "bash": {
      const command = stringField(params, "command") ?? "";
      return {
        itemType: "command_execution",
        title: stringField(params, "description") ?? (command === "" ? "Run a command" : command),
        detail: command === "" ? undefined : command,
        data: { command },
      };
    }
    case "write": {
      const path = stringField(params, "filePath") ?? "a file";
      return { itemType: "file_change", title: `Write ${path}`, data: { path } };
    }
    case "edit": {
      const path = stringField(params, "filePath") ?? "a file";
      return { itemType: "file_change", title: `Edit ${path}`, data: { path } };
    }
    case "read": {
      const path = stringField(params, "filePath") ?? "a file";
      return { itemType: "dynamic_tool_call", title: `Read ${path}`, data: { path } };
    }
    case "glob": {
      const pattern = stringField(params, "pattern") ?? "";
      return { itemType: "dynamic_tool_call", title: `Find ${pattern}`.trim() };
    }
    case "grep": {
      const pattern = stringField(params, "pattern") ?? "";
      return { itemType: "dynamic_tool_call", title: `Search for ${pattern}`.trim() };
    }
    case "webfetch": {
      const url = stringField(params, "url") ?? "a page";
      return { itemType: "dynamic_tool_call", title: `Fetch ${url}`, data: { url } };
    }
    case "update_plan": {
      const plan = planSteps(params);
      if (plan.length === 0) {
        return { itemType: "dynamic_tool_call", title: "Update the plan" };
      }
      return {
        itemType: "dynamic_tool_call",
        title: `Plan: ${summarizePlan(plan)}`,
        detail: plan.map((entry) => `${PLAN_MARKS[entry.status]} ${entry.step}`).join("\n"),
        data: { plan },
      };
    }
    default:
      return { itemType: "dynamic_tool_call", title: input.toolName };
  }
}

export interface ToolResultDescriptor {
  readonly status: "completed" | "failed";
  readonly detail?: string | undefined;
}

/** Describe how the call ended. */
export function describeToolResult(input: {
  readonly toolName: string;
  readonly result: unknown;
}): ToolResultDescriptor {
  const result = asRecord(input.result);

  const failureMessage = toolFailureMessage(result);
  if (failureMessage !== null) {
    return { status: "failed", detail: failureMessage };
  }

  if (input.toolName === "bash") {
    const exitCode = numberField(result, "exitCode");
    if (exitCode !== null && exitCode !== 0) {
      return { status: "failed", detail: `Exited with code ${exitCode}` };
    }
  }

  return { status: "completed" };
}

/** `null` when the result is not a failure, so the caller can tell them apart. */
function toolFailureMessage(result: Record<string, unknown> | null): string | null {
  if (result === null || result["_tag"] !== "ToolFailure") {
    return null;
  }
  const message = result["message"];
  return typeof message === "string" && message !== "" ? message : "The tool failed.";
}

const PLAN_MARKS: Record<PlanStatus, string> = {
  completed: "✓",
  in_progress: "▸",
  pending: "○",
};

/** The steps as sent, dropping anything that is not one. Presentation only. */
function planSteps(params: Record<string, unknown> | null): ReadonlyArray<PlanStep> {
  const raw = params?.["plan"];
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((candidate) => {
    const entry = asRecord(candidate);
    const step = stringField(entry, "step");
    const status = stringField(entry, "status");
    return step !== null &&
      status !== null &&
      (PLAN_STATUSES as ReadonlyArray<string>).includes(status)
      ? [{ step, status: status as PlanStatus }]
      : [];
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function numberField(record: Record<string, unknown> | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
