import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type ProviderInteractionMode,
  type ServerProvider,
} from "@t3tools/contracts";

type InteractionModeProvider = Pick<ServerProvider, "showInteractionModeToggle">;

export function resolveProviderInteractionMode(
  provider: InteractionModeProvider | null | undefined,
  interactionMode: ProviderInteractionMode | null | undefined,
): ProviderInteractionMode {
  return provider?.showInteractionModeToggle === false
    ? DEFAULT_PROVIDER_INTERACTION_MODE
    : (interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE);
}

/**
 * Plan mode ships on, so only an explicit opt-out turns it off. An unread
 * preference is `undefined` and therefore enabled, which keeps a thread that
 * persisted plan mode from running a turn as build while the device store
 * loads. Web does the same through its client-settings default.
 */
export function resolveLegacyPlanModeEnabled(input: {
  readonly preference: boolean | undefined;
}): boolean {
  return input.preference !== false;
}

/**
 * A task being edited carries its mode on the draft (`beginEditingPendingTask`
 * seeds it), so the draft is the only source needed here.
 */
export function resolvePendingTaskInteractionMode(input: {
  readonly planModeEnabled: boolean;
  readonly draftInteractionMode: ProviderInteractionMode | undefined;
  readonly provider?: InteractionModeProvider | null;
}): ProviderInteractionMode {
  if (input.provider?.showInteractionModeToggle === false) {
    return DEFAULT_PROVIDER_INTERACTION_MODE;
  }
  if (input.planModeEnabled) {
    return input.draftInteractionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE;
  }
  return DEFAULT_PROVIDER_INTERACTION_MODE;
}
