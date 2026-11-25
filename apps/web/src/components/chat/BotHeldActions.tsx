import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import type { BotHeldAction, ScopedThreadRef } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { useState } from "react";

import { m } from "~/i18n/messages";
import { botFilesEnvironment } from "~/state/botFiles";
import { useAtomCommand } from "~/state/use-atom-command";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

function HeldAction(props: { threadRef: ScopedThreadRef; action: BotHeldAction }) {
  const gt = useGT();
  const { environmentId, threadId } = props.threadRef;
  const allow = useAtomCommand(botFilesEnvironment.holdAllow, { reportFailure: false });
  const reject = useAtomCommand(botFilesEnvironment.holdReject, { reportFailure: false });
  // Allowing lets a call run that can start code, so it needs terminal access like approving a watcher.
  const canAllow = useAtomValue(botFilesEnvironment.holdAllow.permissionAtom(environmentId));
  const canReject = useAtomValue(botFilesEnvironment.holdReject.permissionAtom(environmentId));
  const [busy, setBusy] = useState(false);
  const decide = async (decision: typeof allow | typeof reject, failureTitle: string) => {
    setBusy(true);
    const result = await decision({ environmentId, input: { threadId, id: props.action.id } });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: failureTitle,
        description:
          thrownErrorMessage(squashAtomCommandFailure(result), m) ?? gt("An error occurred."),
      });
    }
  };
  return (
    <Alert variant="warning">
      <AlertTitle>{props.action.summary}</AlertTitle>
      <AlertDescription>
        <p>
          <T>An email influenced this turn, so the Bot waits for you before it does this.</T>
        </p>
        <pre className="max-h-32 overflow-auto rounded-md bg-muted/50 p-2 text-xs whitespace-pre-wrap break-words">
          {props.action.input}
        </pre>
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            size="xs"
            disabled={busy || !canReject}
            onClick={() => void decide(reject, gt("Failed to reject the action"))}
          >
            <T>Reject</T>
          </Button>
          <Button
            variant="outline"
            size="xs"
            disabled={busy || !canAllow}
            onClick={() => void decide(allow, gt("Failed to allow the action"))}
          >
            <T>Allow</T>
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}

/** What the Bot wanted to do in a turn email influenced, waiting for the user's decision. */
export function BotHeldActions(props: {
  threadRef: ScopedThreadRef;
  held: ReadonlyArray<BotHeldAction>;
}) {
  return (
    <div className="flex flex-col gap-2">
      {props.held.map((action) => (
        <HeldAction key={action.id} threadRef={props.threadRef} action={action} />
      ))}
    </div>
  );
}
