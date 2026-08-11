/**
 * The OpenRouter catalogue, live instead of hand-written.
 *
 * The static list in `ModelCatalog.ts` rots the moment a vendor ships — it held
 * GLM 5.1 while 5.2 was serving traffic. OpenRouter publishes release dates,
 * context windows and tool-calling support, so "show the newest" can be a rule
 * rather than a maintenance chore.
 *
 * Two tiers: a fixed-order shelf of the newest tool-capable models per vendor,
 * then everything else eligible behind search. Tool calling is required — an
 * agent cannot run on a model that cannot call `read` — and variant suffixes
 * (`:free`, `:extended`) are dropped as alternate servings of a listed slug.
 * The static list still stands in before the first fetch and after a failure,
 * so the picker never opens empty.
 *
 * @module agent/model/openRouterCatalog
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { OPENROUTER_EFFORTS, type CatalogModel } from "./ModelCatalog.ts";

/** As much of one API entry as selection reads. Everything else is ignored. */
export interface OpenRouterApiModel {
  readonly id: string;
  readonly name?: string | undefined;
  /** Unix seconds. The field the newest-first rule runs on. */
  readonly created?: number | undefined;
  readonly context_length?: number | undefined;
  readonly supported_parameters?: ReadonlyArray<string> | undefined;
}

/**
 * The vendors on the shelf, in the order the shelf shows them.
 *
 * A fixed order rather than any ranking: predictable beats clever, and the
 * point of the shelf is that the eye finds Claude and GPT where they always
 * are. Matched against the author segment of the model id.
 */
const SHELF_FAMILIES = [
  "anthropic",
  "openai",
  "google",
  "moonshotai",
  "deepseek",
  "qwen",
  "minimax",
  "z-ai",
] as const;

/**
 * Newest N per family on the shelf.
 *
 * Three, checked against the live list: vendors ship named variants in pairs
 * (GPT-5.6 Luna and Terra, each with a Pro), and Anthropic's fast serving of
 * Opus lands newer than Sonnet. Two per family shelved one variant pair and
 * dropped the rest; three catches the current generation's spread without the
 * shelf stopping being a shelf.
 */
const SHELF_PER_FAMILY = 3;

/**
 * Everything past the shelf, newest first, cut here.
 *
 * The snapshot crosses the websocket on every provider-status refresh, so this
 * number is a payload budget, not a display limit. Measured against the live
 * catalogue (261 eligible models): 150 serialises to 63.5 KiB, 60 to 26.9 KiB.
 * The largest provider already in the app advertises nine models.
 *
 * Sixty keeps the whole shelf plus a month or so of newer releases behind
 * search. Anything older is still reachable — the picker accepts a typed slug
 * and `customModels` pins one permanently.
 */
const MAX_MODELS = 60;

function isEligible(model: OpenRouterApiModel): boolean {
  return (
    // Variant suffixes are alternate servings of a base slug that is already
    // listed: `:free` is rate-limited, `:extended` remixes the window.
    !model.id.includes(":") &&
    (model.supported_parameters?.includes("tools") ?? false) &&
    (model.context_length ?? 0) > 0
  );
}

function familyOf(model: OpenRouterApiModel): string {
  return model.id.includes("/") ? (model.id.split("/")[0] ?? "") : "";
}

/**
 * Vendors whose ids do not read as their names, for models whose API name
 * carries no vendor prefix. Everything else falls back to the id's author
 * segment with its first letter raised.
 */
const VENDOR_NAMES: Readonly<Record<string, string>> = {
  "z-ai": "Z.ai",
  moonshotai: "Moonshot AI",
  openai: "OpenAI",
  deepseek: "DeepSeek",
  minimax: "MiniMax",
  "x-ai": "xAI",
  mistralai: "Mistral",
};

/**
 * Most OpenRouter names read "OpenAI: GPT-5.6 Luna" — vendor and label in one
 * string, split here so the picker can render them as two. Anthropic's do not
 * (just "Claude Opus 5"), so the vendor falls back to the id's author segment;
 * without it the picker cannot say who makes the model.
 */
function splitName(model: OpenRouterApiModel): { label: string; vendor: string | undefined } {
  const name = model.name ?? model.id;
  const colon = name.indexOf(":");
  const label = colon > 0 ? name.slice(colon + 1).trim() : name;
  const family = familyOf(model);
  if (family === "") {
    return { label, vendor: colon > 0 ? name.slice(0, colon).trim() : undefined };
  }
  // A curated name outranks the one in the feed. OpenRouter respells vendors
  // from time to time — "Moonshot AI" became "MoonshotAI" — and letting that
  // through renames rows in the picker for no reason the user can see.
  const vendor =
    VENDOR_NAMES[family] ??
    (colon > 0 ? name.slice(0, colon).trim() : family.charAt(0).toUpperCase() + family.slice(1));
  return { label, vendor };
}

function toCatalogModel(model: OpenRouterApiModel): CatalogModel {
  const { label, vendor } = splitName(model);
  return {
    id: model.id,
    label,
    ...(vendor === undefined ? {} : { vendor }),
    contextWindow: model.context_length ?? 0,
    ...(model.supported_parameters?.includes("reasoning")
      ? { reasoningEfforts: OPENROUTER_EFFORTS }
      : {}),
  };
}

/**
 * Pick what the picker shows, newest first.
 *
 * Pure so the whole policy — eligibility, the shelf, the cap — is testable
 * without a network.
 */
export function selectCatalog(
  models: ReadonlyArray<OpenRouterApiModel>,
): ReadonlyArray<CatalogModel> {
  const eligible = models.filter(isEligible);
  const newestFirst = [...eligible].sort((a, b) => (b.created ?? 0) - (a.created ?? 0));

  const shelf: Array<OpenRouterApiModel> = [];
  for (const family of SHELF_FAMILIES) {
    shelf.push(
      ...newestFirst.filter((model) => familyOf(model) === family).slice(0, SHELF_PER_FAMILY),
    );
  }

  const onShelf = new Set(shelf.map((model) => model.id));
  const rest = newestFirst.filter((model) => !onShelf.has(model.id));

  return [...shelf, ...rest].slice(0, MAX_MODELS).map(toCatalogModel);
}

const CATALOG_URL = "https://openrouter.ai/api/v1/models";
const FETCH_TIMEOUT_MILLIS = 10_000;
const REFRESH_AFTER_MILLIS = 24 * 60 * 60 * 1_000;

export interface OpenRouterCatalog {
  /**
   * The live catalogue, or null when it has never been fetched successfully.
   * Refreshes itself once a day; a failed refresh keeps serving the last
   * good answer rather than flapping back to the static list.
   */
  readonly current: Effect.Effect<ReadonlyArray<CatalogModel> | null>;
  /** Synchronous, for the adapter's context-window lookup on the hot path. */
  readonly contextWindowOf: (model: string) => number | null;
}

/** One per driver instance; the cache lives as long as the instance does. */
export const makeOpenRouterCatalog = Effect.fnUntraced(function* () {
  const client = yield* HttpClient.HttpClient;
  let cached: { readonly at: number; readonly models: ReadonlyArray<CatalogModel> } | null = null;
  const windows = new Map<string, number>();

  const fetchOnce = Effect.gen(function* () {
    const response = yield* client.execute(HttpClientRequest.get(CATALOG_URL));
    const body = (yield* response.json) as { data?: ReadonlyArray<OpenRouterApiModel> };
    const models = selectCatalog(Array.isArray(body.data) ? body.data : []);
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
      // Serve yesterday's answer over no answer; retry on the next check.
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
  } satisfies OpenRouterCatalog;
});
