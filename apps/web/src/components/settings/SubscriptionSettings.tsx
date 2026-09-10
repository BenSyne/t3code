import { useState } from "react";
import {
  ProviderInstanceId,
  type EnvironmentId,
  type ServerProvider,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import {
  createSubscriptionAccountPatch,
  providerAccountChain,
} from "@t3tools/shared/serverSettings";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { ensureLocalApi } from "../../localApi";
import { randomUUID } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Select,
  SelectGroup,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { SettingsRow, SettingsSection } from "./settingsLayout";

function AccountSelect({
  value,
  label,
  items,
  disabled,
  onChange,
}: {
  value: string | null;
  label: string;
  items: ReadonlyArray<{ value: string; label: string }>;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Select
      value={value}
      items={items}
      disabled={disabled}
      onValueChange={(next) => {
        if (next !== null) onChange(next);
      }}
    >
      <SelectTrigger size="sm" aria-label={label}>
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectPopup>
        <SelectGroup>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
}

function SubscriptionSignIn({
  environmentId,
  provider,
  readOnly,
}: {
  environmentId: EnvironmentId;
  provider: ServerProvider;
  readOnly: boolean;
}) {
  const target = { environmentId, input: { instanceId: provider.instanceId } };
  const query = useEnvironmentQuery(serverEnvironment.providerAuthState(target));
  const start = useAtomCommand(serverEnvironment.startProviderAuth, { reportFailure: false });
  const cancel = useAtomCommand(serverEnvironment.cancelProviderAuth, { reportFailure: false });
  const complete = useAtomCommand(serverEnvironment.completeProviderAuth, { reportFailure: false });
  const logout = useAtomCommand(serverEnvironment.logoutProviderAuth, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const auth = query.data;
  const active =
    auth?.phase === "starting" || auth?.phase === "waiting" || auth?.phase === "verifying";
  async function run<A, E>(command: () => Promise<AtomCommandResult<A, E>>) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await command();
      if (result._tag === "Failure") {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : "Sign-in could not complete.");
      }
    } catch {
      setError("Sign-in could not complete. Try again.");
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p role="status" className="text-xs text-muted-foreground">
        {active || auth?.phase === "failed"
          ? auth.message
          : (provider.auth.label ??
            (provider.auth.status === "authenticated" ? "Signed in" : "Connect your subscription"))}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="xs"
          variant="outline"
          disabled={readOnly || pending || active || !provider.enabled || !provider.installed}
          onClick={() => void run(() => start(target))}
        >
          Sign in
        </Button>
        {auth?.authorizationUrl && active ? (
          <Button
            size="xs"
            variant="outline"
            disabled={readOnly}
            onClick={() => {
              if (auth.authorizationUrl)
                void ensureLocalApi()
                  .shell.openExternal(auth.authorizationUrl)
                  .catch(() => setError("Could not open the sign-in page."));
            }}
          >
            Open sign-in page
          </Button>
        ) : null}
        {active && auth?.flowId ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={readOnly || pending}
            onClick={() =>
              void run(() =>
                cancel({
                  environmentId,
                  input: { instanceId: provider.instanceId, flowId: auth.flowId! },
                }),
              )
            }
          >
            Cancel sign-in
          </Button>
        ) : null}
        {!active && provider.auth.status === "authenticated" ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={readOnly || pending}
            onClick={() => void run(() => logout(target))}
          >
            Sign out
          </Button>
        ) : null}
      </div>
      {active && provider.driver === "claudeAgent" && auth?.flowId ? (
        <div className="flex flex-wrap gap-2">
          <Input
            size="sm"
            aria-label="Claude authorization code"
            placeholder="Authorization code (if supplied)"
            value={code}
            disabled={readOnly || pending}
            onChange={(event) => setCode(event.target.value)}
          />
          <Button
            size="xs"
            variant="outline"
            disabled={readOnly || pending || !code.trim()}
            onClick={() =>
              void run(() =>
                complete({
                  environmentId,
                  input: {
                    instanceId: provider.instanceId,
                    flowId: auth.flowId!,
                    callbackUrl: code.trim(),
                  },
                }),
              )
            }
          >
            Submit code
          </Button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Environment-local accounts, their failover order, and the native orchestrator selection. */
export function SubscriptionSettings({
  environmentId,
  providers,
  readOnly,
}: {
  environmentId: EnvironmentId;
  providers: ReadonlyArray<ServerProvider>;
  readOnly: boolean;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [name, setName] = useState("");
  const [primaryId, setPrimaryId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const accounts = providers.filter(
    (provider) => provider.driver === "codex" || provider.driver === "claudeAgent",
  );
  const accountItems = accounts.map((provider) => ({
    value: provider.instanceId,
    label: `${provider.displayName ?? provider.driver} (${provider.driver === "codex" ? "Codex" : "Claude"})`,
  }));
  const selection = settings.orchestratorModelSelection;
  const orchestrator = accounts.find((provider) => provider.instanceId === selection?.instanceId);
  const primary = accounts.find((provider) => provider.instanceId === primaryId) ?? accounts[0];
  const label = (id: ProviderInstanceId) =>
    accounts.find((provider) => provider.instanceId === id)?.displayName ?? id;
  async function save(patch: ServerSettingsPatch) {
    if (saving || readOnly) return false;
    setSaving(true);
    setError(null);
    try {
      const result = await update({ environmentId, input: { patch } });
      if (result._tag === "Failure") {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : "Could not save account settings.");
        return false;
      }
      return true;
    } catch {
      setError("Could not save account settings.");
      return false;
    } finally {
      setSaving(false);
    }
  }
  const disabled = readOnly || saving;
  return (
    <>
      <SettingsSection title="Subscription orchestrator">
        <SettingsRow
          title="Orchestrator account"
          description="This subscription runs the orchestrator and coordinates workers in the project."
          control={
            <AccountSelect
              label="Orchestrator account"
              value={selection?.instanceId ?? "off"}
              disabled={disabled}
              items={[{ value: "off", label: "Off" }, ...accountItems]}
              onChange={(id) => {
                const provider = accounts.find((account) => account.instanceId === id);
                if (id === "off") {
                  void save({ orchestratorModelSelection: null });
                  return;
                }
                const model =
                  provider?.models.find((entry) => entry.isDefault) ?? provider?.models[0];
                if (!provider || !model) {
                  setError("Sign in to this account and refresh its models first.");
                  return;
                }
                void save({
                  orchestratorModelSelection: {
                    instanceId: provider.instanceId,
                    model: model.slug,
                  },
                });
              }}
            />
          }
        />
        {selection ? (
          <SettingsRow
            title="Orchestrator model"
            description="Models come from the selected account. New orchestrator tasks use this exact model."
            control={
              <AccountSelect
                label="Orchestrator model"
                value={selection.model}
                disabled={disabled}
                items={
                  orchestrator?.models.map((model) => ({ value: model.slug, label: model.name })) ??
                  []
                }
                onChange={(model) =>
                  void save({ orchestratorModelSelection: { ...selection, model } })
                }
              />
            }
          >
            <Button
              size="xs"
              variant="outline"
              disabled={disabled}
              onClick={() => void save({ defaultModelSelection: selection })}
            >
              Use for new tasks by default
            </Button>
          </SettingsRow>
        ) : null}
      </SettingsSection>
      <SettingsSection title="Subscription accounts">
        <SettingsRow
          title="Add subscription"
          description="Give each login a distinct name. The new account is added after this main account's existing substitutes."
        >
          <div className="flex flex-wrap items-center gap-2">
            <AccountSelect
              label="Main account"
              value={primary?.instanceId ?? null}
              items={accountItems}
              disabled={disabled}
              onChange={setPrimaryId}
            />
            <Input
              size="sm"
              aria-label="New subscription name"
              placeholder="e.g. Codex Personal, Codex Backup"
              value={name}
              disabled={disabled}
              onChange={(event) => setName(event.target.value)}
            />
            <Button
              size="xs"
              variant="outline"
              disabled={disabled || !primary || !name.trim()}
              onClick={() => {
                if (!primary || (primary.driver !== "codex" && primary.driver !== "claudeAgent"))
                  return;
                try {
                  if (
                    accounts.some(
                      (account) =>
                        (account.displayName ?? account.driver).toLowerCase() ===
                        name.trim().toLowerCase(),
                    )
                  ) {
                    setError("Choose a distinct account name.");
                    return;
                  }
                  const continuationPrefix =
                    primary.driver === "codex" ? "codex:home:" : "claude:sessions:";
                  const continuationKey = primary.continuation?.groupKey;
                  const patch = createSubscriptionAccountPatch(settings, {
                    driver: primary.driver === "codex" ? "codex" : "claudeAgent",
                    primaryId: primary.instanceId,
                    name,
                    instanceId: ProviderInstanceId.make(`${primary.driver}_${randomUUID()}`),
                    ...(continuationKey?.startsWith(continuationPrefix)
                      ? { sharedHistoryPath: continuationKey.slice(continuationPrefix.length) }
                      : {}),
                  });
                  void save(patch).then((saved) => {
                    if (saved) setName("");
                  });
                } catch (cause) {
                  setError(cause instanceof Error ? cause.message : "Could not add account.");
                }
              }}
            >
              Add subscription
            </Button>
          </div>
        </SettingsRow>
        {accounts.map((account) => {
          const chain = providerAccountChain(settings, account.instanceId);
          const index = chain.indexOf(account.instanceId);
          const role =
            chain.length > 1
              ? index === 0
                ? "Main account"
                : `Substitute ${index} for ${label(chain[0]!)}`
              : "Independent account";
          return (
            <SettingsRow
              key={account.instanceId}
              title={account.displayName ?? account.driver}
              description={role}
            >
              <SubscriptionSignIn
                environmentId={environmentId}
                provider={account}
                readOnly={readOnly}
              />
              {index > 0 ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={disabled}
                    onClick={() => {
                      const next = { ...settings.providerAccountFallbacks };
                      delete next[chain[0]!];
                      next[account.instanceId] = chain.filter((id) => id !== account.instanceId);
                      void save({ providerAccountFallbacks: next });
                    }}
                  >
                    Make main account
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={disabled || index === 1}
                    onClick={() => {
                      const next = chain.slice(1);
                      [next[index - 2], next[index - 1]] = [next[index - 1]!, next[index - 2]!];
                      void save({
                        providerAccountFallbacks: {
                          ...settings.providerAccountFallbacks,
                          [chain[0]!]: next,
                        },
                      });
                    }}
                  >
                    Move earlier
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={disabled || index === chain.length - 1}
                    onClick={() => {
                      const next = chain.slice(1);
                      [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
                      void save({
                        providerAccountFallbacks: {
                          ...settings.providerAccountFallbacks,
                          [chain[0]!]: next,
                        },
                      });
                    }}
                  >
                    Move later
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={disabled}
                    onClick={() =>
                      void save({
                        providerAccountFallbacks: {
                          ...settings.providerAccountFallbacks,
                          [chain[0]!]: chain.slice(1).filter((id) => id !== account.instanceId),
                        },
                      })
                    }
                  >
                    Remove from substitutes
                  </Button>
                </div>
              ) : null}
              {index === 0 && chain.length > 1 ? (
                <p className="text-xs text-muted-foreground">{chain.map(label).join(" → ")}</p>
              ) : null}
              {index === 0 ? (
                <AccountSelect
                  label={`Add substitute for ${label(account.instanceId)}`}
                  value={null}
                  disabled={disabled}
                  items={accounts
                    .filter(
                      (candidate) =>
                        candidate.driver === account.driver &&
                        candidate.instanceId !== account.instanceId &&
                        candidate.continuation?.groupKey === account.continuation?.groupKey &&
                        providerAccountChain(settings, candidate.instanceId).length === 1,
                    )
                    .map((candidate) => ({
                      value: candidate.instanceId,
                      label: candidate.displayName ?? candidate.instanceId,
                    }))}
                  onChange={(id) =>
                    void save({
                      providerAccountFallbacks: {
                        ...settings.providerAccountFallbacks,
                        [account.instanceId]: [...chain.slice(1), ProviderInstanceId.make(id)],
                      },
                    })
                  }
                />
              ) : null}
            </SettingsRow>
          );
        })}
        <SettingsRow
          title="Automatic continuation"
          description="On a confirmed usage limit, the server tries substitutes in order with the same model and saved conversation. Other errors do not switch accounts. Configure separate account chains for Codex and Claude."
        />
        {error ? (
          <p role="alert" className="p-3 text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </SettingsSection>
    </>
  );
}
