import type { ModelSelection, ServerConfig, ThreadOrchestration } from "@t3tools/contracts";
import { useState } from "react";
import {
  getSubscriptionFallbackIssue,
  providerAccountChain,
  resolveThreadWorkerModels,
} from "@t3tools/shared/serverSettings";
import { Modal, Pressable, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { AppText as Text } from "../../components/AppText";
import { ComposerInlineControl } from "../../components/ComposerToolbar";

export function ThreadWorkingAccounts({
  value,
  onChange,
  config,
  selection,
  disabled,
}: {
  value: ThreadOrchestration;
  onChange: (value: ThreadOrchestration) => void;
  config: ServerConfig | null;
  selection: ModelSelection | null;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const providers = config?.providers ?? [];
  const selected = providers.find((provider) => provider.instanceId === selection?.instanceId);
  const workers = resolveThreadWorkerModels(value, providers);
  const sources =
    value.mode === "delegated"
      ? [
          ...new Set([
            ...(selection ? [selection.instanceId] : []),
            ...workers.map((worker) => worker.instanceId),
          ]),
        ]
      : selection
        ? [selection.instanceId]
        : [];
  const backups = config
    ? [
        ...new Set(
          sources.flatMap((id) => {
            const chain = providerAccountChain(config.settings, id);
            return chain.slice(chain.indexOf(id) + 1);
          }),
        ),
      ]
    : [];
  const selectedBackups = value.fallbackAccountIds ?? backups;
  const ids = [
    ...new Set([
      ...providers.filter((provider) => provider.enabled).map((provider) => provider.instanceId),
      ...value.workerAccountIds,
    ]),
  ];
  return (
    <>
      <ComposerInlineControl
        accessibilityLabel="Thread models and work mode"
        label={value.mode === "same-account" ? "Usage-only fallback" : `Team · ${workers.length}`}
        onPress={() => setOpen(true)}
      />
      <Modal
        visible={open}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setOpen(false)}
      >
        <SafeAreaView className="flex-1 bg-background">
          <View className="flex-row items-center justify-between px-5 py-3">
            <Text className="text-lg text-foreground font-t3-bold">Thread models</Text>
            <Pressable accessibilityRole="button" onPress={() => setOpen(false)} className="p-3">
              <Text className="text-foreground">Done</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={{ padding: 20, gap: 16 }}>
            {(["same-account", "delegated"] as const).map((mode) => (
              <Pressable
                key={mode}
                accessibilityRole="radio"
                accessibilityState={{ checked: value.mode === mode, disabled }}
                disabled={disabled}
                onPress={() => onChange({ ...value, mode })}
                className="flex-row gap-3 py-3"
              >
                <Text className="text-foreground">{value.mode === mode ? "●" : "○"}</Text>
                <Text className="text-foreground">
                  {mode === "same-account" ? "Usage-only fallback" : "Parallel team"}
                </Text>
              </Pressable>
            ))}
            <Text className="text-foreground-muted">
              {selected?.displayName ?? selection?.instanceId ?? "Choose a model"} ·{" "}
              {selection?.model}
              {value.mode === "same-account"
                ? " plans and builds. Switch accounts only after a confirmed usage limit, keeping this model and conversation."
                : " orchestrates. Select the models it may assign independent tasks to in parallel. Workers share project files; the orchestrator reviews their work."}
            </Text>
            {value.mode === "delegated" &&
              ids.map((id) => {
                const provider = providers.find((entry) => entry.instanceId === id);
                const selectedModels = workers.filter((worker) => worker.instanceId === id);
                const unavailable =
                  !provider?.enabled ||
                  !provider.installed ||
                  provider.auth.status === "unauthenticated" ||
                  provider.availability === "unavailable";
                const models = [
                  ...(provider?.models ?? []),
                  ...selectedModels
                    .filter(
                      (worker) => !provider?.models.some((model) => model.slug === worker.model),
                    )
                    .map((worker) => ({ slug: worker.model, name: worker.model })),
                ];
                return (
                  <View key={id} className="gap-2">
                    <Text className="text-foreground font-t3-bold">
                      {provider?.displayName ?? id}
                      {unavailable ? " (unavailable)" : ""}
                    </Text>
                    {models.map((model) => {
                      const checked = selectedModels.some((worker) => worker.model === model.slug);
                      return (
                        <Pressable
                          key={model.slug}
                          accessibilityRole="checkbox"
                          accessibilityLabel={`${provider?.displayName ?? id} · ${model.name}`}
                          accessibilityState={{
                            checked,
                            disabled: disabled || (unavailable && !checked),
                          }}
                          disabled={disabled || (unavailable && !checked)}
                          onPress={() => {
                            const next = checked
                              ? workers.filter(
                                  (worker) =>
                                    worker.instanceId !== id || worker.model !== model.slug,
                                )
                              : [...workers, { instanceId: id, model: model.slug }];
                            onChange({
                              ...value,
                              workerModels: next,
                              workerAccountIds: [
                                ...new Set(next.map((worker) => worker.instanceId)),
                              ],
                            });
                          }}
                          className="flex-row gap-3 py-2"
                        >
                          <Text className="text-foreground">{checked ? "☑" : "☐"}</Text>
                          <Text className="text-foreground">{model.name}</Text>
                        </Pressable>
                      );
                    })}
                    {models.length === 0 && (
                      <Text className="text-foreground-muted">No models available.</Text>
                    )}
                  </View>
                );
              })}
            <Text className="text-foreground font-t3-bold">Backups at usage limit</Text>
            <Text className="text-foreground-muted">
              Reserves use the same model in the configured order. Unchecked accounts will not take
              over in this thread.
            </Text>
            {backups.map((id) => {
              const provider = providers.find((entry) => entry.instanceId === id);
              const issue = config
                ? getSubscriptionFallbackIssue(config.settings, providers, id)
                : null;
              const unavailable =
                provider?.auth.status !== "authenticated" ||
                !provider.enabled ||
                !provider.installed ||
                !!issue;
              const checked = selectedBackups.includes(id);
              return (
                <Pressable
                  key={id}
                  accessibilityRole="checkbox"
                  accessibilityLabel={`Allow ${provider?.displayName ?? id} as backup`}
                  accessibilityState={{ checked, disabled }}
                  disabled={disabled}
                  onPress={() =>
                    onChange({
                      ...value,
                      fallbackAccountIds: checked
                        ? selectedBackups.filter((account) => account !== id)
                        : [...selectedBackups, id],
                    })
                  }
                  className="flex-row gap-3 py-2"
                >
                  <Text className="text-foreground">{checked ? "☑" : "☐"}</Text>
                  <Text className="text-foreground">
                    {provider?.displayName ?? id}
                    {unavailable ? " (unavailable)" : ""}
                  </Text>
                </Pressable>
              );
            })}
            {backups.length === 0 && (
              <Text className="text-foreground-muted">
                No substitutes configured. Add subscriptions in provider settings.
              </Text>
            )}
            {disabled && (
              <Text className="text-foreground-muted">
                Wait for the current turn or save to finish and check your connection before
                changing accounts.
              </Text>
            )}
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </>
  );
}
