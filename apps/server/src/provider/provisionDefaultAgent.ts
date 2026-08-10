/**
 * Put the built-in agent in the app before anyone goes looking for it.
 *
 * The agent used to require a trip through Settings → Providers → new instance
 * before it existed at all, which put six steps between installing the app and
 * sending a message. It ships with the server, so it can simply be there.
 *
 * Provisioned without a key, which is a state the provider already models:
 * `unauthenticated` is reported as a *warning* rather than an error precisely
 * so an instance can exist and be visibly waiting for something. Nothing runs
 * and nothing is spent until a key arrives.
 *
 * The decision is a pure function so the conditions can be tested without a
 * settings file, a server, or a clock.
 *
 * @module provider/provisionDefaultAgent
 */
import { ProviderInstanceId, type ProviderInstanceConfig } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { T3AGENT_DRIVER_KIND } from "../agent/driverKind.ts";
import { ServerSettingsService } from "../serverSettings.ts";

/** The id the provisioned instance takes. Stable, so it can be recognised later. */
export const DEFAULT_AGENT_INSTANCE_ID = ProviderInstanceId.make("t3agent");

/** What the user sees before they have renamed anything. */
export const DEFAULT_AGENT_DISPLAY_NAME = "T3 Orchestrator";

/**
 * What provisioning decided, and why.
 *
 * Three outcomes rather than a boolean because the two "do nothing" cases are
 * not the same: one still has to record that the offer was made, so that a
 * later deletion sticks.
 */
export type ProvisionDecision =
  /** Offered before. Whatever the user did with it afterwards is their business. */
  | { readonly _tag: "AlreadyOffered" }
  /** An instance exists that we did not put there. Leave it alone, record the offer. */
  | { readonly _tag: "AdoptExisting" }
  /** Nothing here yet. */
  | { readonly _tag: "Provision"; readonly instance: ProviderInstanceConfig };

/**
 * Decide whether to write a built-in agent instance.
 *
 * Deliberately conservative: it writes only when the agent has never been
 * offered *and* no instance of it exists. Anything else — a configured
 * instance, a renamed one, one the user deleted — is left exactly as found.
 */
export function planDefaultAgentProvision(input: {
  readonly offered: boolean;
  readonly instances: Readonly<Record<string, { readonly driver: string }>>;
}): ProvisionDecision {
  if (input.offered) {
    return { _tag: "AlreadyOffered" };
  }
  const hasAgentInstance = Object.values(input.instances).some(
    (instance) => instance.driver === T3AGENT_DRIVER_KIND,
  );
  if (hasAgentInstance) {
    return { _tag: "AdoptExisting" };
  }
  return {
    _tag: "Provision",
    instance: {
      driver: T3AGENT_DRIVER_KIND,
      displayName: DEFAULT_AGENT_DISPLAY_NAME,
      enabled: true,
      // Empty on purpose: every field of the agent's settings has a decoding
      // default, so this picks up whatever the current defaults are — today
      // OpenRouter, reading OPENROUTER_API_KEY — without restating them here
      // and letting the two drift.
      config: {},
    } satisfies ProviderInstanceConfig,
  };
}

/**
 * Apply the decision, once, at startup.
 *
 * Records the offer in every branch, including the ones that write no instance.
 * That is the whole point of the flag: after this runs, deleting the agent is
 * permanent.
 */
export const provisionDefaultAgent = Effect.fnUntraced(function* () {
  const serverSettings = yield* ServerSettingsService;
  const settings = yield* serverSettings.getSettings;

  const decision = planDefaultAgentProvision({
    offered: settings.builtInAgentOffered,
    instances: settings.providerInstances,
  });

  if (decision._tag === "AlreadyOffered") {
    return decision;
  }

  yield* serverSettings.updateSettings({
    builtInAgentOffered: true,
    ...(decision._tag === "Provision"
      ? {
          providerInstances: {
            ...settings.providerInstances,
            [DEFAULT_AGENT_INSTANCE_ID]: decision.instance,
          },
        }
      : {}),
  });

  return decision;
});
