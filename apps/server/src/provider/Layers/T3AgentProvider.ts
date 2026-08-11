/**
 * The status T3 Code shows for a built-in agent instance.
 *
 * @module provider/Layers/T3AgentProvider
 */
import type {
  ModelCapabilities,
  ServerProviderAuth,
  ServerProviderModel,
  ServerProviderState,
  T3AgentSettings,
} from "@t3tools/contracts";
import { DEFAULT_MODEL_BY_PROVIDER } from "@t3tools/contracts";

import { T3AGENT_DRIVER_KIND } from "../../agent/driverKind.ts";
import { KNOWN_MODELS, type CatalogModel } from "../../agent/model/ModelCatalog.ts";
import type { ResolvedCredential } from "../../agent/model/credentials.ts";
import { REASONING_DEFAULT_CHOICE, REASONING_EFFORT_LABELS } from "../../agent/model/reasoning.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";

/** The model this instance uses when a thread does not name one. */
export function defaultModelFor(settings: T3AgentSettings): string {
  const configured = settings.defaultModel.trim();
  if (configured !== "") {
    return configured;
  }
  const forBackend = KNOWN_MODELS[settings.backend][0]?.id;
  return forBackend ?? DEFAULT_MODEL_BY_PROVIDER[T3AGENT_DRIVER_KIND] ?? "claude-sonnet-5";
}

/** The reasoning picker for one model, or null for a model that does not reason. */
function reasoningCapabilities(model: CatalogModel): ModelCapabilities | null {
  const efforts = model.reasoningEfforts;
  if (efforts === undefined || efforts.length === 0) {
    return null;
  }
  return {
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        options: [
          {
            id: REASONING_DEFAULT_CHOICE,
            label: "Default",
            description: "Let the provider decide. Nothing extra is sent.",
            isDefault: true,
          },
          ...efforts.map((effort) => ({ id: effort, label: REASONING_EFFORT_LABELS[effort] })),
        ],
      },
    ],
  };
}

/** What the model picker offers for this instance. */
/** The vendor, unless the model's name already opens with it. */
function vendorWorthShowing(model: CatalogModel): string | undefined {
  if (model.vendor === undefined) {
    return undefined;
  }
  const label = model.label.toLowerCase();
  const vendor = model.vendor.toLowerCase();
  return label === vendor || label.startsWith(`${vendor} `) ? undefined : model.vendor;
}

function buildModels(
  settings: T3AgentSettings,
  liveModels: ReadonlyArray<CatalogModel> | undefined,
): ReadonlyArray<ServerProviderModel> {
  const preferred = defaultModelFor(settings);
  const catalogue = liveModels ?? KNOWN_MODELS[settings.backend];

  const known = catalogue.map((model) => {
    // Rendered under the model as "<instance> · <vendor>". The same field
    // OpenCode uses for the provider behind each of its models — this backend
    // is an aggregator in exactly the same way, so it earns the same treatment
    // rather than a second mechanism that looks almost like it.
    const vendor = vendorWorthShowing(model);
    return {
      slug: model.id,
      name: model.label,
      ...(vendor === undefined ? {} : { subProvider: vendor }),
      isCustom: false,
      isDefault: model.id === preferred,
      capabilities: reasoningCapabilities(model),
    };
  });

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

/** Build the snapshot for one instance. */
export function buildT3AgentSnapshot(input: {
  readonly settings: T3AgentSettings;
  readonly credential: ResolvedCredential;
  readonly checkedAt: string;
  /**
   * The live catalogue for this backend, when a fetch has succeeded. Absent —
   * first seconds after connect, fetch failed, backend has no live source —
   * the static list stands in, so the picker never opens empty.
   */
  readonly liveModels?: ReadonlyArray<CatalogModel> | undefined;
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
    models: buildModels(input.settings, input.liveModels),
    slashCommands: [],
    skills: [],
  };
}
