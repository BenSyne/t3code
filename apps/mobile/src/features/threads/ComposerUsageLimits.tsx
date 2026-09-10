import type {
  EnvironmentId,
  ModelSelection,
  ServerConfig,
  ThreadOrchestration,
  UsageLimitsReport,
} from "@t3tools/contracts";
import {
  collectThreadUsageLimits,
  formatDuration,
  formatResetsIn,
} from "@t3tools/shared/usageLimits";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import { useEffect, useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { AccountLimits, ResetCredits } from "../usage/UsageLimitsSection";
import { useProviderColors } from "../usage/usageProviders";
import { ComposerInlineControl } from "../../components/ComposerToolbar";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

const DRIVER_LABEL: Partial<Record<string, string>> = { codex: "Codex", claudeAgent: "Claude" };

/** The thread's selected models and backups share the same account quotas as the web composer. */
export function ThreadUsageLimits({
  environmentId,
  selection,
  orchestration,
  config,
}: {
  environmentId: EnvironmentId | null;
  selection: ModelSelection | null;
  orchestration: ThreadOrchestration;
  config: ServerConfig | null;
}) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const colors = useProviderColors();
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const accounts = useMemo(
    () =>
      selection && config
        ? collectThreadUsageLimits(selection, orchestration, config.settings, config.providers)
        : [],
    [selection, orchestration, config],
  );
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [open]);
  const refresh = async () => {
    if (!environmentId) return;
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
    <>
      <ComposerInlineControl
        accessibilityLabel="Thread usage"
        label="Usage"
        disabled={!selection || !config}
        onPress={() => {
          setNow(Date.now());
          setOpen(true);
        }}
      />
      <Modal
        visible={open}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setOpen(false)}
      >
        <SafeAreaView className="flex-1 bg-background">
          <View className="flex-row items-center justify-between px-5 py-3">
            <Text className="text-lg text-foreground font-t3-bold">Thread usage</Text>
            <Pressable accessibilityRole="button" onPress={() => setOpen(false)} className="p-3">
              <Text className="text-foreground">Done</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={{ padding: 20, gap: 16 }}>
            <Text className="text-xs text-foreground-muted">
              Subscription usage across all conversations. Shared account limits appear once for its
              selected models.
            </Text>
            <Pressable
              accessibilityRole="button"
              disabled={refreshing || !environmentId}
              onPress={() => void refresh()}
              className="self-start py-2"
            >
              <Text className="text-foreground">{refreshing ? "Refreshing…" : "Refresh"}</Text>
            </Pressable>
            {accounts.map((account) => {
              const name = account.provider
                ? resolveProviderInstanceDisplayName(account.provider)
                : account.instanceId;
              const color =
                account.provider?.driver === "codex"
                  ? colors.codex
                  : account.provider?.driver === "claudeAgent"
                    ? colors.claude
                    : undefined;
              return (
                <View key={account.instanceId} className="gap-3 border-t border-border-subtle pt-3">
                  <Text className="text-foreground font-t3-bold">{name}</Text>
                  {account.provider?.auth.label && (
                    <Text className="text-xs text-foreground-muted">
                      {account.provider.auth.label}
                    </Text>
                  )}
                  {account.models.map((model) => (
                    <View
                      key={model.model}
                      className="flex-row flex-wrap justify-between gap-x-3 gap-y-1"
                    >
                      <Text className="shrink text-sm text-foreground">{model.name}</Text>
                      <Text className="text-xs text-foreground-muted">
                        {model.roles.join(" · ")}
                      </Text>
                    </View>
                  ))}
                  {account.notice && (
                    <Text className="text-xs text-foreground-muted">{account.notice}</Text>
                  )}
                  {account.windows.map((window) => {
                    const percent = Math.round(window.usedPercent * 10) / 10;
                    const resets = formatResetsIn(window, now);
                    return (
                      <View key={window.id} className="gap-2">
                        <View className="flex-row flex-wrap justify-between gap-x-3 gap-y-1">
                          <Text className="text-sm text-foreground">{window.label}</Text>
                          <Text className="text-xs text-foreground-muted">
                            {resets}
                            {resets ? " · " : ""}
                            {percent}% used
                          </Text>
                        </View>
                        <View
                          accessibilityRole="progressbar"
                          accessibilityLabel={`${name} · ${window.label}`}
                          accessibilityValue={{
                            min: 0,
                            max: 100,
                            now: percent,
                            text: `${percent}% used${resets ? `, ${resets}` : ""}`,
                          }}
                          className="h-1.5 overflow-hidden rounded-full bg-border-subtle"
                        >
                          <View
                            className="h-full rounded-full bg-foreground"
                            style={{
                              width: `${window.usedPercent}%`,
                              ...(color ? { backgroundColor: color } : {}),
                            }}
                          />
                        </View>
                      </View>
                    );
                  })}
                  {account.checkedAt && (
                    <Text className="text-xs text-foreground-muted">
                      Last reported{" "}
                      {formatDuration(Math.max(0, now - Date.parse(account.checkedAt)))} ago
                    </Text>
                  )}
                </View>
              );
            })}
            {refreshFailed && (
              <Text accessibilityRole="alert" className="text-sm text-foreground">
                Some accounts could not refresh. Showing their last reported usage.
              </Text>
            )}
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </>
  );
}

