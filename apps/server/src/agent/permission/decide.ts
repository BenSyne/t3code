/**
 * The one place that decides whether a tool call runs, asks, or is refused.
 *
 * Three inputs, in a fixed order of precedence:
 *
 *   1. The mode's profile — the baseline the user picked.
 *   2. The destructive-command check — can raise `allow` to `ask`, never lower.
 *   3. The user's rules — the last word, because an explicit rule is the user
 *      saying they already thought about this exact case.
 *
 * That ordering is the interesting decision. Rules come last so `allow git push`
 * genuinely stops the prompt, even though the heuristic flags it. A user who
 * writes a rule has been more specific than any guess we can make.
 *
 * Pure, and the whole matrix is table-tested.
 *
 * @module agent/permission/decide
 */
import type { RuntimeMode } from "@t3tools/contracts";

import { judgeCommand } from "./commandShape.ts";
import { profileFor, subjectForTool, type PermissionDecision } from "./profile.ts";
import { evaluateRules, type PermissionRule } from "./rules.ts";

export interface PermissionOutcome {
  readonly decision: PermissionDecision;
  /** Why, in words the prompt can show. Absent when the answer is a plain allow. */
  readonly reason?: string | undefined;
}

export function decidePermission(input: {
  readonly mode: RuntimeMode;
  readonly toolName: string;
  /** The command line for `bash`, the path for a file tool, the name otherwise. */
  readonly target: string;
  readonly rules: ReadonlyArray<PermissionRule>;
}): PermissionOutcome {
  const subject = subjectForTool(input.toolName);
  const profile = profileFor(input.mode);

  let decision = profile[subject];
  let reason: string | undefined;

  if (subject === "command" && profile.askBeforeDestructiveCommands && decision === "allow") {
    const verdict = judgeCommand(input.target);
    if (verdict.destructive) {
      decision = "ask";
      reason = verdict.reason;
    }
  }

  const fromRules = evaluateRules(input.rules, { subject, target: input.target });
  if (fromRules !== null) {
    return fromRules === "allow"
      ? { decision: "allow" }
      : { decision: fromRules, reason: "a rule you set" };
  }

  return decision === "allow" ? { decision } : { decision, reason };
}
