/**
 * Commit messages, PR content, branch names and thread titles from the
 * built-in agent.
 *
 * The shared prompt builders already return `{ prompt, outputSchema }`, and the
 * model layer already speaks structured output, so each operation here is the
 * same three steps: build, ask, sanitise. The siblings that wrap CLIs need far
 * more machinery because they have to create a session, drive a subprocess and
 * recover a JSON object from free text — none of which applies in-process.
 *
 * Every failure is mapped to `TextGenerationError` with the operation name, so
 * a failed thread title never surfaces as a raw model error.
 *
 * @module textGeneration/T3AgentTextGeneration
 */
import { TextGenerationError } from "@t3tools/contracts";
import { sanitizeFeatureBranchName } from "@t3tools/shared/git";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import type * as Schema from "effect/Schema";
import * as LanguageModel from "effect/unstable/ai/LanguageModel";

import type { TextGeneration } from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

export interface T3AgentTextGenerationOptions {
  /**
   * Resolve a model, or report why one is not available.
   *
   * Resolved per call rather than captured, so an instance configured after
   * startup starts generating titles without a restart — and an instance with
   * no key yet explains itself instead of failing obscurely.
   */
  readonly resolveModel: () =>
    | { readonly _tag: "Ready"; readonly layer: Layer.Layer<LanguageModel.LanguageModel> }
    | { readonly _tag: "Unavailable"; readonly detail: string };
}

export function makeT3AgentTextGeneration(
  options: T3AgentTextGenerationOptions,
): TextGeneration["Service"] {
  // Generic over the schema so its `DecodingServices` stay `never`; typing it
  // loosely leaks `unknown` into the requirements channel.
  const ask = <S extends Schema.Codec<any, any, never, never>>(
    operation: string,
    built: { readonly prompt: string; readonly outputSchema: S },
  ): Effect.Effect<S["Type"], TextGenerationError> =>
    Effect.suspend(() => {
      const model = options.resolveModel();
      if (model._tag === "Unavailable") {
        return Effect.fail(new TextGenerationError({ operation, detail: model.detail }));
      }
      return LanguageModel.generateObject({
        prompt: built.prompt,
        schema: built.outputSchema,
      }).pipe(
        Effect.provide(model.layer),
        Effect.map((response) => response.value as S["Type"]),
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
        ),
      );
    });

  return {
    generateCommitMessage: (input) =>
      ask("generateCommitMessage", buildCommitMessagePrompt(input)).pipe(
        // `branch` is only in the schema when the caller asked for it, so this
        // narrows rather than casts — matching the other providers.
        Effect.map((value) => ({
          subject: sanitizeCommitSubject(value.subject),
          body: value.body.trim(),
          ...("branch" in value && typeof value.branch === "string"
            ? { branch: sanitizeFeatureBranchName(value.branch) }
            : {}),
        })),
      ),

    generatePrContent: (input) =>
      ask("generatePrContent", buildPrContentPrompt(input)).pipe(
        Effect.map((value) => ({
          title: sanitizePrTitle(value.title),
          body: value.body.trim(),
        })),
      ),

    generateBranchName: (input) =>
      ask("generateBranchName", buildBranchNamePrompt(input)).pipe(
        Effect.map((value) => ({ branch: value.branch })),
      ),

    generateThreadTitle: (input) =>
      ask("generateThreadTitle", buildThreadTitlePrompt(input)).pipe(
        Effect.map((value) => ({ title: sanitizeThreadTitle(value.title) })),
      ),
  };
}
