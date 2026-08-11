import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { shouldAskForKey } from "./connectAgentGate.ts";

const provider = (over: Omit<Partial<ServerProvider>, "driver"> & { driver: string }) =>
  ({
    ...over,
    instanceId: over.instanceId ?? ProviderInstanceId.make(`${over.driver}-1`),
    driver: ProviderDriverKind.make(over.driver),
    status: over.status ?? "ready",
    auth: over.auth ?? { status: "authenticated" },
  }) as ServerProvider;

describe("shouldAskForKey", () => {
  it("asks when the built-in agent has no key", () => {
    expect(
      shouldAskForKey(provider({ driver: "t3agent", auth: { status: "unauthenticated" } })),
    ).toBe(true);
  });

  it("stays quiet once the agent has a key", () => {
    expect(shouldAskForKey(provider({ driver: "t3agent" }))).toBe(false);
  });

  it("never asks for a CLI provider, even unauthenticated", () => {
    // Pasting a key would do nothing here — Claude and Codex authenticate
    // through their own CLI, and a text box would be a dead end.
    for (const driver of ["claude", "codex", "cursor", "opencode"]) {
      expect(shouldAskForKey(provider({ driver, auth: { status: "unauthenticated" } }))).toBe(
        false,
      );
    }
  });

  it("handles no selection", () => {
    expect(shouldAskForKey(null)).toBe(false);
    expect(shouldAskForKey(undefined)).toBe(false);
  });
});