/**
 * The /usage-limits result, docked above the composer. It is the Usage → Limits
 * card one size down, so the two read as the same thing. The surface is opaque
 * because nothing blurs the feed behind it.
 */
export function ComposerUsageLimits({
  report,
  environmentId,
  onClose,
}: {
  readonly report: UsageLimitsReport;
  readonly environmentId: EnvironmentId;
  readonly onClose: () => void;
}) {
  const now = Date.parse(report.createdAt);
  const { height } = useWindowDimensions();
  const close = (
    <Pressable
      accessibilityLabel="Dismiss usage limits"
      accessibilityRole="button"
      hitSlop={12}
      onPress={onClose}
      className="-me-1 p-1 active:opacity-60"
    >
      <SymbolView name="xmark" size={14} tintColorClassName="accent-icon-muted" type="monochrome" />
    </Pressable>
  );
  return (
    <View className="overflow-hidden rounded-[20px] border-continuous bg-card">
      <ScrollView
        bounces={false}
        showsVerticalScrollIndicator={false}
        style={{ maxHeight: Math.round(height * 0.4) }}
      >
        {report.accounts.map((account, index) => {
          const resetCreditInput =
            account.resetCreditInput ??
            (account.instanceId ? { instanceId: account.instanceId } : undefined);
          const driverLabel = DRIVER_LABEL[account.driver] ?? String(account.driver);
          return (
            <AccountLimits
              key={account.id}
              dense
              first={index === 0}
              driver={account.driver}
              label={driverLabel}
              // Siblings need telling apart: a custom instance without a name shows its
              // id, and a pooled account shows its hub and account id.
              instanceLabel={
                account.instanceId
                  ? account.displayName?.trim() ||
                    (String(account.instanceId) !== String(account.driver)
                      ? account.instanceId
                      : driverLabel)
                  : account.label
              }
              detail={account.plan}
              limits={account.limits}
              now={now}
              trailing={index === 0 ? close : undefined}
              footer={
                resetCreditInput && account.limits.resetCredits ? (
                  <ResetCredits
                    dense
                    environmentId={environmentId}
                    input={resetCreditInput}
                    credits={account.limits.resetCredits}
                    now={now}
                  />
                ) : undefined
              }
            />
          );
        })}
        {report.accounts.length === 0 ? (
          // Nothing but notices, so the close control needs a row of its own.
          <View className="flex-row items-center gap-3 px-4 pt-3">
            <Text className="min-w-0 flex-1 text-base text-foreground">Usage limits</Text>
            {close}
          </View>
        ) : null}
        {report.notices.map((notice) => (
          <Text
            key={notice}
            className={
              report.accounts.length === 0
                ? "px-4 py-3 text-xs text-foreground-muted"
                : "border-t border-border-subtle px-4 py-3 text-xs text-foreground-muted"
            }
          >
            {notice}
          </Text>
        ))}
      </ScrollView>
    </View>
  );
}
