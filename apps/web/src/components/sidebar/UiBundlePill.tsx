import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";

import {
  uiBundleEnvironment,
  uiBundleFailureMessage,
  usePrimaryUiBundle,
} from "../../state/uiBundles";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { SidebarMenuItem } from "../ui/sidebar";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { shouldOfferUiBundle } from "./uiBundle.logic";

/** Offers a verified UI bundle the server has staged; applying it reloads only this window. */
export function UiBundlePill() {
  const { environmentId, capabilities, state } = usePrimaryUiBundle();
  const canApply = useAtomValue(uiBundleEnvironment.apply.permissionAtom(environmentId));
  const apply = useAtomCommand(uiBundleEnvironment.apply, { reportFailure: false });
  const [applying, setApplying] = useState(false);

  if (environmentId === null || !shouldOfferUiBundle(capabilities, state)) return null;

  const handleApply = async () => {
    if (applying) return;
    setApplying(true);
    const result = await apply({ environmentId, input: {} });
    if (result._tag === "Failure") {
      setApplying(false);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not apply UI update",
          description: uiBundleFailureMessage(result.cause),
        }),
      );
      return;
    }
    window.location.reload();
  };

  return (
    <SidebarMenuItem className="shrink-0">
      <Button
        size="xs"
        variant="glass"
        disabled={!canApply || applying}
        aria-busy={applying}
        onClick={() => void handleApply()}
      >
        UI update ready
      </Button>
    </SidebarMenuItem>
  );
}
