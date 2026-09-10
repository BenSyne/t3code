import {
  isProviderDriverKind,
  isProviderAvailable,
  resolveProviderInstanceEnabled,
  type ModelSelection,
  type ThreadOrchestration,
  type ProjectId,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
  ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { deepMerge } from "./Struct.ts";
import { fromLenientJson } from "./schemaJson.ts";
import { createModelSelection } from "./model.ts";
import {
  getBackgroundActivityBaseProfile,
  normalizeBackgroundActivitySettings,
  normalizeServerBackgroundActivitySettings,
  resolveBackgroundActivitySettings,
} from "./backgroundActivitySettings.ts";

const ServerSettingsJson = fromLenientJson(ServerSettings);
const decodeServerSettingsJson = Schema.decodeUnknownOption(ServerSettingsJson);

/** Project restrictions apply equally to direct turns, workers, and substitutes. */
export function isProjectProviderAccountAllowed(
  settings: Pick<ServerSettings, "projectProviderAccounts">,
  projectId: ProjectId | null | undefined,
  instanceId: ProviderInstanceId,
): boolean {
  const accounts = projectId == null ? null : settings.projectProviderAccounts[projectId];
  return accounts == null || accounts.includes(instanceId);
}

/** The order stays stable after a thread moves from its primary to a substitute. */
export function providerAccountChain(
  settings: Pick<ServerSettings, "providerAccountFallbacks">,
  instanceId: ProviderInstanceId,
): ReadonlyArray<ProviderInstanceId> {
  for (const [primary, substitutes] of Object.entries(settings.providerAccountFallbacks)) {
    if (substitutes.length === 0) continue;
    if (primary === instanceId || substitutes.includes(instanceId)) {
      return [primary as ProviderInstanceId, ...substitutes];
    }
  }
  return [instanceId];
}

/** A substitute must represent a verified, distinct subscription in its chain. */
export function getSubscriptionFallbackIssue(
  settings: Pick<ServerSettings, "providerAccountFallbacks">,
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "driver" | "auth" | "displayName">>,
  instanceId: ProviderInstanceId,
): { kind: "duplicate" | "unverified"; message: string } | null {
  const chain = providerAccountChain(settings, instanceId);
  const index = chain.indexOf(instanceId);
  if (index < 1) return null;
  const candidate = providers.find((provider) => provider.instanceId === instanceId);
  if (candidate?.auth.status !== "authenticated") return null;
  const email = candidate.auth.email?.trim().toLowerCase();
  const earlierAccounts = chain
    .slice(0, index)
    .flatMap((id) => providers.find((provider) => provider.instanceId === id) ?? []);
  const duplicate = email
    ? earlierAccounts.find(
        (earlier) =>
          earlier.driver === candidate.driver &&
          earlier.auth.status === "authenticated" &&
          earlier.auth.email?.trim().toLowerCase() === email &&
          (!earlier.auth.organizationId ||
            !candidate.auth.organizationId ||
            earlier.auth.organizationId === candidate.auth.organizationId),
      )
    : undefined;
  if (duplicate) {
    return {
      kind: "duplicate",
      message: `This is the same subscription as ${duplicate.displayName ?? duplicate.instanceId}. It cannot provide extra usage and will be skipped during automatic continuation. Sign in with a different account.`,
    };
  }
  const main = earlierAccounts.find((provider) => provider.instanceId === chain[0]);
  // Unverified intermediate substitutes are skipped themselves; they must not
  // prevent a later, verified account from continuing the task.
  if (!email || !main || (main.auth.status !== "unauthenticated" && !main.auth.email?.trim())) {
    return {
      kind: "unverified",
      message:
        "T3 could not verify that this is a separate subscription. Automatic continuation will skip it until account identities are verified. Refresh the accounts or sign in again.",
    };
  }
  return null;
}

export function isOrchestratorSelection(
  settings: Pick<ServerSettings, "orchestratorModelSelection" | "providerAccountFallbacks">,
  selection: ModelSelection,
): boolean {
  const orchestrator = settings.orchestratorModelSelection;
  if (!orchestrator || orchestrator.model !== selection.model) return false;
  const chain = providerAccountChain(settings, orchestrator.instanceId);
  return chain.slice(chain.indexOf(orchestrator.instanceId)).includes(selection.instanceId);
}

/** Only selected workers may receive assignments; resumed workers may use their substitutes. */
export function isThreadWorkerAccountAllowed(
  orchestration: ThreadOrchestration | undefined,
  instanceId: ProviderInstanceId,
  settings: Pick<ServerSettings, "providerAccountFallbacks">,
  includeSubstitutes = false,
): boolean {
  if (orchestration?.mode !== "delegated") return false;
  return orchestration.workerAccountIds.some((primary) => {
    if (primary === instanceId) return true;
    if (!includeSubstitutes) return false;
    return threadAccountFallbacks(settings, orchestration, primary).includes(instanceId);
  });
}

/** Thread choices narrow the configured continuation order, never expand it. */
export function threadAccountFallbacks(
  settings: Pick<ServerSettings, "providerAccountFallbacks">,
  orchestration: ThreadOrchestration | undefined,
  instanceId: ProviderInstanceId,
): ReadonlyArray<ProviderInstanceId> {
  const chain = providerAccountChain(settings, instanceId);
  return chain
    .slice(chain.indexOf(instanceId) + 1)
    .filter(
      (id) =>
        orchestration?.fallbackAccountIds === undefined ||
        orchestration.fallbackAccountIds.includes(id),
    );
}

/** Expand legacy account selections once when editing them in the model controls. */
export function resolveThreadWorkerModels(
  orchestration: ThreadOrchestration,
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "models">>,
): ReadonlyArray<ModelSelection> {
  return (
    orchestration.workerModels ??
    providers.flatMap((provider) =>
      orchestration.workerAccountIds.includes(provider.instanceId)
        ? provider.models.map((model) => ({ instanceId: provider.instanceId, model: model.slug }))
        : [],
    )
  );
}

/** Enforce the account and model pair on both new assignments and continued workers. */
export function isThreadWorkerModelAllowed(
  orchestration: ThreadOrchestration | undefined,
  selection: ModelSelection,
  settings: Pick<ServerSettings, "providerAccountFallbacks">,
  includeSubstitutes = false,
): boolean {
  if (
    !isThreadWorkerAccountAllowed(orchestration, selection.instanceId, settings, includeSubstitutes)
  )
    return false;
  if (orchestration?.workerModels === undefined) return true;
  return orchestration.workerModels.some(
    (allowed) =>
      allowed.model === selection.model &&
      orchestration.workerAccountIds.includes(allowed.instanceId) &&
      (allowed.instanceId === selection.instanceId ||
        (includeSubstitutes &&
          threadAccountFallbacks(settings, orchestration, allowed.instanceId).includes(
            selection.instanceId,
          ))),
  );
}

/** Reject ambiguous chains instead of choosing an arbitrary primary during recovery. */
export function validateProviderAccountFallbacks(
  settings: Pick<ServerSettings, "providerInstances" | "providerAccountFallbacks">,
): string | null {
  const assigned = new Set<string>();
  for (const [primary, substitutes] of Object.entries(settings.providerAccountFallbacks)) {
    if (substitutes.length === 0) continue;
    const driver =
      settings.providerInstances[primary as ProviderInstanceId]?.driver ??
      (primary === "codex" || primary === "claudeAgent" ? primary : undefined);
    if (driver !== "codex" && driver !== "claudeAgent") {
      return "Account fallback requires a configured Codex or Claude primary account.";
    }
    for (const id of [primary as ProviderInstanceId, ...substitutes]) {
      if (assigned.has(id)) return `Account '${id}' appears more than once in the fallback order.`;
      if (
        (settings.providerInstances[id]?.driver ??
          (id === "codex" || id === "claudeAgent" ? id : undefined)) !== driver
      ) {
        return "Substitute accounts must use the same provider as their primary account.";
      }
      assigned.add(id);
    }
  }
  return null;
}

/** Fresh credentials and shared native history make the new account eligible for continuation. */
export function createSubscriptionAccountPatch(
  settings: ServerSettings,
  input: {
    driver: "codex" | "claudeAgent";
    instanceId: ProviderInstanceId;
    name: string;
    primaryId: ProviderInstanceId;
    sharedHistoryPath?: string;
  },
): ServerSettingsPatch {
  const name = input.name.trim();
  if (
    !name ||
    Object.values(settings.providerInstances).some(
      (instance) => instance.displayName?.toLowerCase() === name.toLowerCase(),
    )
  ) {
    throw new Error("Choose a distinct account name.");
  }
  if (settings.providerInstances[input.instanceId])
    throw new Error("This account ID already exists.");
  const primary = settings.providerInstances[input.primaryId];
  const primaryDriver = primary?.driver ?? input.primaryId;
  if (primaryDriver !== input.driver)
    throw new Error("Choose a main account with the same provider.");
  const config =
    primary?.config && typeof primary.config === "object" && !Array.isArray(primary.config)
      ? (primary.config as Record<string, unknown>)
      : settings.providers[input.driver];
  const readPath = (key: string) =>
    typeof config[key as keyof typeof config] === "string"
      ? String(config[key as keyof typeof config]).trim()
      : "";
  const accountHome = `~/.t3/subscriptions/${input.instanceId}`;
  const accountConfig =
    input.driver === "codex"
      ? { homePath: input.sharedHistoryPath ?? readPath("homePath"), shadowHomePath: accountHome }
      : {
          homePath: accountHome,
          sessionHomePath:
            input.sharedHistoryPath ??
            (readPath("sessionHomePath") || readPath("homePath") || "~/.claude"),
        };
  const chain = providerAccountChain(settings, input.primaryId);
  const primaryId = chain[0]!;
  return {
    providerInstances: {
      ...settings.providerInstances,
      [input.instanceId]: {
        driver: primaryDriver as ProviderDriverKind,
        displayName: name,
        enabled: true,
        config: { ...accountConfig, binaryPath: readPath("binaryPath") },
      },
    },
    providerAccountFallbacks: {
      ...settings.providerAccountFallbacks,
      [primaryId]: [...chain.slice(1), input.instanceId],
    },
  };
}

export function removeSubscriptionAccountReferences(
  settings: Pick<ServerSettings, "providerAccountFallbacks" | "orchestratorModelSelection">,
  instanceId: ProviderInstanceId,
): ServerSettingsPatch {
  return {
    providerAccountFallbacks: Object.fromEntries(
      Object.entries(settings.providerAccountFallbacks)
        .filter(([primary]) => primary !== instanceId)
        .map(([primary, substitutes]) => [primary, substitutes.filter((id) => id !== instanceId)]),
    ),
    ...(settings.orchestratorModelSelection?.instanceId === instanceId
      ? { orchestratorModelSelection: null }
      : {}),
  };
}

export function resolveProjectAgentBrowserAccess(
  settings: Pick<ServerSettings, "enableAgentBrowserAccess" | "projectAgentBrowserAccessOverrides">,
  projectId: ProjectId,
): boolean {
  return (
    settings.projectAgentBrowserAccessOverrides[projectId] ?? settings.enableAgentBrowserAccess
  );
}

export function resolveProjectAutoPull(
  settings: Pick<ServerSettings, "defaultAutoPull" | "projectAutoPullOverrides">,
  projectId: ProjectId,
  legacyAutoPull: boolean | undefined,
): boolean {
  // Existing opt-ins stay enabled until explicitly overridden or reset.
  return (
    settings.projectAutoPullOverrides[projectId] ??
    (legacyAutoPull === true || settings.defaultAutoPull)
  );
}

type LegacyProviderSettings = ServerSettings["providers"][keyof ServerSettings["providers"]];

const getLegacyProviderSettings = (
  settings: ServerSettings,
  provider: ProviderDriverKind,
): LegacyProviderSettings | undefined =>
  (settings.providers as Record<string, LegacyProviderSettings | undefined>)[provider];

export function isModelSelectionProviderEnabled(
  settings: ServerSettings,
  selection: ModelSelection,
): boolean {
  const instanceConfig = settings.providerInstances[selection.instanceId];
  if (instanceConfig !== undefined) {
    return resolveProviderInstanceEnabled(instanceConfig);
  }

  return (
    isProviderDriverKind(selection.instanceId) &&
    getLegacyProviderSettings(settings, selection.instanceId)?.enabled === true
  );
}

export function resolveSourceControlWriterModelSelection(
  settings: ServerSettings,
  providers?: ReadonlyArray<ServerProvider>,
): ModelSelection {
  const selection = settings.sourceControlWriterModelSelection;
  if (!selection || !isModelSelectionProviderEnabled(settings, selection)) {
    return settings.textGenerationModelSelection;
  }
  if (providers === undefined) {
    return selection;
  }

  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  return provider?.enabled === true && isProviderAvailable(provider)
    ? selection
    : settings.textGenerationModelSelection;
}

export interface PersistedServerObservabilitySettings {
  readonly otlpTracesUrl: string | undefined;
  readonly otlpMetricsUrl: string | undefined;
}

function normalizePersistedServerSettingString(
  value: string | null | undefined,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function extractPersistedServerObservabilitySettings(input: {
  readonly observability?: {
    readonly otlpTracesUrl?: string;
    readonly otlpMetricsUrl?: string;
  };
}): PersistedServerObservabilitySettings {
  return {
    otlpTracesUrl: normalizePersistedServerSettingString(input.observability?.otlpTracesUrl),
    otlpMetricsUrl: normalizePersistedServerSettingString(input.observability?.otlpMetricsUrl),
  };
}

export function parsePersistedServerObservabilitySettings(
  raw: string,
): PersistedServerObservabilitySettings {
  const decoded = decodeServerSettingsJson(raw);
  if (Option.isSome(decoded)) {
    return extractPersistedServerObservabilitySettings(decoded.value);
  }
  return { otlpTracesUrl: undefined, otlpMetricsUrl: undefined };
}

function shouldReplaceTextGenerationModelSelection(
  patch: ServerSettingsPatch["textGenerationModelSelection"] | undefined,
): boolean {
  return Boolean(patch && (patch.instanceId !== undefined || patch.model !== undefined));
}

function mergeModelSelectionOptionsById(input: {
  current: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }> | undefined;
  patch: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }> | undefined;
}): Array<{ id: string; value: string | boolean }> | undefined {
  if (input.patch === undefined) {
    return input.current ? [...input.current] : undefined;
  }
  if (input.patch.length === 0) {
    return undefined;
  }

  const merged = new Map((input.current ?? []).map((selection) => [selection.id, selection.value]));
  for (const selection of input.patch) {
    merged.set(selection.id, selection.value);
  }
  return [...merged.entries()].map(([id, value]) => ({ id, value }));
}

