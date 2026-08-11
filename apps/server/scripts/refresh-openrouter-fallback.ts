// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalDate:off globalConsole:off
// A one-shot developer script run by hand, not part of the server runtime:
// plain node is the right tool and an Effect runtime would only be ceremony.
/**
 * Regenerate the static OpenRouter model list from the live catalogue.
 *
 * The list this writes is the fallback the picker shows before the first
 * network call resolves. It used to be written by hand, and it drifted the way
 * hand-written data does: five of thirteen ids had stopped existing, so
 * choosing one produced a 400 and a dead turn, and three context windows were
 * wrong by as much as five times, which quietly lied to the usage meter.
 *
 * Generating it instead makes both correct by construction. The selection
 * policy is `selectCatalog`'s, not a second one — this is a snapshot of what
 * the live catalogue would serve, taken at a moment we can point at.
 *
 * Run: node apps/server/scripts/refresh-openrouter-fallback.ts
 */
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUrl from "node:url";

import { selectCatalog } from "../src/agent/model/openRouterCatalog.ts";
import { OPENROUTER_EFFORTS, type CatalogModel } from "../src/agent/model/ModelCatalog.ts";

/** Enough to cover the shelf — the whole point is the names people look for. */
const KEEP = 24;
const CATALOG_URL = "https://openrouter.ai/api/v1/models";

const OUTPUT = NodePath.join(
  NodePath.dirname(NodeUrl.fileURLToPath(import.meta.url)),
  "..",
  "src",
  "agent",
  "model",
  "openrouterFallback.ts",
);

function render(models: ReadonlyArray<CatalogModel>, fetchedOn: string): string {
  const entries = models
    .map((model) => {
      const lines = [
        `    id: ${JSON.stringify(model.id)},`,
        `    label: ${JSON.stringify(model.label)},`,
        ...(model.vendor === undefined ? [] : [`    vendor: ${JSON.stringify(model.vendor)},`]),
        `    contextWindow: ${model.contextWindow},`,
        ...(model.reasoningEfforts === undefined ? [] : [`    reasoningEfforts: EFFORTS,`]),
      ];
      return `  {\n${lines.join("\n")}\n  },`;
    })
    .join("\n");

  return `/**
 * Generated. Do not edit by hand.
 *
 * The OpenRouter list the picker shows before the live catalogue resolves,
 * snapshotted from the live API on ${fetchedOn} by the same policy the live
 * catalogue uses. Every id and context window here came from OpenRouter rather
 * than from memory, which is the whole point: hand-written entries drifted into
 * ids that no longer existed and windows that were wrong by five times.
 *
 * Refresh: node apps/server/scripts/refresh-openrouter-fallback.ts
 *
 * @module agent/model/openrouterFallback
 */
import type { CatalogModel } from "./ModelCatalog.ts";
import type { ReasoningEffort } from "./reasoning.ts";

/** Inlined rather than imported: importing a value from ModelCatalog would cycle. */
const EFFORTS: ReadonlyArray<ReasoningEffort> = ${JSON.stringify(OPENROUTER_EFFORTS)};

export const OPENROUTER_FALLBACK_MODELS: ReadonlyArray<CatalogModel> = [
${entries}
];
`;
}

const response = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(20_000) });
if (!response.ok) {
  throw new Error(`OpenRouter answered ${response.status}`);
}
const payload = (await response.json()) as { data: ReadonlyArray<never> };
const selected = selectCatalog(payload.data).slice(0, KEEP);
if (selected.length === 0) {
  throw new Error("The live catalogue selected nothing — refusing to write an empty fallback.");
}

const today = new Date().toISOString().slice(0, 10);
await NodeFS.writeFile(OUTPUT, render(selected, today), "utf8");
console.log(`Wrote ${selected.length} models to ${OUTPUT}`);
