/**
 * User rules that override the mode's defaults.
 *
 * @module agent/permission/rules
 */
import type { PermissionDecision, PermissionSubject } from "./profile.ts";

export interface PermissionRule {
  readonly subject: PermissionSubject | "any";
  /** Glob-ish pattern matched against the command line or path. */
  readonly pattern: string;
  readonly decision: PermissionDecision;
}

/** The decision the rules imply, or null when none of them match. */
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
