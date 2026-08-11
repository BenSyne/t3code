import { describe, expect, it } from "vite-plus/test";

import { planDefaultAgentProvision } from "./provisionDefaultAgent.ts";

describe("planDefaultAgentProvision", () => {
  it("provisions on a machine that has never seen the agent", () => {
    const decision = planDefaultAgentProvision({ offered: false, instances: {} });
    expect(decision._tag).toBe("Provision");
    if (decision._tag !== "Provision") return;
    expect(decision.instance.driver).toBe("t3agent");
    expect(decision.instance.enabled).toBe(true);
    // Empty config on purpose — the agent's own decoding defaults supply the
    // backend and credential variable, so provisioning cannot drift from them.
    expect(decision.instance.config).toEqual({});
  });

  it("leaves an existing agent instance completely alone", () => {
    // The dangerous case: an install that already works must not gain a second
    // instance, and the one it has must not be edited.
    const decision = planDefaultAgentProvision({
      offered: false,
      instances: { t3agent_work: { driver: "t3agent" } },
    });
    expect(decision._tag).toBe("AdoptExisting");
  });

  it("recognises a renamed instance by its driver, not its id", () => {
    const decision = planDefaultAgentProvision({
      offered: false,
      instances: { "my-own-agent": { driver: "t3agent" } },
    });
    expect(decision._tag).toBe("AdoptExisting");
  });

  it("never resurrects an agent the user deleted", () => {
    // Deleting it leaves no instance behind, which is the same shape as a fresh
    // machine. The offered flag is the only thing that tells them apart.
    const decision = planDefaultAgentProvision({ offered: true, instances: {} });
    expect(decision._tag).toBe("AlreadyOffered");
  });

  it("does not provision alongside other providers on a fresh machine", () => {
    // Someone with Claude already set up still gets the agent — it is additive,
    // and it stays quiet until they pick it.
    const decision = planDefaultAgentProvision({
      offered: false,
      instances: { claudeAgent: { driver: "claude" }, codex: { driver: "codex" } },
    });
    expect(decision._tag).toBe("Provision");
  });
});
