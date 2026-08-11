/**
 * Replacing old conversation with a summary of it.
 *
 * @module agent/compaction/summarize
 */
import * as Effect from "effect/Effect";
import * as LanguageModel from "effect/unstable/ai/LanguageModel";
import * as Prompt from "effect/unstable/ai/Prompt";

import { estimateTokens, splitForCompaction } from "./tokenBudget.ts";

const INSTRUCTION = `Summarise the conversation so far so that another engineer could pick up exactly where it left off.

Include, in this order:
1. What the user asked for, in their own terms.
2. Decisions taken and why, especially ones that would be re-litigated otherwise.
3. Files created or changed, by path, and what changed in each.
4. Commands run whose results still matter, and what they showed.
5. What is still unfinished, and the next concrete step.

Be specific. Names, paths, and numbers survive; adjectives do not. Do not
address the reader, do not describe the conversation as a conversation, and do
not add anything that was not established in it.`;

export type CompactionOutcome =
  | {
      readonly _tag: "Compacted";
      readonly prompt: Prompt.Prompt;
      readonly summarisedMessages: number;
    }
  /** Nothing was over budget, or there was too little history to be worth it. */
  | { readonly _tag: "NotNeeded" }
  /** The summary call failed. The caller keeps the original conversation. */
  | { readonly _tag: "Failed"; readonly detail: string };

/** Compact a conversation. */
export const compactPrompt = Effect.fnUntraced(function* (input: {
  readonly prompt: Prompt.Prompt;
  readonly preserveTokens: number;
}) {
  const split = splitForCompaction({
    messages: input.prompt.content,
    preserveTokens: input.preserveTokens,
    sizeOf: (message) => estimateTokens(JSON.stringify(message)),
  });

  // Below a handful of messages there is nothing to gain and a real chance of
  // summarising away the only thing that mattered.
  if (split.summarise.length < 4) {
    return { _tag: "NotNeeded" as const };
  }

  const request = Prompt.concat(
    Prompt.make(split.summarise),
    Prompt.make([{ role: "user", content: [{ type: "text", text: INSTRUCTION }] }]),
  );

  // Defects as well as failures. A bug in a provider client would otherwise
  // take the turn down through the one path that exists to protect it.
  const response = yield* Effect.result(
    Effect.catchDefect(LanguageModel.generateText({ prompt: request }), (defect) =>
      Effect.fail(asError(defect)),
    ),
  );

  if (response._tag === "Failure") {
    return {
      _tag: "Failed" as const,
      detail: describeError(response.failure),
    };
  }

  const summary = response.success.text.trim();
  if (summary === "") {
    return { _tag: "Failed" as const, detail: "The summary came back empty." };
  }

  return {
    _tag: "Compacted" as const,
    prompt: Prompt.make([
      ...split.system,
      {
        role: "user" as const,
        content: [
          {
            type: "text" as const,
            text: `Summary of the earlier part of this session:\n\n${summary}`,
          },
        ],
      },
      ...split.keep,
    ]),
    summarisedMessages: split.summarise.length,
  };
});

/** Defects arrive as anything at all; the error channel should not say `unknown`. */
function asError(defect: unknown): Error {
  return defect instanceof Error ? defect : new Error(String(defect));
}

function describeError(error: { readonly message?: string | undefined }): string {
  return error.message !== undefined && error.message !== ""
    ? error.message
    : "The summary request failed.";
}
