/**
 * Credential resolution for the built-in agent.
 *
 * @module agent/model/credentials
 */
import * as Redacted from "effect/Redacted";

/** Where a resolved key came from. Surfaced in the snapshot for support. */
export type CredentialSource = "instance-environment" | "process-environment" | "not-required";

/** Stand-in key for a backend that does not authenticate. */
export const LOCAL_PLACEHOLDER_KEY = "not-required";

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

/** Resolve the API key for one instance. */
export function resolveCredential(input: {
  readonly variableName: string;
  readonly instanceEnv: NodeJS.ProcessEnv;
  readonly processEnv?: NodeJS.ProcessEnv;
  /** True for a backend that authenticates nothing, such as a local server. */
  readonly keyOptional?: boolean;
}): ResolvedCredential {
  const variableName = input.variableName.trim();
  const whenAbsent = (): ResolvedCredential =>
    input.keyOptional === true
      ? {
          _tag: "Resolved",
          key: Redacted.make(LOCAL_PLACEHOLDER_KEY),
          variableName: variableName === "" ? input.variableName : variableName,
          source: "not-required",
        }
      : { _tag: "Missing", variableName: variableName === "" ? input.variableName : variableName };

  if (variableName === "") {
    return whenAbsent();
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

  return whenAbsent();
}

function nonBlank(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
