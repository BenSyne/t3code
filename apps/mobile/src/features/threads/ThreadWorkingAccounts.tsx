import type { ModelSelection, ServerConfig, ThreadOrchestration } from "@t3tools/contracts";
import { useState } from "react";
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
  const ids = [
    ...new Set([...providers.map((provider) => provider.instanceId), ...value.workerAccountIds]),
  ];
  return (
    <>
      <ComposerInlineControl
        accessibilityLabel="Working accounts"
        label={
          value.mode === "same-account"
            ? "Same account"
            : `Workers · ${value.workerAccountIds.length}`
        }
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
            <Text className="text-lg text-foreground font-t3-bold">Working accounts</Text>
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
                  {mode === "same-account" ? "Same account and model" : "Separate worker accounts"}
                </Text>
              </Pressable>
            ))}
            <Text className="text-foreground-muted">
              {selected?.displayName ?? selection?.instanceId ?? "Choose a model"} ·{" "}
              {selection?.model}
              {value.mode === "same-account"
                ? " plans and builds in this thread. The account changes automatically only after a usage limit for this model."
                : " orchestrates. Select accounts it can assign development work to."}
            </Text>
            {value.mode === "delegated" &&
              ids.map((id) => {
                const provider = providers.find((entry) => entry.instanceId === id);
                const checked = value.workerAccountIds.includes(id);
                const unavailable =
                  !provider?.enabled ||
                  !provider.installed ||
                  provider.auth.status === "unauthenticated" ||
                  provider.availability === "unavailable";
                return (
                  <Pressable
                    key={id}
                    accessibilityRole="checkbox"
                    accessibilityState={{
                      checked,
                      disabled: disabled || (unavailable && !checked),
                    }}
                    disabled={disabled || (unavailable && !checked)}
                    onPress={() =>
                      onChange({
                        ...value,
                        workerAccountIds: checked
                          ? value.workerAccountIds.filter((account) => account !== id)
                          : [...value.workerAccountIds, id],
                      })
                    }
                    className="flex-row gap-3 py-3"
                  >
                    <Text className="text-foreground">{checked ? "☑" : "☐"}</Text>
                    <Text className="text-foreground">
                      {provider?.displayName ?? id}
                      {unavailable ? " (unavailable)" : ""}
                    </Text>
                  </Pressable>
                );
              })}
            <Text className="text-foreground-muted">
              Applies to this thread. Each account uses its configured substitutes only after a
              usage limit. Manage subscriptions and fallback order in provider settings.
            </Text>
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
