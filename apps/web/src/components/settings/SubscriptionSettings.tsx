import { useId, useState, type ReactNode } from "react";
import { Field } from "@base-ui/react/field";
import { CheckIcon, ExternalLinkIcon, InfoIcon, MoreHorizontalIcon, PlusIcon } from "lucide-react";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type EnvironmentId,
  type ServerProvider,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import {
  createSubscriptionAccountPatch,
  getSubscriptionFallbackIssue,
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
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Menu, MenuGroup, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import {
  Select,
  SelectGroup,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsSection } from "./settingsLayout";

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

function CodexSignInHelp() {
  const [open, setOpen] = useState(false);
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger
        delay={200}
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label="Codex sign-in help"
            onClick={() => setOpen(true)}
          >
            <InfoIcon />
          </Button>
        }
      />
      <TooltipPopup className="max-w-80" side="top">
        <div className="flex flex-col gap-2 py-2">
          <p className="font-medium">Enable device-code sign-in</p>
          <ol className="flex list-decimal flex-col gap-2 pl-4">
            <li>
              Open ChatGPT with the account you want to add. Go to Settings → Security and enable
              device code authorization for Codex.
            </li>
            <li>
              If sign-in is already open, cancel it in T3 and select Sign in again to get a fresh
              code.
            </li>
            <li>
              Open the sign-in page, check that the correct account is selected, and enter the code
              shown in T3.
            </li>
          </ol>
          <p>No terminal commands needed.</p>
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

function SubscriptionAccountRow({
  environmentId,
  provider,
  role,
  readOnly,
  menuItems,
  fallbackIssue,
  children,
}: {
  environmentId: EnvironmentId;
  provider: ServerProvider;
  role: string;
  readOnly: boolean;
  menuItems?: ReactNode;
  fallbackIssue: ReturnType<typeof getSubscriptionFallbackIssue>;
  children?: ReactNode;
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
  const signedIn = provider.auth.status === "authenticated";
  const disabled = readOnly || pending || active;
  const accountName = provider.displayName ?? provider.driver;
  const status = active
    ? "Signing in…"
    : !provider.enabled
      ? "Disabled"
      : !provider.installed
        ? "CLI not installed"
        : fallbackIssue
          ? fallbackIssue.kind === "duplicate"
            ? "Duplicate subscription"
            : "Identity not verified"
          : signedIn
            ? "Signed in"
            : provider.auth.status === "unknown"
              ? "Not checked"
              : "Not signed in";
  const detail = !provider.enabled
    ? "Enable this account in provider settings to use it."
    : !provider.installed
      ? "Install this provider's CLI to sign in."
      : signedIn
        ? provider.auth.label
        : "Connect this subscription to make it available.";

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
    <li aria-label={accountName} className="flex flex-col gap-3 px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="break-words text-sm font-medium">{accountName}</h3>
            <Badge variant="secondary" size="sm">
              {role}
            </Badge>
          </div>
          {detail && detail !== "Signed in" ? (
            <p className="text-xs text-muted-foreground">{detail}</p>
          ) : null}
          {provider.auth.email ? (
            <p className="break-all text-xs text-muted-foreground">{provider.auth.email}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            variant={
              fallbackIssue
                ? "warning"
                : status === "Signed in"
                  ? "success"
                  : status === "Not signed in"
                    ? "warning"
                    : "outline"
            }
          >
            {status === "Signed in" ? <CheckIcon /> : null}
            {status}
          </Badge>
          {(!signedIn || fallbackIssue) && !active ? (
            <div className="flex items-center gap-1">
              <Button
                size="xs"
                disabled={disabled || !provider.enabled || !provider.installed}
                onClick={() => {
                  setCode("");
                  void run(() => start(target));
                }}
              >
                {fallbackIssue?.kind === "duplicate" ? "Use different account" : "Sign in"}
              </Button>
              {provider.driver === "codex" ? <CodexSignInHelp /> : null}
            </div>
          ) : null}
          {menuItems || signedIn ? (
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    disabled={disabled}
                    aria-label={`Manage ${accountName}`}
                  >
                    <MoreHorizontalIcon />
                  </Button>
                }
              />
              <MenuPopup align="end">
                {menuItems ? <MenuGroup>{menuItems}</MenuGroup> : null}
                {menuItems && signedIn ? <MenuSeparator /> : null}
                {signedIn ? (
                  <MenuGroup>
                    <MenuItem disabled={disabled} onClick={() => void run(() => logout(target))}>
                      Sign out
                    </MenuItem>
                  </MenuGroup>
                ) : null}
              </MenuPopup>
            </Menu>
          ) : null}
        </div>
      </div>
      {fallbackIssue && !active ? (
        <Alert variant="warning">
          <AlertDescription>{fallbackIssue.message}</AlertDescription>
        </Alert>
      ) : null}
      {active ? (
        <div className="flex flex-col gap-3">
          <p role="status" className="text-sm">
            {auth.message}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {auth.authorizationUrl ? (
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
                <ExternalLinkIcon data-icon="inline-start" />
                Open sign-in page
              </Button>
            ) : null}
            {auth.flowId ? (
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
            {provider.driver === "codex" ? <CodexSignInHelp /> : null}
          </div>
          {provider.driver === "claudeAgent" && auth.flowId ? (
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (!code.trim() || readOnly || pending) return;
                void run(() =>
                  complete({
                    environmentId,
                    input: {
                      instanceId: provider.instanceId,
                      flowId: auth.flowId!,
                      callbackUrl: code.trim(),
                    },
                  }),
                );
              }}
            >
              <Field.Root className="flex min-w-0 flex-1 flex-col gap-1">
                <Field.Label className="text-xs text-muted-foreground">
                  Authorization code (if supplied)
                </Field.Label>
                <Input
                  size="sm"
                  aria-label="Claude authorization code"
                  value={code}
                  disabled={readOnly || pending}
                  onChange={(event) => setCode(event.target.value)}
                />
              </Field.Root>
              <Button
                type="submit"
                size="xs"
                variant="outline"
                disabled={readOnly || pending || !code.trim()}
              >
                Submit code
              </Button>
            </form>
          ) : null}
        </div>
      ) : null}
      {error || (!signedIn && auth?.phase === "failed" && auth.message) ? (
        <Alert variant="error">
          <AlertDescription>{error ?? auth?.message}</AlertDescription>
        </Alert>
      ) : null}
      {children}
    </li>
  );
}

function ProviderSubscriptions({
  environmentId,
  driver,
  accounts,
  allAccounts,
  readOnly,
}: {
  environmentId: EnvironmentId;
  driver: "codex" | "claudeAgent";
  accounts: ReadonlyArray<ServerProvider>;
  allAccounts: ReadonlyArray<ServerProvider>;
  readOnly: boolean;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [primaryId, setPrimaryId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();
  const providerName = driver === "codex" ? "Codex" : "Claude Code";
  const roots = accounts.filter(
    (account) => providerAccountChain(settings, account.instanceId)[0] === account.instanceId,
  );
  const primary = roots.find((account) => account.instanceId === primaryId) ?? roots[0];
  // A substitute can arrive before its main account in the provider catalog.
  const orderedIds = [
    ...new Set(accounts.flatMap((account) => providerAccountChain(settings, account.instanceId))),
  ];
  const orderedAccounts = orderedIds.flatMap(
    (id) => accounts.find((account) => account.instanceId === id) ?? [],
  );
  const connectedCount = accounts.filter(
    (account) =>
      account.enabled &&
      account.installed &&
      account.auth.status === "authenticated" &&
      !getSubscriptionFallbackIssue(settings, accounts, account.instanceId),
  ).length;
  const label = (id: ProviderInstanceId) =>
    accounts.find((account) => account.instanceId === id)?.displayName ?? id;
  const disabled = readOnly || saving;

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

  async function addSubscription() {
    if (!primary || disabled || !name.trim()) return;
    try {
      if (
        allAccounts.some(
          (account) =>
            (account.displayName ?? account.driver).toLowerCase() === name.trim().toLowerCase(),
        )
      ) {
        setError("Choose a distinct account name.");
        return;
      }
      const continuationPrefix = driver === "codex" ? "codex:home:" : "claude:sessions:";
      const continuationKey = primary.continuation?.groupKey;
      const patch = createSubscriptionAccountPatch(settings, {
        driver,
        primaryId: primary.instanceId,
        name,
        instanceId: ProviderInstanceId.make(`${driver}_${randomUUID()}`),
        ...(continuationKey?.startsWith(continuationPrefix)
          ? { sharedHistoryPath: continuationKey.slice(continuationPrefix.length) }
          : {}),
      });
      if (await save(patch)) {
        setAdding(false);
        setName("");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not add account.");
    }
  }

  return (
    <>
      <SettingsSection
        title={providerName}
        aria-label={`${providerName} subscription accounts`}
        icon={
          <ProviderInstanceIcon
            driverKind={ProviderDriverKind.make(driver)}
            displayName={providerName}
          />
        }
        headerAction={
          <Button
            size="xs"
            variant="outline"
            disabled={disabled || !primary}
            onClick={() => {
              setError(null);
              setAdding(true);
            }}
          >
            <PlusIcon data-icon="inline-start" />
            Add {driver === "codex" ? "Codex" : "Claude"} subscription
          </Button>
        }
      >
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-5">
          <p className="text-xs text-muted-foreground">
            {connectedCount} of {accounts.length} accounts ready
          </p>
          <span className="text-xs text-muted-foreground">
            Main account first · substitutes in order
          </span>
        </div>
        <ol aria-label={`${providerName} account order`} className="divide-y divide-border/50">
          {orderedAccounts.map((account) => {
            const chain = providerAccountChain(settings, account.instanceId);
            const index = chain.indexOf(account.instanceId);
            const candidates =
              index === 0
                ? accounts.filter(
                    (candidate) =>
                      candidate.instanceId !== account.instanceId &&
                      candidate.continuation?.groupKey !== undefined &&
                      candidate.continuation.groupKey === account.continuation?.groupKey &&
                      providerAccountChain(settings, candidate.instanceId).length === 1,
                  )
                : [];
            return (
              <SubscriptionAccountRow
                key={account.instanceId}
                environmentId={environmentId}
                provider={account}
                role={index > 0 ? `Substitute ${index}` : "Main account"}
                readOnly={disabled}
                fallbackIssue={getSubscriptionFallbackIssue(settings, accounts, account.instanceId)}
                menuItems={
                  index > 0 ? (
                    <>
                      <MenuItem
                        onClick={() => {
                          const next = { ...settings.providerAccountFallbacks };
                          delete next[chain[0]!];
                          next[account.instanceId] = chain.filter(
                            (id) => id !== account.instanceId,
                          );
                          void save({ providerAccountFallbacks: next });
                        }}
                      >
                        Make main account
                      </MenuItem>
                      <MenuItem
                        disabled={index === 1}
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
                      </MenuItem>
                      <MenuItem
                        disabled={index === chain.length - 1}
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
                      </MenuItem>
                      <MenuItem
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
                      </MenuItem>
                    </>
                  ) : undefined
                }
              >
                {index > 0 && roots.length > 1 ? (
                  <p className="text-xs text-muted-foreground">Substitute for {label(chain[0]!)}</p>
                ) : null}
                {candidates.length > 0 ? (
                  <div className="max-w-sm">
                    <AccountSelect
                      label={`Add existing substitute for ${label(account.instanceId)}`}
                      value={null}
                      disabled={disabled}
                      items={candidates.map((candidate) => ({
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
                  </div>
                ) : null}
              </SubscriptionAccountRow>
            );
          })}
        </ol>
        {!adding && error ? (
          <div className="p-4">
            <Alert variant="error">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          </div>
        ) : null}
      </SettingsSection>
      <Dialog
        open={adding}
        onOpenChange={(open) => {
          if (!saving) {
            setAdding(open);
            setError(null);
          }
        }}
      >
        <DialogPopup showCloseButton={!saving}>
          <DialogHeader>
            <DialogTitle>Add {driver === "codex" ? "Codex" : "Claude"} subscription</DialogTitle>
            <DialogDescription>
              Give the account a name, then sign in with its subscription. T3 keeps each login
              separate.
            </DialogDescription>
          </DialogHeader>
          <form
            className="contents"
            onSubmit={(event) => {
              event.preventDefault();
              void addSubscription();
            }}
          >
            <DialogPanel>
              <div className="flex flex-col gap-4">
                <Field.Root className="flex flex-col gap-2" disabled={disabled}>
                  <Field.Label htmlFor={nameId} className="text-sm font-medium">
                    Account name
                  </Field.Label>
                  <Input
                    id={nameId}
                    autoFocus
                    value={name}
                    placeholder={driver === "codex" ? "e.g. Codex Personal" : "e.g. Claude Work"}
                    disabled={disabled}
                    onChange={(event) => {
                      setName(event.target.value);
                      setError(null);
                    }}
                  />
                </Field.Root>
                {roots.length > 1 ? (
                  <Field.Root className="flex flex-col gap-2">
                    <Field.Label className="text-sm font-medium">Main account</Field.Label>
                    <AccountSelect
                      label="Main account"
                      value={primary?.instanceId ?? null}
                      items={roots.map((account) => ({
                        value: account.instanceId,
                        label: account.displayName ?? account.instanceId,
                      }))}
                      disabled={disabled}
                      onChange={setPrimaryId}
                    />
                  </Field.Root>
                ) : null}
                {primary ? (
                  <p className="text-xs text-muted-foreground">
                    Added as the next substitute for <strong>{label(primary.instanceId)}</strong>.
                    It takes over only when an earlier account reaches its usage limit.
                  </p>
                ) : null}
                {error ? (
                  <Alert variant="error">
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                ) : null}
              </div>
            </DialogPanel>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={saving}
                onClick={() => {
                  setAdding(false);
                  setError(null);
                }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={disabled || !primary || !name.trim()}>
                {saving ? "Adding…" : "Add subscription"}
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
    </>
  );
}

/** Named subscription accounts, grouped by provider and ordered by continuation priority. */
export function SubscriptionSettings({
  environmentId,
  providers,
  readOnly,
}: {
  environmentId: EnvironmentId;
  providers: ReadonlyArray<ServerProvider>;
  readOnly: boolean;
}) {
  const accounts = providers.filter(
    (provider) => provider.driver === "codex" || provider.driver === "claudeAgent",
  );
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1 px-3 sm:px-4">
        <h2 className="text-sm font-medium">Subscription accounts</h2>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Connect your subscriptions here, then choose accounts in chat. If an account reaches its
          usage limit, T3 tries its substitutes with the same model and conversation.
        </p>
      </div>
      {(["codex", "claudeAgent"] as const).map((driver) => {
        const providerAccounts = accounts.filter((account) => account.driver === driver);
        return providerAccounts.length > 0 ? (
          <ProviderSubscriptions
            key={driver}
            environmentId={environmentId}
            driver={driver}
            accounts={providerAccounts}
            allAccounts={accounts}
            readOnly={readOnly}
          />
        ) : null;
      })}
    </div>
  );
}
