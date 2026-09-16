import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";

import { mobilePreferencesAtom } from "../../state/preferences";
import { resolveLegacyPlanModeEnabled } from "./legacy-plan-mode";

/**
 * Mobile preferences are device-local, matching the desktop client setting.
 * Plan mode is on unless this device opted out, so an unresolved store reads as
 * enabled rather than clamping the composer to build while it loads.
 */
export function useLegacyPlanModeState(): boolean {
  const preferences = useAtomValue(mobilePreferencesAtom);
  return resolveLegacyPlanModeEnabled({
    preference: AsyncResult.isSuccess(preferences) ? preferences.value.planModeEnabled : undefined,
  });
}
