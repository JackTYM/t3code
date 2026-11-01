import type { SideQuestionOutcome } from "@t3tools/client-runtime/state/side-questions";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { MessageCircleQuestionMarkIcon } from "lucide-react";

import ChatMarkdown from "../ChatMarkdown";
import { ComposerBanner } from "./ComposerBanner";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

export function sideQuestionBannerItem(input: {
  readonly id: string;
  readonly question: string;
  readonly outcome: SideQuestionOutcome;
  readonly cwd: string | undefined;
  readonly threadRef: ScopedThreadRef;
  readonly onDismiss: () => void;
}): ComposerBannerStackItem {
  const { outcome } = input;
  return {
    id: input.id,
    variant: outcome.status === "failed" ? "error" : "info",
    icon: <MessageCircleQuestionMarkIcon />,
    title: input.question,
    description: outcome.status === "failed" ? outcome.message : "Not added to the thread",
    dismissLabel: "Dismiss side question",
    onDismiss: input.onDismiss,
    // Static text while pending: nothing repaints on a timer.
    children:
      outcome.status === "failed" ? undefined : (
        <ComposerBanner.Scroll>
          <ComposerBanner.Body className="pe-1 pb-1 wrap-anywhere">
            {outcome.status === "pending" ? (
              <p className="text-muted-foreground">Thinking…</p>
            ) : outcome.answer.synthetic ? (
              <p className="text-muted-foreground italic">{outcome.answer.response}</p>
            ) : (
              <ChatMarkdown
                text={outcome.answer.response}
                cwd={input.cwd}
                threadRef={input.threadRef}
                className="text-foreground/85"
              />
            )}
          </ComposerBanner.Body>
        </ComposerBanner.Scroll>
      ),
  };
}
