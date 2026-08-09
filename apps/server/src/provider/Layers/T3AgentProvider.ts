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
import type { ResolvedCredential } from "../../agent/model/credentials.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";

/** Models offered before a live catalogue exists. */
const KNOWN_MODELS: ReadonlyArray<{ slug: string; name: string }> = [
  { slug: "claude-opus-5", name: "Claude Opus 5" },
  { slug: "claude-sonnet-5", name: "Claude Sonnet 5" },
  { slug: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
];

export function defaultModelFor(settings: T3AgentSettings): string {
  const configured = settings.defaultModel.trim();
  if (configured !== "") {
    return configured;
  }
  return DEFAULT_MODEL_BY_PROVIDER[T3AGENT_DRIVER_KIND] ?? "claude-sonnet-5";
}

function buildModels(settings: T3AgentSettings): ReadonlyArray<ServerProviderModel> {
  const preferred = defaultModelFor(settings);
  const known = KNOWN_MODELS.map((model) => ({
    slug: model.slug,
    name: model.name,
    isCustom: false,
    isDefault: model.slug === preferred,
    capabilities: null,
  }));

  // A custom slug the user typed wins over nothing; duplicates of a known model
  // would render twice, so they are dropped rather than deduped silently later.
  const knownSlugs = new Set(known.map((model) => model.slug));
  const custom = settings.customModels
    .map((slug) => slug.trim())
    .filter((slug) => slug !== "" && !knownSlugs.has(slug))
    .map((slug) => ({ slug, name: slug, isCustom: true, capabilities: null }));

  return [...known, ...custom];
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
