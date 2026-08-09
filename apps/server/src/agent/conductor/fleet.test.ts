import { describe, expect, it } from "vite-plus/test";

import { checkApproval, checkTarget, DEFAULT_FLEET_POLICY, type FleetPolicy } from "./fleet.ts";

const check = (over: Partial<Parameters<typeof checkTarget>[0]> = {}) =>
  checkTarget({
    policy: DEFAULT_FLEET_POLICY,
    targetDriverKind: "codex",
    selfDriverKind: "t3agent",
    ...over,
  });

describe("checkTarget", () => {
  it("allows delegating to a different provider", () => {
    expect(check()).toEqual({ _tag: "Allowed" });
  });

  it("refuses to target another built-in agent by default", () => {
    // A T3 agent that can start a T3 agent can start a T3 agent. The recursion
    // is unbounded, every level costs money, and nothing is visible until the
    // bill arrives.
    const verdict = check({ targetDriverKind: "t3agent" });
    expect(verdict._tag).toBe("Refused");
    if (verdict._tag !== "Refused") return;
    expect(verdict.reason).toContain("built-in agent");
  });

  it("allows self-targeting only when deliberately switched on", () => {
    const policy: FleetPolicy = { ...DEFAULT_FLEET_POLICY, allowSelfTargeting: true };
    expect(check({ policy, targetDriverKind: "t3agent" })).toEqual({ _tag: "Allowed" });
  });

  it("does not cap how many delegations run at once", () => {
    // Swarming is the point. A limit that bites mid-fan-out is worse than
    // none: the agent has already spent the tokens deciding what to delegate
    // by the time it discovers it cannot.
    expect(check()).toEqual({ _tag: "Allowed" });
  });
});

describe("checkApproval", () => {
  it("refuses by default", () => {
    // Approval is how a human stays in the loop. "Let the agent run other
    // agents" must not silently mean "let the agent approve on your behalf".
    const verdict = checkApproval(DEFAULT_FLEET_POLICY);
    expect(verdict._tag).toBe("Refused");
  });

  it("allows only when its own setting is on", () => {
    expect(checkApproval({ ...DEFAULT_FLEET_POLICY, allowApprovingRequests: true })).toEqual({
      _tag: "Allowed",
    });
  });
});

describe("the default policy", () => {
  it("has both dangerous capabilities off", () => {
    // This is the assertion that matters if someone edits the defaults.
    expect(DEFAULT_FLEET_POLICY.allowSelfTargeting).toBe(false);
    expect(DEFAULT_FLEET_POLICY.allowApprovingRequests).toBe(false);
  });
});
