import { useAtomValue } from "@effect/atom-react";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";

import { formatRelativeTimeLabel } from "../../timestampFormat";
import {
  uiBundleEnvironment,
  uiBundleFailureMessage,
  usePrimaryUiBundle,
} from "../../state/uiBundles";
import { useAtomCommand } from "../../state/use-atom-command";
import { describeIncompatibility } from "../sidebar/uiBundle.logic";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";

type Action = "check" | "revert";

export function UiBundleSettingsRow() {
  const { environmentId, capabilities, state } = usePrimaryUiBundle();
  const canCheck = useAtomValue(uiBundleEnvironment.check.permissionAtom(environmentId));
  const canRevert = useAtomValue(uiBundleEnvironment.revert.permissionAtom(environmentId));
  const check = useAtomCommand(uiBundleEnvironment.check, { reportFailure: false });
  const revert = useAtomCommand(uiBundleEnvironment.revert, { reportFailure: false });
  const [pending, setPending] = useState<Action | null>(null);

  if (environmentId === null || capabilities?.uiBundles !== true || state === null) return null;
  if (!state.enabled) return null;

  const run = async (
    action: Action,
    title: string,
    execute: () => Promise<AtomCommandResult<unknown, unknown>>,
  ) => {
    if (pending !== null) return;
    setPending(action);
    const result = await execute();
    if (result._tag === "Failure") {
      setPending(null);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title,
          description: uiBundleFailureMessage(result.cause),
        }),
      );
      return;
    }
    setPending(null);
    // The window keeps running the UI it loaded until it reloads.
    if (action === "revert") window.location.reload();
  };

  return (
    <SettingsRow
      title="Web UI"
      description={
        <>
          <span className="block">
            Version{" "}
            {state.active === "builtin" ? `${state.builtinVersion} (built-in)` : state.active}
            {" · "}
            {state.lastCheckedAt === null
              ? "never checked"
              : `checked ${formatRelativeTimeLabel(state.lastCheckedAt)}`}
          </span>
          {state.incompatible === null ? null : (
            <span className="block">
              Full update needed: {describeIncompatibility(state.incompatible.reason)}
            </span>
          )}
        </>
      }
      control={
        <div className="flex gap-2">
          {state.active === "builtin" ? null : (
            <Button
              size="sm"
              variant="outline"
              disabled={!canRevert || pending !== null}
              onClick={() =>
                void run("revert", "Could not revert the UI", () =>
                  revert({ environmentId, input: {} }),
                )
              }
            >
              Revert to built-in
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={!canCheck || pending !== null}
            onClick={() =>
              void run("check", "Could not check for a UI update", () =>
                check({ environmentId, input: {} }),
              )
            }
          >
            {pending === "check" ? "Checking…" : "Check now"}
          </Button>
        </div>
      }
    />
  );
}
