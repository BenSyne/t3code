/**
 * The status T3 Code shows for a built-in agent instance.
 *
 * Every other provider answers "is it installed?" by probing a binary on PATH.
 * There is nothing to probe here — the agent ships with the server — so
 * `installed` is always true. That is not a white lie: the field decides
 * whether the provider is usable on this machine, and mobile silently hides
 * anything reporting false while web renders "CLI not detected on PATH".
 *
 * What can genuinely be missing is the API key, and that is what `auth`
 * reports, naming the variable to set rather than leaving the user guessing.
 *
 * @module provider/Layers/T3AgentProvider
 */
import type {
  ServerProviderAuth,
  ServerProviderModel,
  ServerProviderState,
  T3AgentSettings,
} from "@t3tools/contracts";
import { DEFAULT_MODEL_BY_PROVIDER } from "@t3tools/contracts";

import { T3AGENT_DRIVER_KIND } from "../../agent/driverKind.ts";
import { KNOWN_MODELS } from "../../agent/model/ModelCatalog.ts";
import type { ResolvedCredential } from "../../agent/model/credentials.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";

/**
 * The model this instance uses when a thread does not name one.
 *
 * Falls back per backend, not to a single global default. A blank default on an
 * OpenRouter instance previously resolved to `claude-sonnet-5`, which OpenRouter
 * does not recognise — it wants `anthropic/claude-sonnet-5` — so the first turn
 * failed with a model-not-found error that pointed nowhere useful.
 */
export function defaultModelFor(settings: T3AgentSettings): string {
  const configured = settings.defaultModel.trim();
  if (configured !== "") {
    return configured;
  }
  const forBackend = KNOWN_MODELS[settings.backend][0]?.id;
  return forBackend ?? DEFAULT_MODEL_BY_PROVIDER[T3AGENT_DRIVER_KIND] ?? "claude-sonnet-5";
}

/**
 * What the model picker offers for this instance.
 *
 * Keyed by the chosen backend: an OpenRouter instance must not advertise bare
 * Anthropic slugs, because picking one sends a request that cannot succeed.
 * The configured default is always included even when the catalogue has never
 * heard of it — the user typed it deliberately, and a picker that hides the
 * model the instance is actually set to is worse than one that is incomplete.
 */
function buildModels(settings: T3AgentSettings): ReadonlyArray<ServerProviderModel> {
  const preferred = defaultModelFor(settings);
  const catalogue = KNOWN_MODELS[settings.backend];

  const known = catalogue.map((model) => ({
    slug: model.id,
    name: model.label,
    isCustom: false,
    isDefault: model.id === preferred,
    capabilities: null,
  }));

  const seen = new Set(known.map((model) => model.slug));
  const extra = [preferred, ...settings.customModels]
    .map((slug) => slug.trim())
    .filter((slug) => {
      if (slug === "" || seen.has(slug)) {
        return false;
      }
      seen.add(slug);
      return true;
    })
    .map((slug) => ({
      slug,
      name: slug,
      isCustom: true,
      isDefault: slug === preferred,
      capabilities: null,
    }));

  return [...known, ...extra];
}

function buildAuth(credential: ResolvedCredential): ServerProviderAuth {
  if (credential._tag === "Resolved") {
    return { status: "authenticated", type: "api-key", label: credential.variableName };
  }
  return { status: "unauthenticated", type: "api-key", label: credential.variableName };
}

/**
 * Build the snapshot for one instance.
 *
 * `warning` rather than `error` when unauthenticated: nothing is broken, the
 * instance simply is not finished being set up, and an error state reads to the
 * user like something failed.
 */
export function buildT3AgentSnapshot(input: {
  readonly settings: T3AgentSettings;
  readonly credential: ResolvedCredential;
  readonly checkedAt: string;
}): ServerProviderDraft {
  const authenticated = input.credential._tag === "Resolved";
  const status: ServerProviderState = !input.settings.enabled
    ? "disabled"
    : authenticated
      ? "ready"
      : "warning";

  return {
    enabled: input.settings.enabled,
    // Compiled into the server: there is no binary and nothing to install.
    installed: true,
    // No separate version — the agent ships with whatever server is running.
    version: null,
    status,
    auth: buildAuth(input.credential),
    checkedAt: input.checkedAt,
    ...(authenticated
      ? {}
      : {
          message: `Set ${input.credential.variableName} on this instance to start using the built-in agent.`,
        }),
    models: buildModels(input.settings),
    slashCommands: [],
    skills: [],
  };
}
