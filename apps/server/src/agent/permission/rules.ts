/**
 * User rules that override the mode's defaults.
 *
 * "Always allow `git status`", "never let it run `terraform apply`". Rules are
 * evaluated in order and the **last** match wins, which is the convention every
 * config file with this shape uses: later lines are more specific, and appending
 * an exception should not require rewriting what came before.
 *
 * Pure. No rule can consult the filesystem or the network, which keeps the
 * decision reproducible and reviewable.
 *
 * @module agent/permission/rules
 */
import type { PermissionDecision, PermissionSubject } from "./profile.ts";

export interface PermissionRule {
  readonly subject: PermissionSubject | "any";
  /**
   * Glob-ish pattern matched against the command line or path.
   *
   * `*` matches any run of characters, including `/`. Deliberately simpler
   * than a full glob: a rule the user cannot predict the behaviour of is worse
   * than one that occasionally needs a second line.
   */
  readonly pattern: string;
  readonly decision: PermissionDecision;
}

/**
 * The decision the rules imply, or null when none of them match.
 *
 * Null rather than a default, so the caller can tell "the user said allow"
 * apart from "the user said nothing" — those differ when a command is judged
 * destructive.
 */
export function evaluateRules(
  rules: ReadonlyArray<PermissionRule>,
  input: { readonly subject: PermissionSubject; readonly target: string },
): PermissionDecision | null {
  let decision: PermissionDecision | null = null;

  for (const rule of rules) {
    if (rule.subject !== "any" && rule.subject !== input.subject) {
      continue;
    }
    if (matches(rule.pattern, input.target)) {
      decision = rule.decision;
    }
  }

  return decision;
}

/** Anchored: `git status` does not match `sudo git status`. */
export function matches(pattern: string, target: string): boolean {
  if (pattern === "*") {
    return true;
  }
  const escaped = pattern.replace(/[.+?^${}()[\]\\|]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(target.trim());
}
