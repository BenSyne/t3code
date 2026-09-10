import type { ReactNode } from "react";
import type {
  ModelSelection,
  ServerProvider,
  ServerSettings,
  ThreadOrchestration,
} from "@t3tools/contracts";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import {
  getSubscriptionFallbackIssue,
  providerAccountChain,
  resolveThreadWorkerModels,
  threadAccountFallbacks,
} from "@t3tools/shared/serverSettings";
import { Badge } from "../ui/badge";
import { Checkbox } from "../ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { Separator } from "../ui/separator";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import {
  ComposerControl,
  ComposerControlChevron,
  type ComposerControlSize,
} from "./ComposerControl";
import { composerFloatingLayerProps } from "./composerEventScope";

export function ThreadWorkingAccounts({
  value,
  onChange,
  providers,
  selection,
  settings,
  disabled,
  size,
  orchestratorPicker,
  open,
  onOpenChange,
}: {
  value: ThreadOrchestration;
  onChange: (value: ThreadOrchestration) => void;
  providers: ReadonlyArray<ServerProvider>;
  selection: ModelSelection;
  settings: ServerSettings;
  disabled: boolean;
  size: ComposerControlSize;
  orchestratorPicker: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const name = (id: ModelSelection["instanceId"]) => {
    const provider = providers.find((entry) => entry.instanceId === id);
    return provider ? resolveProviderInstanceDisplayName(provider) : id;
  };
  const selectedProvider = providers.find(
    (provider) => provider.instanceId === selection.instanceId,
  );
  const modelName =
    selectedProvider?.models.find((model) => model.slug === selection.model)?.name ??
    selection.model;
  const workers = resolveThreadWorkerModels(value, providers);
  const workerIds = [
    ...new Set([
      ...providers.filter((provider) => provider.enabled).map((provider) => provider.instanceId),
      ...value.workerAccountIds,
    ]),
  ].toSorted((left, right) => {
    if (left === selection.instanceId) return -1;
    if (right === selection.instanceId) return 1;
    return (
      providerAccountChain(settings, left).indexOf(left) -
      providerAccountChain(settings, right).indexOf(right)
    );
  });
  const fallbackSources =
    value.mode === "delegated"
      ? [...new Set([selection.instanceId, ...workers.map((worker) => worker.instanceId)])]
      : [selection.instanceId];
  const availableFallbackIds = [
    ...new Set(
      fallbackSources.flatMap((id) => {
        const chain = providerAccountChain(settings, id);
        return chain.slice(chain.indexOf(id) + 1);
      }),
    ),
  ];
  const selectedFallbackIds = value.fallbackAccountIds ?? availableFallbackIds;
  const changeWorkers = (next: ReadonlyArray<ModelSelection>) =>
    onChange({
      ...value,
      workerAccountIds: [...new Set(next.map((worker) => worker.instanceId))],
      workerModels: next,
    });
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={
          <ComposerControl
            size={size}
            aria-label="Thread models"
            data-chat-provider-model-picker="true"
          />
        }
      >
        <span className="max-w-40 truncate">{modelName}</span>
        <Badge variant="outline" size="sm">
          {value.mode === "same-account" ? "Usage-only" : `Team · ${workers.length}`}
        </Badge>
        <ComposerControlChevron />
      </PopoverTrigger>
      <PopoverPopup
        {...composerFloatingLayerProps}
        align="start"
        className="w-100 max-w-[calc(100vw-2rem)]"
      >
        <div className="flex flex-col gap-4 text-sm">
          <PopoverTitle>Thread models</PopoverTitle>
          <div className="flex flex-col gap-1">
            <span className="font-medium">Orchestrator</span>
            <p className="text-xs text-muted-foreground">Plans the work and reviews the result.</p>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>{name(selection.instanceId)}</span>
              {orchestratorPicker}
            </div>
          </div>
          <Separator />
          <fieldset className="flex min-w-0 flex-col gap-2" disabled={disabled}>
            <legend className="mb-2 font-medium">Work mode</legend>
            <ToggleGroup
              aria-label="Work mode"
              value={[value.mode]}
              disabled={disabled}
              onValueChange={(modes) => {
                const mode = modes[0];
                if (mode === "same-account" || mode === "delegated") onChange({ ...value, mode });
              }}
            >
              <ToggleGroupItem value="same-account">Usage-only fallback</ToggleGroupItem>
              <ToggleGroupItem value="delegated">Parallel team</ToggleGroupItem>
            </ToggleGroup>
            <p className="text-xs text-muted-foreground">
              {value.mode === "same-account"
                ? "The orchestrator plans and builds. Switch accounts only when the provider confirms this model's usage limit. Keep the same model and conversation."
                : "The orchestrator can assign independent tasks to several selected models at once, then review their work. Workers share project files; parallel work is not always faster."}
            </p>
          </fieldset>
          {value.mode === "delegated" && (
            <fieldset className="flex min-w-0 flex-col gap-2" disabled={disabled}>
              <legend className="mb-1 font-medium">Allowed worker models</legend>
              <p className="text-xs text-muted-foreground">
                Select one or more models under each account. Only these models may receive
                assignments.
              </p>
              <div className="flex max-h-60 flex-col gap-1 overflow-y-auto">
                {workerIds.map((id) => {
                  const provider = providers.find((entry) => entry.instanceId === id);
                  const selected = workers.filter((worker) => worker.instanceId === id);
                  const unavailable =
                    !provider?.enabled ||
                    !provider.installed ||
                    provider.auth.status === "unauthenticated" ||
                    provider.availability === "unavailable";
                  const models = [
                    ...(provider?.models ?? []),
                    ...selected
                      .filter(
                        (worker) => !provider?.models.some((model) => model.slug === worker.model),
                      )
                      .map((worker) => ({ slug: worker.model, name: worker.model })),
                  ];
                  return (
                    <Collapsible key={id} defaultOpen={selected.length > 0}>
                      <CollapsibleTrigger
                        render={
                          <Button variant="ghost" size="sm" className="w-full justify-between" />
                        }
                      >
                        <span className="truncate">{name(id)}</span>
                        <span className="text-xs text-muted-foreground">
                          {unavailable ? "Unavailable" : `${selected.length} selected`} ▾
                        </span>
                      </CollapsibleTrigger>
                      <CollapsiblePanel>
                        <div className="flex flex-col gap-2 px-3 py-2">
                          {models.map((model) => {
                            const checked = selected.some((worker) => worker.model === model.slug);
                            return (
                              <label key={model.slug} className="flex items-center gap-2">
                                <Checkbox
                                  aria-label={`${name(id)} · ${model.name}`}
                                  checked={checked}
                                  disabled={disabled || (unavailable && !checked)}
                                  onCheckedChange={(next) =>
                                    changeWorkers(
                                      next
                                        ? [...workers, { instanceId: id, model: model.slug }]
                                        : workers.filter(
                                            (worker) =>
                                              worker.instanceId !== id ||
                                              worker.model !== model.slug,
                                          ),
                                    )
                                  }
                                />
                                <span>{model.name}</span>
                              </label>
                            );
                          })}
                          {models.length === 0 && (
                            <p className="text-xs text-muted-foreground">
                              No models available. Connect this account in provider settings.
                            </p>
                          )}
                        </div>
                      </CollapsiblePanel>
                    </Collapsible>
                  );
                })}
              </div>
              {workers.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  Select a worker model to enable team assignments.
                </p>
              )}
            </fieldset>
          )}
          <Separator />
          <fieldset className="flex min-w-0 flex-col gap-2" disabled={disabled}>
            <legend className="mb-1 font-medium">Backups at usage limit</legend>
            <p className="text-xs text-muted-foreground">
              These accounts are reserves, used in the configured order with the same model.
              Unchecked accounts will not take over in this thread. Unavailable backups are skipped
              until ready.
            </p>
            {availableFallbackIds.map((id) => {
              const provider = providers.find((entry) => entry.instanceId === id);
              const issue = getSubscriptionFallbackIssue(settings, providers, id);
              const checked = selectedFallbackIds.includes(id);
              const unavailable =
                provider?.auth.status !== "authenticated" ||
                !provider.enabled ||
                !provider.installed ||
                !!issue;
              return (
                <label key={id} className="flex items-center gap-2">
                  <Checkbox
                    aria-label={`Allow ${name(id)} as backup`}
                    checked={checked}
                    disabled={disabled}
                    onCheckedChange={(next) =>
                      onChange({
                        ...value,
                        fallbackAccountIds: next
                          ? [...selectedFallbackIds, id]
                          : selectedFallbackIds.filter((account) => account !== id),
                      })
                    }
                  />
                  <span>{name(id)}</span>
                  {unavailable && (
                    <Badge variant="outline" size="sm">
                      {issue?.kind === "duplicate" ? "Duplicate" : "Unavailable"}
                    </Badge>
                  )}
                </label>
              );
            })}
            {availableFallbackIds.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No substitutes configured for these accounts. Add subscriptions in Settings →
                Providers.
              </p>
            )}
            {value.mode === "same-account" && (
              <p className="text-xs text-muted-foreground">
                Order:{" "}
                {[
                  selection.instanceId,
                  ...threadAccountFallbacks(settings, value, selection.instanceId),
                ]
                  .map(name)
                  .join(" → ")}
              </p>
            )}
          </fieldset>
          {disabled && (
            <p className="text-xs text-muted-foreground">
              Wait for the current turn or save to finish before changing this setup.
            </p>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
