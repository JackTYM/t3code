import { type EnvironmentId, type ModelSelection } from "@t3tools/contracts";
import { createModelSelection, pickModelSelection } from "@t3tools/shared/model";
import { T, useGT } from "gt-react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import {
  getTextGenerationModelOptionsByInstance,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import { useEnvironmentProviders } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { useTextGenerationTargets } from "../../textGenerators";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { Switch } from "../ui/switch";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME, SettingsRow } from "./settingsLayout";

/** The model that reviews Bot scripts before they run; off follows the text generation model. */
export function BotReviewerModelRow({
  environmentId,
  disabled,
}: {
  readonly environmentId: EnvironmentId;
  readonly disabled: boolean;
}) {
  const gt = useGT();
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const providers = (useEnvironmentProviders().get(environmentId) ?? EMPTY_SERVER_PROVIDERS).filter(
    (provider) => provider.supportsTextGeneration !== false,
  );
  const targets = useTextGenerationTargets({
    environmentId,
    settings,
    providers,
    projectId: null,
    selections: [settings.botReviewerModelSelection, settings.textGenerationModelSelection],
  });
  const dedicated = settings.botReviewerModelSelection !== null;
  const selection = resolveAppModelSelectionState(
    {
      ...settings,
      textGenerationModelSelection:
        settings.botReviewerModelSelection ?? settings.textGenerationModelSelection,
    },
    targets.providers,
  );
  const instanceEntry = targets.entries.find((entry) => entry.instanceId === selection.instanceId);
  const modelOptionsByInstance = getTextGenerationModelOptionsByInstance(
    settings,
    targets.providers,
    selection.instanceId,
    selection.model,
  );
  const hasProvider = targets.entries.some((entry) => entry.enabled && entry.isAvailable);
  const setModel = (next: ModelSelection) => updateSettings({ botReviewerModelSelection: next });

  return (
    <SettingsRow
      settingKeys={["botReviewerModelSelection"]}
      title={gt("Script reviewer model")}
      description={gt(
        "The model that reads each script a Bot writes before it runs. When off, it uses the text generation model.",
      )}
      control={
        <div className="flex min-w-0 flex-wrap items-center gap-2 @min-[32rem]/settings-row:justify-end">
          {dedicated && (!hasProvider || !instanceEntry) ? (
            <span className="text-sm text-muted-foreground">
              <T>No text generation providers available.</T>
            </span>
          ) : null}
          {dedicated && hasProvider && instanceEntry ? (
            <>
              <ProviderModelPicker
                environmentId={environmentId}
                disabled={disabled}
                activeInstanceId={selection.instanceId}
                model={selection.model}
                lockedProvider={null}
                instanceEntries={targets.entries}
                modelOptionsByInstance={modelOptionsByInstance}
                triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                onInstanceModelChange={(instanceId, model) =>
                  setModel(pickModelSelection(selection, instanceId, model))
                }
              />
              <TraitsPicker
                provider={instanceEntry.driverKind}
                models={instanceEntry.models}
                model={selection.model}
                modelOptions={selection.options ?? []}
                allowPromptInjectedEffort={false}
                triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                onModelOptionsChange={(options) =>
                  setModel(createModelSelection(selection.instanceId, selection.model, options))
                }
              />
            </>
          ) : null}
          <Switch
            checked={dedicated}
            disabled={disabled || (!dedicated && !hasProvider)}
            onCheckedChange={(checked) =>
              updateSettings({
                botReviewerModelSelection: checked
                  ? createModelSelection(
                      settings.textGenerationModelSelection.instanceId,
                      settings.textGenerationModelSelection.model,
                      settings.textGenerationModelSelection.options,
                    )
                  : null,
              })
            }
            aria-label={gt("Use a separate script reviewer model")}
          />
        </div>
      }
    />
  );
}
