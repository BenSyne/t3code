import type {
  EnvironmentId,
  ModelSelection,
  ServerProvider,
  ServerSettings,
  ThreadOrchestration,
  UsageLimitsReport,
} from "@t3tools/contracts";
import {
  collectThreadUsageLimits,
  formatDuration,
  formatResetsIn,
  limitsNotice,
} from "@t3tools/shared/usageLimits";
import { GaugeIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { getDriverOption } from "../settings/providerDriverMeta";
import { RedactedSensitiveText } from "../settings/RedactedSensitiveText";
import { barColor, LimitWindows, ResetCredits } from "../usage/UsageLimits";
import { ComposerControl, ComposerControlIcon, type ComposerControlSize } from "./ComposerControl";
import { composerFloatingLayerProps } from "./composerEventScope";
import { ComposerBanner } from "./ComposerBanner";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/** A live view of exactly the models selected for this thread, including its reserve accounts. */
export function ThreadUsageLimits({
  environmentId,
  selection,
  orchestration,
  settings,
  providers,
  size,
}: {
  environmentId: EnvironmentId;
  selection: ModelSelection;
  orchestration: ThreadOrchestration;
  settings: ServerSettings;
  providers: ReadonlyArray<ServerProvider>;
  size: ComposerControlSize;
}) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const accounts = useMemo(
    () =>
      collectThreadUsageLimits(
        { instanceId: selection.instanceId, model: selection.model },
        orchestration,
        settings,
        providers,
      ),
    [selection.instanceId, selection.model, orchestration, settings, providers],
  );
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [open]);
  const refresh = async () => {
    setRefreshing(true);
    setRefreshFailed(false);
    try {
      const results = await Promise.all(
        accounts
          .filter((account) => account.provider?.enabled)
          .map((account) =>
            refreshProviders({ environmentId, input: { instanceId: account.instanceId } }),
          ),
      );
      setRefreshFailed(results.some((result) => result._tag === "Failure"));
    } catch {
      setRefreshFailed(true);
    } finally {
      setNow(Date.now());
      setRefreshing(false);
    }
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setNow(Date.now());
      }}
    >
      <PopoverTrigger render={<ComposerControl size={size} aria-label="Thread usage" />}>
        <ComposerControlIcon icon={GaugeIcon} size={size} />
        Usage
      </PopoverTrigger>
      <PopoverPopup
        {...composerFloatingLayerProps}
        align="start"
        className="w-100 max-w-[calc(100vw-2rem)]"
      >
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-3">
            <PopoverTitle>Thread usage</PopoverTitle>
            <Button size="xs" variant="ghost" disabled={refreshing} onClick={() => void refresh()}>
              {refreshing ? "Refreshing…" : "Refresh"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Subscription usage across all conversations. Shared account limits appear once for its
            selected models.
          </p>
          {accounts.map((account) => {
            const name = account.provider
              ? resolveProviderInstanceDisplayName(account.provider)
              : account.instanceId;
            return (
              <section
                key={account.instanceId}
                aria-label={`${name} usage`}
                className="flex min-w-0 flex-col gap-3 border-t pt-3"
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="text-sm font-medium break-words">{name}</span>
                  {account.provider?.auth.label && (
                    <span className="text-xs text-muted-foreground">
                      {account.provider.auth.label}
                    </span>
                  )}
                  {account.models.map((model) => (
                    <div
                      key={model.model}
                      className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-xs"
                    >
                      <span className="min-w-0 break-words">{model.name}</span>
                      <span className="text-muted-foreground">{model.roles.join(" · ")}</span>
                    </div>
                  ))}
                </div>
                {account.notice && (
                  <p className="text-xs text-muted-foreground">{account.notice}</p>
                )}
                {account.windows.map((window) => {
                  const resets = formatResetsIn(window, now);
                  const percent = Math.round(window.usedPercent * 10) / 10;
                  return (
                    <div key={window.id} className="flex flex-col gap-1.5">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-xs">
                        <span>{window.label}</span>
                        <span className="flex flex-wrap justify-end gap-x-2 tabular-nums">
                          {window.resetsAt && (
                            <Tooltip>
                              <TooltipTrigger
                                render={<span tabIndex={0} className="text-muted-foreground" />}
                              >
                                {resets}
                              </TooltipTrigger>
                              <TooltipPopup>
                                Resets {new Date(window.resetsAt).toLocaleString()}
                              </TooltipPopup>
                            </Tooltip>
                          )}
                          <span className="font-medium">{percent}% used</span>
                        </span>
                      </div>
                      <div
                        role="progressbar"
                        aria-label={`${name} · ${window.label}`}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={percent}
                        aria-valuetext={`${percent}% used${resets ? `, ${resets}` : ""}`}
                        className="h-1.5 overflow-hidden rounded-full bg-muted"
                      >
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${window.usedPercent}%`,
                            backgroundColor: account.provider
                              ? barColor(account.provider.driver)
                              : "var(--primary)",
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
                {account.checkedAt && (
                  <p className="text-xs text-muted-foreground">
                    Last reported {formatDuration(Math.max(0, now - Date.parse(account.checkedAt)))}{" "}
                    ago
                  </p>
                )}
              </section>
            );
          })}
          {refreshFailed && (
            <p role="status" className="text-xs text-destructive">
              Some accounts could not refresh. Showing their last reported usage.
            </p>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

/** Driver name, then the instance when there could be more than one of that driver. */
function accountLabel(account: UsageLimitsReport["accounts"][number]): string {
  if (!account.instanceId) return account.label;
  const driver = getDriverOption(account.driver)?.label ?? String(account.driver);
  const instance =
    account.displayName?.trim() ||
    (String(account.instanceId) !== String(account.driver) ? account.instanceId : "");
  // The default instance is often named after its driver; saying it twice adds nothing.
  return instance && instance.toLowerCase() !== driver.toLowerCase()
    ? `${driver} · ${instance}`
    : driver;
}

function AccountSummary({ account }: { readonly account: UsageLimitsReport["accounts"][number] }) {
  const label = accountLabel(account);
  return (
    <>
      {label.includes("@") ? (
        <RedactedSensitiveText
          key={label}
          value={label}
          ariaLabel="Toggle account label visibility"
          revealTooltip="Click to reveal account"
          hideTooltip="Click to hide account"
          className="max-w-full truncate align-bottom font-sans text-xs leading-normal"
        />
      ) : (
        label
      )}
      {account.plan ? ` · ${account.plan}` : null}
    </>
  );
}

/** The /usage-limits result as a composer notice: it stacks under warnings and dismisses like one. */
export function usageLimitsBannerItem(
  id: string,
  report: UsageLimitsReport,
  environmentId: EnvironmentId,
  onDismiss: () => void,
): ComposerBannerStackItem {
  const [first] = report.accounts;
  const single = report.accounts.length === 1 && first ? first : null;
  const summary = single ? (
    <AccountSummary account={single} />
  ) : (
    `${report.accounts.length} accounts`
  );
  return {
    id,
    variant: "info",
    priority: "notice",
    icon: <GaugeIcon />,
    title: "Usage limits",
    description: summary,
    dismissLabel: "Dismiss usage limits",
    onDismiss,
    children: <UsageLimitsBannerBody report={report} environmentId={environmentId} />,
  };
}

function UsageLimitsBannerBody({
  report,
  environmentId,
}: {
  readonly report: UsageLimitsReport;
  readonly environmentId: EnvironmentId;
}) {
  const now = Date.parse(report.createdAt);
  return (
    <ComposerBanner.Scroll>
      <ComposerBanner.Body className="flex flex-col gap-2 pt-1 pb-1.5 pe-2">
        {report.accounts.map((account) => {
          const resetCreditInput =
            account.resetCreditInput ??
            (account.instanceId ? { instanceId: account.instanceId } : undefined);
          const notice = limitsNotice(account.limits);
          return (
            <div key={account.id} className="flex min-w-0 flex-col gap-1">
              {report.accounts.length > 1 ? (
                <span className="truncate text-xs text-muted-foreground">
                  <AccountSummary account={account} />
                </span>
              ) : null}
              {notice ? (
                <span className="text-xs text-muted-foreground">{notice}</span>
              ) : (
                <LimitWindows
                  compact
                  driver={account.driver}
                  windows={account.limits.windows}
                  now={now}
                />
              )}
              {resetCreditInput && account.limits.resetCredits ? (
                <ResetCredits
                  environmentId={environmentId}
                  input={resetCreditInput}
                  credits={account.limits.resetCredits}
                  now={now}
                />
              ) : null}
            </div>
          );
        })}
        {report.notices.map((notice) => (
          <span key={notice} className="text-xs text-muted-foreground">
            {notice}
          </span>
        ))}
      </ComposerBanner.Body>
    </ComposerBanner.Scroll>
  );
}
