/**
 * How a tool call looks in the timeline.
 *
 * T3 Code's UI does not render "a tool ran" — it renders a *command*, a *file
 * change*, a *search*. Those are `CanonicalItemType`s, and picking the right one
 * is what decides whether a `bash` call shows up as a terminal block with its
 * output or as an anonymous grey box. Getting it wrong is silent: the item is
 * stored, it is just rendered as nothing in particular.
 *
 * Pure, so the whole mapping can be table-tested without a model.
 *
 * @module agent/events/toolItemMapping
 */
import type { CanonicalItemType } from "@t3tools/contracts";

export interface ToolItemDescriptor {
  readonly itemType: CanonicalItemType;
  /** One line, shown collapsed. Never empty — the UI hides an empty title. */
  readonly title: string;
  readonly detail?: string | undefined;
  readonly data?: Record<string, unknown> | undefined;
}

/**
 * Describe a call the model just made.
 *
 * The core tools are named explicitly because their parameters are known and a
 * good title can be built from them. Everything else — MCP, skills, anything
 * added later — falls through to a generic description rather than a wrong one.
 */
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
    default:
      return { itemType: "dynamic_tool_call", title: input.toolName };
  }
}

export interface ToolResultDescriptor {
  readonly status: "completed" | "failed";
  readonly detail?: string | undefined;
}

/**
 * Describe how the call ended.
 *
 * A tool that returned a `ToolFailure` is a *failed item*, not a completed one
 * carrying bad news — otherwise the timeline shows a tick next to something that
 * did not work.
 */
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
