import { useEffect } from "react";

import { APP_VERSION } from "../branding";
import { uiBundleEnvironment, usePrimaryUiBundle } from "../state/uiBundles";
import { useAtomCommand } from "../state/use-atom-command";

// The server reverts an applied bundle that never confirms, so this must not repeat
// or be skipped once the UI is up; a page load confirms at most once.
let confirmedThisPageLoad = false;

/** Tells the server this UI mounted, which stops its revert timer for a freshly applied bundle. */
export function useConfirmUiBoot() {
  const { environmentId, state } = usePrimaryUiBundle();
  const confirmBoot = useAtomCommand(uiBundleEnvironment.confirmBoot, { reportFailure: false });
  const bootPending = state?.bootPending === true;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the server's boot timer this UI mounted; there is no user action to hang it on
  useEffect(() => {
    if (!bootPending || environmentId === null || confirmedThisPageLoad) return;
    confirmedThisPageLoad = true;
    void confirmBoot({ environmentId, input: { version: APP_VERSION } });
  }, [bootPending, environmentId, confirmBoot]);
}
