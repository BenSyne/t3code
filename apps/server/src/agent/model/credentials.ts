/**
 * Credential resolution for the built-in agent.
 *
 * The agent needs an API key. Settings hold only the *name* of an environment
 * variable; the value arrives through the instance environment, where
 * `sensitive: true` keeps it out of settings.json and off the wire.
 *
 * Resolution is deliberately a total function returning a tagged result rather
 * than a failure. A missing key is a normal state — a freshly added instance
 * has one — and it must reach the UI as "set ANTHROPIC_API_KEY", not as an
 * error. `ResolvedCredential` carries the variable name for exactly that.
 *
 * The key is wrapped in `Redacted` so it cannot be logged or serialised by
 * accident; `Redacted.value` is the only way back out.
 *
 * @module agent/model/credentials
 */
import * as Redacted from "effect/Redacted";

/** Where a resolved key came from. Surfaced in the snapshot for support. */
export type CredentialSource = "instance-environment" | "process-environment";

export type ResolvedCredential =
  | {
      readonly _tag: "Resolved";
      readonly key: Redacted.Redacted<string>;
      readonly variableName: string;
      readonly source: CredentialSource;
    }
  | {
      readonly _tag: "Missing";
      /** Named so the UI can tell the user precisely what to set. */
      readonly variableName: string;
    };

/**
 * Resolve the API key for one instance.
 *
 * `instanceEnv` is the merged instance environment; `processEnv` is the
 * fallback so an operator who exported the key for the whole server does not
 * have to re-enter it per instance.
 *
 * Both are checked for a non-blank value: an empty string is treated as absent,
 * because a cleared settings field and a never-set one should behave the same.
 */
export function resolveCredential(input: {
  readonly variableName: string;
  readonly instanceEnv: NodeJS.ProcessEnv;
  readonly processEnv?: NodeJS.ProcessEnv;
}): ResolvedCredential {
  const variableName = input.variableName.trim();
  if (variableName === "") {
    return { _tag: "Missing", variableName: input.variableName };
  }

  const fromInstance = nonBlank(input.instanceEnv[variableName]);
  if (fromInstance !== undefined) {
    return {
      _tag: "Resolved",
      key: Redacted.make(fromInstance),
      variableName,
      source: "instance-environment",
    };
  }

  const fromProcess = nonBlank((input.processEnv ?? process.env)[variableName]);
  if (fromProcess !== undefined) {
    return {
      _tag: "Resolved",
      key: Redacted.make(fromProcess),
      variableName,
      source: "process-environment",
    };
  }

  return { _tag: "Missing", variableName };
}

function nonBlank(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
