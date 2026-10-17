import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";

import { mobilePreferencesAtom } from "../../state/preferences";
import { resolveLegacyPlanModeEnabled } from "../../state/legacy-plan-mode";

export function useLegacyPlanModeState(): boolean {
  const preferences = useAtomValue(mobilePreferencesAtom);
  return resolveLegacyPlanModeEnabled({
    preference: AsyncResult.isSuccess(preferences) ? preferences.value.planModeEnabled : undefined,
  });
}
