import type {
  ModelSelection,
  ServerProvider,
  ServerSettings,
  ThreadOrchestration,
} from "@t3tools/contracts";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import { providerAccountChain } from "@t3tools/shared/serverSettings";
import { Checkbox } from "../ui/checkbox";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Radio, RadioGroup } from "../ui/radio-group";
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
}: {
  value: ThreadOrchestration;
  onChange: (value: ThreadOrchestration) => void;
  providers: ReadonlyArray<ServerProvider>;
  selection: ModelSelection;
  settings: ServerSettings;
  disabled: boolean;
  size: ComposerControlSize;
}) {
  const name = (id: ModelSelection["instanceId"]) => {
    const provider = providers.find((entry) => entry.instanceId === id);
    return provider ? resolveProviderInstanceDisplayName(provider) : id;
  };
  const chain = providerAccountChain(settings, selection.instanceId);
  const substitutes = chain.slice(chain.indexOf(selection.instanceId) + 1);
  const accountIds = [
    ...new Set([...providers.map((provider) => provider.instanceId), ...value.workerAccountIds]),
  ];
  return (
    <Popover>
      <PopoverTrigger render={<ComposerControl size={size} aria-label="Working accounts" />}>
        {value.mode === "same-account"
          ? "Same account"
          : `Workers · ${value.workerAccountIds.length}`}
        <ComposerControlChevron />
      </PopoverTrigger>
      <PopoverPopup {...composerFloatingLayerProps} align="start" className="w-80">
        <div className="space-y-3 p-1 text-sm">
          <h3 className="font-medium">Working accounts</h3>
          <RadioGroup
            aria-label="Orchestration and development"
            value={value.mode}
            disabled={disabled}
            onValueChange={(mode) => {
              if (mode === "same-account" || mode === "delegated") onChange({ ...value, mode });
            }}
          >
            <label className="flex items-center gap-2">
              <Radio value="same-account" />
              Same account and model
            </label>
            <label className="flex items-center gap-2">
              <Radio value="delegated" />
              Separate worker accounts
            </label>
          </RadioGroup>
          {value.mode === "same-account" ? (
            <p className="text-xs text-muted-foreground">
              {name(selection.instanceId)} · {selection.model} plans and builds in this thread. The
              account changes automatically only after a usage limit for this model.
            </p>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                {name(selection.instanceId)} · {selection.model} orchestrates. Select the accounts
                it can assign development work to.
              </p>
              <div
                className="max-h-56 space-y-2 overflow-y-auto"
                role="group"
                aria-label="Worker accounts"
              >
                {accountIds.map((id) => {
                  const provider = providers.find((entry) => entry.instanceId === id);
                  const checked = value.workerAccountIds.includes(id);
                  const unavailable =
                    !provider?.enabled ||
                    !provider.installed ||
                    provider.auth.status === "unauthenticated" ||
                    provider.availability === "unavailable";
                  return (
                    <label key={id} className="flex items-center gap-2">
                      <Checkbox
                        checked={checked}
                        disabled={disabled || (unavailable && !checked)}
                        onCheckedChange={(next) =>
                          onChange({
                            ...value,
                            workerAccountIds: next
                              ? [...value.workerAccountIds, id]
                              : value.workerAccountIds.filter((account) => account !== id),
                          })
                        }
                      />
                      <span>
                        {name(id)}
                        {unavailable ? " (unavailable)" : ""}
                      </span>
                    </label>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground">
                {value.workerAccountIds.length === 0
                  ? "No workers selected. Select an account to enable delegation."
                  : "Each worker keeps its model. Its configured substitutes are used only after a usage limit."}
              </p>
            </>
          )}
          {substitutes.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {value.mode === "delegated" ? "Orchestrator" : "Account"} fallback order:{" "}
              {substitutes.map(name).join(" → ")}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Applies to this thread. Manage subscriptions and fallback order in Settings → Providers.
          </p>
          {disabled && (
            <p className="text-xs text-muted-foreground">
              Wait for the current turn or save to finish before changing accounts.
            </p>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
