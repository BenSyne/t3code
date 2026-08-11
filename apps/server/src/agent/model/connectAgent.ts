/**
 * Connect a key to the built-in agent: verify it, then store it.
 *
 * In that order, deliberately. Storing first leaves a typo sitting on the
 * instance looking configured, and the first thing the user learns about it is
 * a turn that dies. Nothing is written unless the provider has confirmed the
 * key works.
 *
 * The key is written through the same sensitive-environment path the settings
 * form already uses, so it lands in the secrets directory and `settings.json`
 * keeps only a redaction marker. This module introduces no new storage for
 * secrets.
 *
 * @module agent/model/connectAgent
 */
import {
  T3AgentSettings,
  type ConnectAgentResult,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { ServerSettingsService } from "../../serverSettings.ts";
import { isSafeBaseUrl, UNSAFE_BASE_URL_DETAIL } from "./baseUrl.ts";
import { BACKEND_KINDS, type BackendKind } from "./resolveLanguageModel.ts";
import { verifyCredential } from "./verifyCredential.ts";

const decodeT3AgentSettings = Schema.decodeSync(T3AgentSettings);

/** Narrow an arbitrary string to a backend, or undefined if this build has never heard of it. */
export function asBackendKind(value: string): BackendKind | undefined {
  return (BACKEND_KINDS as ReadonlyArray<string>).includes(value)
    ? (value as BackendKind)
    : undefined;
}

/**
 * Verify a candidate key and store it when it works.
 *
 * Returns the outcome rather than failing, because all three cases are ordinary
 * things for a user to do and every caller has to render them anyway.
 */
export const connectAgent = Effect.fnUntraced(function* (input: {
  readonly instanceId: ProviderInstanceId;
  readonly backend: string;
  readonly secret?: string | undefined;
  readonly baseUrl?: string | undefined;
}) {
  const backend = asBackendKind(input.backend);
  if (backend === undefined) {
    return {
      _tag: "Rejected",
      detail: `This build does not know a backend called "${input.backend}".`,
    } satisfies ConnectAgentResult;
  }

  const trimmedSecret = input.secret?.trim();
  const credential =
    trimmedSecret === undefined || trimmedSecret === "" ? undefined : Redacted.make(trimmedSecret);
  const trimmedBaseUrl = input.baseUrl?.trim();
  const baseUrl =
    trimmedBaseUrl === undefined || trimmedBaseUrl === "" ? undefined : trimmedBaseUrl;

  // Refused before the key is sent anywhere, and before it is stored. This
  // address is where every later request carries the credential too, not just
  // the check below, so an unencrypted one off this machine leaks it for good.
  if (baseUrl !== undefined && !isSafeBaseUrl(baseUrl)) {
    return { _tag: "Rejected", detail: UNSAFE_BASE_URL_DETAIL } satisfies ConnectAgentResult;
  }

  // Everything except a local server needs a key, and asking the provider about
  // an absent one wastes a round trip to be told what we already know.
  if (credential === undefined && backend !== "openai-compat") {
    return { _tag: "Rejected", detail: "Paste a key to connect." } satisfies ConnectAgentResult;
  }

  const outcome = yield* verifyCredential({
    backend,
    credential,
    ...(baseUrl === undefined ? {} : { baseUrl }),
  });
  if (outcome._tag !== "Ok") {
    return outcome;
  }

  const serverSettings = yield* ServerSettingsService;
  const settings = yield* serverSettings.getSettings;
  const existing = settings.providerInstances[input.instanceId];
  const config = decodeT3AgentSettings(
    (existing?.config as Record<string, unknown> | undefined) ?? {},
  );

  // Replace any prior entry for this variable rather than appending a second
  // one — two entries with the same name is a silent, confusing failure.
  const environment = (existing?.environment ?? []).filter(
    (entry) => entry.name !== config.credentialEnvVar,
  );

  yield* serverSettings.updateSettings({
    providerInstances: {
      ...settings.providerInstances,
      [input.instanceId]: {
        ...existing,
        driver: existing?.driver ?? "t3agent",
        enabled: true,
        config: { ...config, backend, ...(baseUrl === undefined ? {} : { baseUrl }) },
        environment:
          credential === undefined
            ? environment
            : [
                ...environment,
                {
                  name: config.credentialEnvVar,
                  value: Redacted.value(credential),
                  sensitive: true,
                },
              ],
      },
    },
  });

  return outcome;
});
