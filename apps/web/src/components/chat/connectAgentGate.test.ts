import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { preferredFirstRunProvider, shouldAskForKey } from "./connectAgentGate.ts";

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

describe("preferredFirstRunProvider", () => {
  it("lands on the agent when nothing else is configured", () => {
    const agent = provider({ driver: "t3agent", auth: { status: "unauthenticated" } });
    expect(preferredFirstRunProvider([agent])?.driver).toBe("t3agent");
  });

  it("leaves an equipped user alone", () => {
    // The case that matters most: someone with Claude already working must not
    // open the app to a key prompt. That would be worse than before.
    const agent = provider({ driver: "t3agent", auth: { status: "unauthenticated" } });
    const claude = provider({ driver: "claude" });
    expect(preferredFirstRunProvider([agent, claude])).toBeNull();
  });

  it("still prefers the agent when the other providers are unusable", () => {
    // An installed-but-signed-out Claude is not something they can send a
    // message with either, so it does not count as equipped.
    const agent = provider({ driver: "t3agent", auth: { status: "unauthenticated" } });
    const claude = provider({ driver: "claude", auth: { status: "unauthenticated" } });
    const codex = provider({ driver: "codex", status: "disabled" });
    expect(preferredFirstRunProvider([agent, claude, codex])?.driver).toBe("t3agent");
  });

  it("does nothing when the agent is absent, rather than guessing", () => {
    expect(preferredFirstRunProvider([provider({ driver: "claude" })])).toBeNull();
    expect(preferredFirstRunProvider([])).toBeNull();
  });
});
