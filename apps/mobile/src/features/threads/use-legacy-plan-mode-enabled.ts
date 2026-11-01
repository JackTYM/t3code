import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";

import { mobilePreferencesAtom } from "../../state/preferences";
import { resolveLegacyPlanModeEnabled } from "../../state/legacy-plan-mode";

export function useLegacyPlanModeState(): { readonly enabled: boolean } {
  const preferences = useAtomValue(mobilePreferencesAtom);
  return {
    enabled: resolveLegacyPlanModeEnabled({
      preference: AsyncResult.isSuccess(preferences)
        ? preferences.value.planModeEnabled
        : undefined,
    }),
  };
}
