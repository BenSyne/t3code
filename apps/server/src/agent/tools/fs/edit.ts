/**
 * Change part of a file by exact string replacement.
 *
 * Exact, not fuzzy, and ambiguity is an error rather than a guess. If
 * `oldString` appears twice and the model did not say `replaceAll`, we refuse
 * and say how many times it matched: a tool that silently picks the first
 * occurrence will eventually edit the wrong one, and the model has no way to
 * find out that it did.
 *
 * @module agent/tools/fs/edit
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";

import { describeFileSystemFailure, ToolFailure, toolFailure } from "../failure.ts";
import { defineTool, type AgentTool, type AgentToolContext } from "../registry.ts";
import { resolveExisting } from "../safePath.ts";
import { optionalParam } from "../optionalParam.ts";

const EditTool = Tool.make("edit", {
  description:
    "Replace an exact string in a file. The string must appear exactly once unless `replaceAll` is set. " +
    "Include enough surrounding context to make it unique.",
  parameters: Schema.Struct({
    filePath: Schema.String.annotate({
      description: "Path to the file, absolute or relative to the project root.",
    }),
    oldString: Schema.String.annotate({
      description: "Exact text to replace, including indentation.",
    }),
    newString: Schema.String.annotate({ description: "Text to put in its place." }),
    replaceAll: optionalParam(
      Schema.Boolean.annotate({
        description: "Replace every occurrence instead of requiring exactly one.",
      }),
    ),
  }),
  success: Schema.Struct({
    path: Schema.String,
    replacements: Schema.Number,
  }),
  failure: ToolFailure,
  failureMode: "return",
});

export function makeEditTool(context: AgentToolContext): AgentTool {
  return defineTool(
    EditTool,
    Effect.fnUntraced(function* (params) {
      const target = yield* resolveExisting({
        fileSystem: context.fileSystem,
        workspaceRoot: context.workspaceRoot,
        candidate: params.filePath,
      });

      const original = yield* Effect.mapError(
        context.fileSystem.readFileString(target.absolutePath),
        (cause) =>
          describeFileSystemFailure({
            cause,
            displayPath: target.relativePath,
            operation: "read",
          }),
      );

      const edited = applyEdit({
        content: original,
        oldString: params.oldString,
        newString: params.newString,
        replaceAll: params.replaceAll ?? false,
      });

      if (edited._tag !== "Edited") {
        return yield* toolFailure(describeEditRefusal(edited, target.relativePath));
      }

      yield* Effect.mapError(
        context.fileSystem.writeFileString(target.absolutePath, edited.content),
        (cause) =>
          describeFileSystemFailure({
            cause,
            displayPath: target.relativePath,
            operation: "write",
          }),
      );

      return { path: target.relativePath, replacements: edited.replacements };
    }),
  );
}

export type EditOutcome =
  | { readonly _tag: "Edited"; readonly content: string; readonly replacements: number }
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "Ambiguous"; readonly occurrences: number }
  | { readonly _tag: "Unchanged" };

/**
 * Apply the replacement, or explain why it was refused.
 *
 * Pure, and separately tested, because every failure mode here is one the model
 * will hit: whitespace that does not match, a string that appears twice, an
 * edit that would change nothing.
 */
export function applyEdit(input: {
  readonly content: string;
  readonly oldString: string;
  readonly newString: string;
  readonly replaceAll: boolean;
}): EditOutcome {
  if (input.oldString === input.newString) {
    return { _tag: "Unchanged" };
  }

  const occurrences = countOccurrences(input.content, input.oldString);
  if (occurrences === 0) {
    return { _tag: "NotFound" };
  }
  if (occurrences > 1 && !input.replaceAll) {
    return { _tag: "Ambiguous", occurrences };
  }

  const content = input.replaceAll
    ? input.content.split(input.oldString).join(input.newString)
    : replaceFirst(input.content, input.oldString, input.newString);

  return { _tag: "Edited", content, replacements: input.replaceAll ? occurrences : 1 };
}

function describeEditRefusal(outcome: EditOutcome, displayPath: string): string {
  switch (outcome._tag) {
    case "NotFound":
      return `That exact text was not found in ${displayPath}. Read the file and copy the text, including its indentation.`;
    case "Ambiguous":
      return `That text appears ${outcome.occurrences} times in ${displayPath}. Add surrounding context to make it unique, or set replaceAll.`;
    case "Unchanged":
      return "oldString and newString are identical, so this edit would change nothing.";
    case "Edited":
      // Unreachable: the caller checks for `Edited` first. Kept so the switch is
      // exhaustive and stays that way if the outcome type grows.
      return `Edited ${displayPath}.`;
  }
}

/**
 * `split`/`join` rather than `String.replace`, which interprets `$&` and
 * friends in the replacement — a real hazard when the new text is source code.
 */
function replaceFirst(content: string, oldString: string, newString: string): string {
  const at = content.indexOf(oldString);
  return content.slice(0, at) + newString + content.slice(at + oldString.length);
}

function countOccurrences(content: string, needle: string): number {
  if (needle === "") {
    return 0;
  }
  let count = 0;
  let at = content.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = content.indexOf(needle, at + needle.length);
  }
  return count;
}
