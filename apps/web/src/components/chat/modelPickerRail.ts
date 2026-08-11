/**
 * One rail icon per agent, not per instance.
 *
 * The rail exists to narrow a long model list, and it was keyed by instance —
 * so two T3 Agent instances, one on OpenRouter and one on Cerebras, drew the
 * same agent twice with a badge to tell them apart. The user reads that as a
 * duplicate, because it is: the agent is identical, only the models differ,
 * and "which models" is what the list itself is for.
 *
 * Collapsing to one icon per driver moves that distinction to where it reads
 * better. Each row already carries the instance name and the vendor behind the
 * model, so a grouped list says "Claude Sonnet 5 · T3 Agent · Anthropic" and
 * "GLM 4.7 · Cerebras · Z.ai" — the same information, in the place the user is
 * already looking.
 *
 * Nothing about routing changes. Every row keeps its own instance id and the
 * combobox value is still `(instanceId, slug)`, so picking a model still picks
 * exactly one instance; this is a change to what is drawn, not to what is sent.
 *
 * @module components/chat/modelPickerRail
 */
import type { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

interface RailEntryLike {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly isDefault: boolean;
}

/**
 * The instances to draw, one per driver.
 *
 * The default instance represents its driver when present — it is the one
 * whose display name and accent the user has seen since setup, so swapping in
 * a custom instance's identity because it sorted first would rename the rail
 * out from under them. Order is otherwise the caller's, which already carries
 * the sort the settings page uses.
 */
export function railEntriesByDriver<T extends RailEntryLike>(
  entries: ReadonlyArray<T>,
): ReadonlyArray<T> {
  const representatives = new Map<ProviderDriverKind, T>();
  for (const entry of entries) {
    const existing = representatives.get(entry.driverKind);
    if (existing === undefined || (entry.isDefault && !existing.isDefault)) {
      representatives.set(entry.driverKind, entry);
    }
  }
  // Rebuilt from the caller's order rather than the Map's, so a default
  // instance discovered second does not jump its driver to the front.
  const seen = new Set<ProviderDriverKind>();
  const out: T[] = [];
  for (const entry of entries) {
    if (seen.has(entry.driverKind)) {
      continue;
    }
    seen.add(entry.driverKind);
    const representative = representatives.get(entry.driverKind);
    if (representative !== undefined) {
      out.push(representative);
    }
  }
  return out;
}

/**
 * Which instances a rail selection covers.
 *
 * Empty when the selection matches nothing — a stale id after the user deleted
 * an instance mid-session. An empty set shows an empty list, which is honest;
 * treating "unknown selection" as "everything" would silently widen the list
 * to every agent at once and look like a bug in the filter.
 */
export function instancesInRailGroup<T extends RailEntryLike>(
  entries: ReadonlyArray<T>,
  selectedInstanceId: ProviderInstanceId,
): ReadonlySet<ProviderInstanceId> {
  const selected = entries.find((entry) => entry.instanceId === selectedInstanceId);
  if (selected === undefined) {
    return new Set();
  }
  return new Set(
    entries
      .filter((entry) => entry.driverKind === selected.driverKind)
      .map((entry) => entry.instanceId),
  );
}
