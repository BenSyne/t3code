/**
 * Anthropic's own catalogue, read with the user's key.
 *
 * `/v1/models` reports more than a list of names: the context window per model,
 * and which reasoning efforts each one honours. Both were written out by hand
 * here, and both were wrong — every model was declared to stop at `high` when
 * the newer ones accept `max`, and the windows were a flat 200k against models
 * that now serve far more. The API knows; ask it.
 *
 * Same shape as the OpenRouter catalogue and the same fail-soft rule: any
 * failure serves the last good answer, and a cold failure serves null so the
 * caller falls back to the static list rather than showing an empty picker.
 *
 * @module agent/model/anthropicCatalog
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import type { ResolvedCredential } from "./credentials.ts";
import type { CatalogModel } from "./ModelCatalog.ts";
import type { ReasoningEffort } from "./reasoning.ts";

const CATALOG_URL = "https://api.anthropic.com/v1/models";
const ANTHROPIC_VERSION = "2023-06-01";
const FETCH_TIMEOUT_MILLIS = 10_000;
const REFRESH_AFTER_MILLIS = 24 * 60 * 60 * 1_000;
/** One page is plenty — the whole lineup is a couple of dozen entries. */
const PAGE_LIMIT = 100;

interface CapabilitySupport {
  readonly supported?: boolean | undefined;
}

/** Only the parts we read. The response carries a great deal more. */
export interface AnthropicApiModel {
  readonly id?: string | undefined;
  readonly display_name?: string | undefined;
  readonly max_input_tokens?: number | undefined;
  readonly capabilities?:
    | {
        readonly effort?:
          | {
              readonly supported?: boolean | undefined;
              readonly low?: CapabilitySupport | undefined;
              readonly medium?: CapabilitySupport | undefined;
              readonly high?: CapabilitySupport | undefined;
              readonly max?: CapabilitySupport | undefined;
            }
          | undefined;
      }
    | undefined;
}

/**
 * The efforts a model takes, weakest first.
 *
 * `none` is ours rather than theirs: turning thinking off is a separate switch
 * from the effort level, and every model that reasons can be told not to. A
 * model that reports no effort support at all reasons on nobody's terms, so it
 * gets no picker — which is what an absent list means.
 *
 * Capped at `high` even where the model reports `max`. Anthropic's ladder does
 * go further, but the client layer types this field as low/medium/high, so a
 * request for `max` cannot leave here as `max` — see `anthropicReasoningConfig`.
 * Offering a level that silently lands on a lower one is worse than not
 * offering it, so the cap follows what we can send rather than what exists.
 */
export function effortsOf(model: AnthropicApiModel): ReadonlyArray<ReasoningEffort> | undefined {
  const effort = model.capabilities?.effort;
  if (effort?.supported !== true) {
    return undefined;
  }
  const ladder: ReadonlyArray<readonly [ReasoningEffort, CapabilitySupport | undefined]> = [
    ["low", effort.low],
    ["medium", effort.medium],
    ["high", effort.high],
  ];
  const offered = ladder.flatMap(([name, support]) => (support?.supported === true ? [name] : []));
  return offered.length === 0 ? undefined : ["none", ...offered];
}

/** Map the response to what the picker and the usage meter need. */
export function selectAnthropicCatalog(
  models: ReadonlyArray<AnthropicApiModel>,
): ReadonlyArray<CatalogModel> {
  return models.flatMap((model) => {
    const id = model.id?.trim();
    // A window of zero is what the API sends for "not published", and a zero
    // denominator renders the meter as 0% forever. Drop rather than guess.
    if (id === undefined || id === "" || (model.max_input_tokens ?? 0) <= 0) {
      return [];
    }
    const efforts = effortsOf(model);
    return [
      {
        id,
        label: model.display_name?.trim() || id,
        contextWindow: model.max_input_tokens ?? 0,
        ...(efforts === undefined ? {} : { reasoningEfforts: efforts }),
      },
    ];
  });
}

export interface AnthropicCatalog {
  readonly current: Effect.Effect<ReadonlyArray<CatalogModel> | null>;
  readonly contextWindowOf: (model: string) => number | null;
}

/** One per driver instance; the cache lives as long as the instance does. */
export const makeAnthropicCatalog = Effect.fnUntraced(function* (
  credential: () => ResolvedCredential,
) {
  const client = yield* HttpClient.HttpClient;
  let cached: { readonly at: number; readonly models: ReadonlyArray<CatalogModel> } | null = null;
  const windows = new Map<string, number>();

  const fetchOnce = Effect.gen(function* () {
    const resolved = credential();
    if (resolved._tag !== "Resolved") {
      return null;
    }
    const request = HttpClientRequest.get(CATALOG_URL).pipe(
      HttpClientRequest.setHeaders({
        "x-api-key": Redacted.value(resolved.key),
        "anthropic-version": ANTHROPIC_VERSION,
      }),
      HttpClientRequest.setUrlParam("limit", String(PAGE_LIMIT)),
    );
    const response = yield* client.execute(request);
    if (response.status < 200 || response.status >= 300) {
      return null;
    }
    const body = (yield* response.json) as { data?: ReadonlyArray<AnthropicApiModel> };
    const models = selectAnthropicCatalog(Array.isArray(body.data) ? body.data : []);
    return models.length > 0 ? models : null;
  });

  const current = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (cached !== null && now - cached.at < REFRESH_AFTER_MILLIS) {
      return cached.models;
    }
    const attempt = yield* fetchOnce.pipe(
      Effect.timeoutOption(FETCH_TIMEOUT_MILLIS),
      Effect.map((option) => (option._tag === "Some" ? option.value : null)),
      Effect.orElseSucceed(() => null),
      Effect.catchDefect(() => Effect.succeed(null)),
    );
    if (attempt === null) {
      return cached?.models ?? null;
    }
    cached = { at: now, models: attempt };
    for (const model of attempt) {
      windows.set(model.id, model.contextWindow);
    }
    return attempt;
  });

  return {
    current,
    contextWindowOf: (model: string) => windows.get(model) ?? null,
  } satisfies AnthropicCatalog;
});
