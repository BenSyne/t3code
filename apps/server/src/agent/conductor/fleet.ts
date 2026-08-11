/**
 * The rules that stop cross-provider orchestration becoming a runaway.
 *
 * @module agent/conductor/fleet
 */

export interface FleetPolicy {
  /** May the agent target other instances of itself? */
  readonly allowSelfTargeting: boolean;
  /** May the agent answer approval prompts on other threads? */
  readonly allowApprovingRequests: boolean;
}

export const DEFAULT_FLEET_POLICY: FleetPolicy = {
  allowSelfTargeting: false,
  allowApprovingRequests: false,
};

export type FleetRefusal =
  | { readonly _tag: "Allowed" }
  | { readonly _tag: "Refused"; readonly reason: string };

const allowed: FleetRefusal = { _tag: "Allowed" };

const refuse = (reason: string): FleetRefusal => ({ _tag: "Refused", reason });

/** May the agent start work on this provider? */
export function checkTarget(input: {
  readonly policy: FleetPolicy;
  readonly targetDriverKind: string;
  readonly selfDriverKind: string;
}): FleetRefusal {
  if (!input.policy.allowSelfTargeting && input.targetDriverKind === input.selfDriverKind) {
    return refuse(
      "Delegating to another built-in agent is turned off. Use a different provider, or do the work yourself.",
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
