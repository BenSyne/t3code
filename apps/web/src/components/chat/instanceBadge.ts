/**
 * Whether the composer trigger needs a badge to say which instance is active.
 *
 * The trigger shows an icon and a model name. A badge is worth its clutter
 * only when those two are not already enough to tell you what you are talking
 * to — which is a narrower situation than "there is more than one instance of
 * this driver", the rule this replaces.
 *
 * Two Codex accounts serve the same models, so "GPT-5.6 Sol" under the Codex
 * icon really is ambiguous and the badge earns its place. Two T3 Agent
 * instances on different backends serve disjoint models: "Kimi K3" can only be
 * the OpenRouter one, and stamping OR over the icon tells you something you
 * already knew while hiding the icon underneath it.
 *
 * An accent colour is different and always wins. The user chose it to mark
 * that instance, and quietly not rendering their choice is worse than a badge
 * nobody needed.
 *
 * @module components/chat/instanceBadge
 */
import type { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

interface BadgeEntry {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly accentColor?: string | undefined;
  readonly models: ReadonlyArray<{ readonly slug: string }>;
}

export function shouldShowInstanceBadge(input: {
  readonly entries: ReadonlyArray<BadgeEntry>;
  readonly activeEntry: BadgeEntry | null;
  /** The model on the trigger. Absent while a thread is still resolving one. */
  readonly activeModelSlug: string | null | undefined;
}): boolean {
  const { activeEntry } = input;
  if (activeEntry === null) {
    return false;
  }
  if (activeEntry.accentColor) {
    return true;
  }

  const siblings = input.entries.filter(
    (entry) =>
      entry.driverKind === activeEntry.driverKind && entry.instanceId !== activeEntry.instanceId,
  );
  if (siblings.length === 0) {
    return false;
  }

  // Without a model to compare, fall back to the old behaviour: something is
  // ambiguous and we cannot prove otherwise.
  const slug = input.activeModelSlug?.trim();
  if (!slug) {
    return true;
  }

  return siblings.some((entry) => entry.models.some((model) => model.slug === slug));
}