/** Upsert each patched entry; `null` removes it. Entries the patch omits are untouched. */
function mergeSettingsEntries<Value>(
  current: Readonly<Record<string, Value>>,
  patch: Readonly<Record<string, Value | null>>,
): Record<string, Value> {
  const next = new Map(Object.entries(current));
  for (const [id, config] of Object.entries(patch)) {
    if (config === null) {
      next.delete(id);
    } else {
      next.set(id, config);
    }
  }
  return Object.fromEntries(next);
}

export function applyServerSettingsPatch(
  current: ServerSettings,
  patch: ServerSettingsPatch,
): ServerSettings {
  const selectionPatch = patch.textGenerationModelSelection;
  const {
    automaticGitFetchInterval,
    providerHealthRefreshInterval,
    backgroundActivityProfile,
    backgroundActivity,
    // Merged per entry below; its `null` removals must not reach deepMerge.
    usageLimitSources: usageLimitSourcesPatch,
    usagePriceOverrides: usagePriceOverridesPatch,
    projectAgentBrowserAccessOverrides: projectAgentBrowserAccessOverridesPatch,
    projectAutoPullOverrides: projectAutoPullOverridesPatch,
    ...patchForMerge
  } = patch;
  const currentBackgroundActivity = normalizeServerBackgroundActivitySettings(current);
  const backgroundActivityPatch =
    backgroundActivityProfile !== undefined
      ? {
          schemaVersion: 1 as const,
          profile:
            automaticGitFetchInterval !== undefined || providerHealthRefreshInterval !== undefined
              ? ("custom" as const)
              : backgroundActivityProfile,
          ...(automaticGitFetchInterval !== undefined || providerHealthRefreshInterval !== undefined
            ? { baseProfile: backgroundActivityProfile }
            : {}),
          overrides: {
            ...(automaticGitFetchInterval !== undefined ? { automaticGitFetchInterval } : {}),
            ...(providerHealthRefreshInterval !== undefined
              ? { providerHealthRefreshInterval }
              : {}),
          },
        }
      : automaticGitFetchInterval !== undefined || providerHealthRefreshInterval !== undefined
        ? {
            schemaVersion: 1 as const,
            profile: "custom" as const,
            baseProfile: getBackgroundActivityBaseProfile(currentBackgroundActivity),
            overrides: {
              ...(currentBackgroundActivity.profile === "custom"
                ? currentBackgroundActivity.overrides
                : {}),
              ...(automaticGitFetchInterval !== undefined ? { automaticGitFetchInterval } : {}),
              ...(providerHealthRefreshInterval !== undefined
                ? { providerHealthRefreshInterval }
                : {}),
            },
          }
        : undefined;
  const next = deepMerge(current, patchForMerge);
  const nextWithReplacementsBase = {
    ...next,
    ...(backgroundActivity !== undefined
      ? {
          backgroundActivity: {
            ...deepMerge(currentBackgroundActivity, backgroundActivity),
            ...(backgroundActivity.overrides !== undefined
              ? { overrides: backgroundActivity.overrides }
              : {}),
          },
        }
      : { backgroundActivity: currentBackgroundActivity }),
    ...(backgroundActivity === undefined && backgroundActivityPatch !== undefined
      ? { backgroundActivity: backgroundActivityPatch }
      : {}),
    ...(patch.providerInstances !== undefined
      ? { providerInstances: patch.providerInstances }
      : {}),
    ...(projectAgentBrowserAccessOverridesPatch !== undefined
      ? {
          projectAgentBrowserAccessOverrides: mergeSettingsEntries(
            current.projectAgentBrowserAccessOverrides,
            projectAgentBrowserAccessOverridesPatch,
          ),
        }
      : {}),
    ...(projectAutoPullOverridesPatch !== undefined
      ? {
          projectAutoPullOverrides: mergeSettingsEntries(
            current.projectAutoPullOverrides,
            projectAutoPullOverridesPatch,
          ),
        }
      : {}),
    ...(patch.defaultModelSelection !== undefined
      ? { defaultModelSelection: patch.defaultModelSelection }
      : {}),
    ...(patch.orchestratorModelSelection !== undefined
      ? { orchestratorModelSelection: patch.orchestratorModelSelection }
      : {}),
    ...(patch.providerAccountFallbacks !== undefined
      ? { providerAccountFallbacks: patch.providerAccountFallbacks }
      : {}),
    ...(patch.projectProviderAccounts !== undefined
      ? {
          projectProviderAccounts: {
            ...current.projectProviderAccounts,
            ...patch.projectProviderAccounts,
          },
        }
      : {}),
    ...(patch.defaultProjectScripts !== undefined
      ? { defaultProjectScripts: patch.defaultProjectScripts }
      : {}),
    ...(patch.projectScriptOverrides !== undefined
      ? {
          projectScriptOverrides: {
            ...current.projectScriptOverrides,
            ...patch.projectScriptOverrides,
          },
        }
      : {}),
    ...(usageLimitSourcesPatch !== undefined
      ? {
          usageLimitSources: mergeSettingsEntries(
            current.usageLimitSources,
            usageLimitSourcesPatch,
          ),
        }
      : {}),
    ...(usagePriceOverridesPatch !== undefined
      ? {
          usagePriceOverrides: mergeSettingsEntries(
            current.usagePriceOverrides,
            usagePriceOverridesPatch,
          ),
        }
      : {}),
    ...(patch.sourceControlWriterModelSelection !== undefined
      ? { sourceControlWriterModelSelection: patch.sourceControlWriterModelSelection }
      : {}),
    ...(automaticGitFetchInterval !== undefined ? { automaticGitFetchInterval } : {}),
    ...(providerHealthRefreshInterval !== undefined ? { providerHealthRefreshInterval } : {}),
  };
  const normalizedBackgroundActivity = normalizeBackgroundActivitySettings(
    nextWithReplacementsBase.backgroundActivity,
  );
  const resolvedBackgroundActivity = resolveBackgroundActivitySettings(
    normalizedBackgroundActivity,
  );
  const nextWithReplacements = {
    ...nextWithReplacementsBase,
    backgroundActivity: normalizedBackgroundActivity,
    automaticGitFetchInterval: resolvedBackgroundActivity.automaticGitFetchInterval,
    providerHealthRefreshInterval: resolvedBackgroundActivity.providerHealthRefreshInterval,
    backgroundActivityProfile: resolvedBackgroundActivity.profile,
  };
  if (!selectionPatch) {
    return nextWithReplacements;
  }

  const instanceId = selectionPatch.instanceId ?? current.textGenerationModelSelection.instanceId;
  const model = selectionPatch.model ?? current.textGenerationModelSelection.model;
  const options = shouldReplaceTextGenerationModelSelection(selectionPatch)
    ? selectionPatch.options
    : mergeModelSelectionOptionsById({
        current: current.textGenerationModelSelection.options,
        patch: selectionPatch.options,
      });

  return {
    ...nextWithReplacements,
    textGenerationModelSelection: createModelSelection(instanceId, model, options),
  };
}
