/**
 * The rules that stop cross-provider orchestration becoming a runaway.
 *
 * Pure, and separated from the tools, because these are the checks whose
 * failure mode is expensive rather than merely wrong. Every one of them exists
 * because of a specific way this feature could hurt someone.
 *
 * @module agent/conductor/fleet
 */

/**
 * Threads the agent may have running at once.
 *
 * Each one is a real provider session on the user's key. Four is enough for
 * "ask Codex and Claude the same question and compare", which is the case this
 * exists for, and small enough that a mistake is visible before it is costly.
 */
export const DEFAULT_FLEET_LIMIT = 4;

export interface FleetPolicy {
  readonly limit: number;
  /**
   * May the agent target other instances of itself?
   *
   * Off by default. A T3 agent that can start a T3 agent can start a T3 agent:
   * the recursion is unbounded, every level costs money, and nothing about the
   * failure is visible until the bill. Turning this on is a deliberate act.
   */
  readonly allowSelfTargeting: boolean;
  /**
   * May the agent answer approval prompts on other threads?
   *
   * Off by default and behind its own setting, never bundled with general
   * orchestration. Approval is the mechanism by which a human stays in the
   * loop; an agent that can approve on the user's behalf has removed it, and
   * "let the agent run other agents" must not silently mean that.
   */
  readonly allowApprovingRequests: boolean;
}

export const DEFAULT_FLEET_POLICY: FleetPolicy = {
  limit: DEFAULT_FLEET_LIMIT,
  allowSelfTargeting: false,
  allowApprovingRequests: false,
};

export type FleetRefusal =
  | { readonly _tag: "Allowed" }
  | { readonly _tag: "Refused"; readonly reason: string };

const allowed: FleetRefusal = { _tag: "Allowed" };

const refuse = (reason: string): FleetRefusal => ({ _tag: "Refused", reason });

/**
 * May the agent start work on this provider?
 *
 * `driverKind` is the target's, `selfDriverKind` is this agent's own.
 */
export function checkTarget(input: {
  readonly policy: FleetPolicy;
  readonly targetDriverKind: string;
  readonly selfDriverKind: string;
  readonly runningThreads: number;
}): FleetRefusal {
  if (!input.policy.allowSelfTargeting && input.targetDriverKind === input.selfDriverKind) {
    return refuse(
      "Delegating to another built-in agent is turned off. Use a different provider, or do the work yourself.",
    );
  }
  if (input.runningThreads >= input.policy.limit) {
    return refuse(
      `Already running ${input.runningThreads} delegated threads, which is the limit. Wait for one to finish.`,
    );
  }
  return allowed;
}

/** May the agent answer an approval prompt on another thread? */
export function checkApproval(policy: FleetPolicy): FleetRefusal {
  return policy.allowApprovingRequests
    ? allowed
    : refuse(
        "Answering approval prompts on behalf of the user is turned off. Tell the user what is waiting instead.",
      );
}
