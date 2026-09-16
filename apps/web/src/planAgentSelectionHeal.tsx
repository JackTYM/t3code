import { useEffect } from "react";

import {
  useClientSettingsHydrated,
  usePrimarySettings,
  useUpdatePrimarySettings,
} from "./hooks/useSettings";
import { resolvePlanAgentHealPatch } from "./modelSelection";

/**
 * Heals persisted text-generation model selections that still reference the
 * opencode "plan" agent. The dropdown hides the option while plan mode is off,
 * but the toggle handler only runs when the setting flips; users who already
 * have plan mode off with a stored "plan" selection need this pass whenever
 * the settings load.
 */
export function PlanAgentSelectionHeal() {
  const planModeEnabled = usePrimarySettings((settings) => settings.planModeEnabled);
  const textGenerationModelSelection = usePrimarySettings(
    (settings) => settings.textGenerationModelSelection,
  );
  const sourceControlWriterModelSelection = usePrimarySettings(
    (settings) => settings.sourceControlWriterModelSelection,
  );
  const settingsHydrated = useClientSettingsHydrated();
  const updateSettings = useUpdatePrimarySettings();

  useEffect(() => {
    // Until client settings hydrate, planModeEnabled reads as the schema
    // default (on), so an early pass would no-op rather than misfire. Still
    // gate on hydration: the heal must act on the user's real setting, not on
    // a default that may be about to flip to off.
    if (!settingsHydrated) {
      return;
    }
    const patch = resolvePlanAgentHealPatch({
      planModeEnabled,
      textGenerationModelSelection,
      sourceControlWriterModelSelection,
    });
    if (patch) {
      updateSettings(patch);
    }
  }, [
    planModeEnabled,
    settingsHydrated,
    textGenerationModelSelection,
    sourceControlWriterModelSelection,
    updateSettings,
  ]);

  return null;
}
