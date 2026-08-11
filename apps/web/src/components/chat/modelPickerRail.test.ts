import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { instancesInRailGroup, railEntriesByDriver } from "./modelPickerRail.ts";

const entry = (id: string, driver: string, isDefault = false) => ({
  instanceId: ProviderInstanceId.make(id),
  driverKind: ProviderDriverKind.make(driver),
  isDefault,
});

const ids = (entries: ReadonlyArray<{ instanceId: ProviderInstanceId }>) =>
  entries.map((e) => e.instanceId);

describe("railEntriesByDriver", () => {
  it("draws one icon per agent, however many instances it has", () => {
    const entries = [
      entry("t3agent", "t3agent", true),
      entry("t3agent_cerebras", "t3agent"),
      entry("codex", "codex", true),
    ];

    expect(ids(railEntriesByDriver(entries))).toEqual(["t3agent", "codex"]);
  });

  it("lets the default instance represent its driver", () => {
    // The default's name and accent are what the user has seen since setup.
    // Letting a custom instance represent the driver because it happened to
    // sort first renames the rail out from under them.
    const entries = [entry("t3agent_cerebras", "t3agent"), entry("t3agent", "t3agent", true)];

    expect(ids(railEntriesByDriver(entries))).toEqual(["t3agent"]);
  });

  it("keeps drivers in the order they arrived", () => {
    // A default found second must not jump its whole driver to the front.
    const entries = [
      entry("codex", "codex", true),
      entry("t3agent_cerebras", "t3agent"),
      entry("t3agent", "t3agent", true),
    ];

    expect(ids(railEntriesByDriver(entries))).toEqual(["codex", "t3agent"]);
  });

  it("falls back to the first instance when no default is configured", () => {
    const entries = [entry("t3agent_a", "t3agent"), entry("t3agent_b", "t3agent")];

    expect(ids(railEntriesByDriver(entries))).toEqual(["t3agent_a"]);
  });

  it("passes a single-instance list through untouched", () => {
    const entries = [entry("codex", "codex", true), entry("claude", "claudeAgent", true)];

    expect(ids(railEntriesByDriver(entries))).toEqual(["codex", "claude"]);
  });
});

describe("instancesInRailGroup", () => {
  const entries = [
    entry("t3agent", "t3agent", true),
    entry("t3agent_cerebras", "t3agent"),
    entry("codex", "codex", true),
  ];

  it("covers every instance of the selected agent", () => {
    expect(instancesInRailGroup(entries, ProviderInstanceId.make("t3agent"))).toEqual(
      new Set(["t3agent", "t3agent_cerebras"]),
    );
  });

  it("covers the group when a non-representative instance is selected", () => {
    // Selection can survive a config change that promoted a different
    // instance; the group is defined by the driver, not by who represents it.
    expect(instancesInRailGroup(entries, ProviderInstanceId.make("t3agent_cerebras"))).toEqual(
      new Set(["t3agent", "t3agent_cerebras"]),
    );
  });

  it("leaves other agents out", () => {
    expect(instancesInRailGroup(entries, ProviderInstanceId.make("codex"))).toEqual(
      new Set(["codex"]),
    );
  });

  it("matches nothing for a selection that no longer exists", () => {
    // Deleting an instance mid-session leaves a stale id. An empty list is
    // honest; treating unknown as "everything" would silently show every
    // agent's models at once and read as a broken filter.
    expect(instancesInRailGroup(entries, ProviderInstanceId.make("deleted"))).toEqual(new Set());
  });
});
