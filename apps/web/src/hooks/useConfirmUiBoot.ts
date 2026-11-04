import { useEffect, useEffectEvent } from "react";

import { APP_VERSION } from "../branding";
import { uiBundleEnvironment, usePrimaryUiBundle } from "../state/uiBundles";
import { useAtomCommand } from "../state/use-atom-command";

// The server reverts an applied bundle that never confirms, so a page load must send at most
// one successful confirmation; a failed attempt clears the flag so a later effect run retries.
let confirmedThisPageLoad = false;

/** Tells the server this UI mounted, which stops its revert timer for a freshly applied bundle. */
export function useConfirmUiBoot() {
  const { environmentId, state } = usePrimaryUiBundle();
  const confirmBoot = useAtomCommand(uiBundleEnvironment.confirmBoot, { reportFailure: false });

  // useAtomCommand returns a fresh closure every render, so the effect reads it through an event.
  const confirm = useEffectEvent(async (id: NonNullable<typeof environmentId>) => {
    const result = await confirmBoot({ environmentId: id, input: { version: APP_VERSION } });
    if (result._tag === "Failure") confirmedThisPageLoad = false;
  });

  // Depends on `state` rather than only bootPending: a refreshed state after a reconnect is what
  // gives a failed confirmation its next attempt.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the server's boot timer this UI mounted; there is no user action to hang it on
  useEffect(() => {
    if (state?.bootPending !== true || environmentId === null || confirmedThisPageLoad) return;
    confirmedThisPageLoad = true;
    void confirm(environmentId);
  }, [state, environmentId]);
}
