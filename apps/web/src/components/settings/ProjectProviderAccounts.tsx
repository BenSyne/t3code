import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import {
  PROVIDER_DISPLAY_NAMES,
  type EnvironmentId,
  type ProjectId,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment, EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function ProjectProviderAccounts({
  environmentId,
  projectId,
  label,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  label: string;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const updateSettings = useAtomCommand(
    serverEnvironment.updateSettings,
    "project provider accounts",
  );
  const [saving, setSaving] = useState(false);
  const accounts = settings.projectProviderAccounts[projectId];
  const save = async (next: ReadonlyArray<ProviderInstanceId> | null) => {
    setSaving(true);
    try {
      await updateSettings({
        environmentId,
        input: { patch: { projectProviderAccounts: { [projectId]: next } } },
      });
    } finally {
      setSaving(false);
    }
  };
  return (
    <SettingsSection title="Provider accounts">
      <SettingsRow
        title={label}
        description="Applies to tasks, orchestrator workers, and substitute accounts. Changes apply to the next turn; existing history is kept."
      />
      <SettingsRow
        title="Allow all accounts"
        description="Includes accounts you add later."
        control={
          <Switch
            aria-label={`Allow all accounts in ${label}`}
            checked={accounts == null}
            disabled={saving}
            onCheckedChange={(checked) =>
              void save(
                checked
                  ? null
                  : providers
                      .filter((provider) => provider.enabled)
                      .map((provider) => provider.instanceId),
              )
            }
          />
        }
      />
      {accounts != null && (
        <>
          {providers.map((provider) => (
            <SettingsRow
              key={provider.instanceId}
              title={resolveProviderInstanceDisplayName(provider)}
              description={
                provider.enabled
                  ? PROVIDER_DISPLAY_NAMES[provider.driver]
                  : "Disabled in provider settings"
              }
              control={
                <Switch
                  aria-label={`Allow ${resolveProviderInstanceDisplayName(provider)} in ${label}`}
                  checked={accounts.includes(provider.instanceId)}
                  disabled={saving}
                  onCheckedChange={(checked) =>
                    void save(
                      checked
                        ? [...accounts, provider.instanceId]
                        : accounts.filter((id) => id !== provider.instanceId),
                    )
                  }
                />
              }
            />
          ))}
          {accounts.length === 0 && (
            <SettingsRow
              title="No accounts allowed"
              description="Select at least one account before starting or continuing tasks in this project."
            />
          )}
        </>
      )}
    </SettingsSection>
  );
}
