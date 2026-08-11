import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { getProviderStatusBannerKey } from "./ProviderStatusBanner";

const provider = (over: Omit<Partial<ServerProvider>, "driver"> & { driver: string }) =>
  ({
    ...over,
    instanceId: over.instanceId ?? ProviderInstanceId.make(`${over.driver}-1`),
    driver: ProviderDriverKind.make(over.driver),
    status: over.status ?? "error",
    auth: over.auth ?? { status: "unauthenticated" },
  }) as ServerProvider;

describe("getProviderStatusBannerKey", () => {
  it("stays out of the way when the composer is asking for the key", () => {
    // Two requests for the same thing, stacked. The banner's copy is the worse
    // of the two — it names the environment variable and says to sign in via a
    // CLI, and the built-in agent has no CLI.
    expect(getProviderStatusBannerKey(provider({ driver: "t3agent" }))).toBeNull();
  });

  it("still warns about an unauthenticated CLI provider", () => {
    // Nothing else asks for these, and the fix must not silence them: Claude
    // and Codex really do need a CLI login, and the banner is the only place
    // that says so.
    expect(getProviderStatusBannerKey(provider({ driver: "claude" }))).not.toBeNull();
    expect(getProviderStatusBannerKey(provider({ driver: "codex" }))).not.toBeNull();
  });

  it("still warns about a built-in agent that is broken for some other reason", () => {
    // Only the missing-key case is the composer's job. A provider that is in
    // error while authenticated has something else wrong and must still surface.
    const broken = provider({
      driver: "t3agent",
      auth: { status: "authenticated" },
      message: "Model endpoint returned 500.",
    });
    expect(getProviderStatusBannerKey(broken)).not.toBeNull();
  });

  it("says nothing about a healthy provider", () => {
    expect(
      getProviderStatusBannerKey(
        provider({ driver: "t3agent", status: "ready", auth: { status: "authenticated" } }),
      ),
    ).toBeNull();
  });
});
