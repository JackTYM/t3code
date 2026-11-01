import {
  sideQuestionPanelForThread,
  settleSideQuestion,
  startSideQuestion,
  type SideQuestionPanel,
} from "@t3tools/client-runtime/state/side-questions";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useCallback, useMemo, useRef, useState } from "react";

import { sideQuestionEnvironment } from "../../state/sideQuestions";
import { formatEnvironmentQueryError } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { sideQuestionBannerItem } from "./SideQuestionBanner";

/**
 * One side question panel per composer. Nothing here is persisted: dismissing
 * the panel drops the question, its answer, and the context it carried.
 */
export function useSideQuestion(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly threadKey: string;
  readonly threadRef: ScopedThreadRef;
  readonly cwd: string | undefined;
}): {
  readonly banner: ComposerBannerStackItem | null;
  readonly ask: (question: string) => void;
} {
  const { environmentId, threadId, threadKey, threadRef, cwd } = input;
  const askCommand = useAtomCommand(sideQuestionEnvironment.ask, { reportFailure: false });
  const [panel, setPanel] = useState<SideQuestionPanel | null>(null);
  const nextId = useRef(0);
  const current = sideQuestionPanelForThread(panel, threadKey);

  const ask = (question: string) => {
    const id = ++nextId.current;
    const started = startSideQuestion(panel, { id, threadKey, question });
    setPanel(started);
    void askCommand({
      environmentId,
      input: { threadId, question, history: started.exchanges },
    }).then((result) =>
      setPanel((latest) =>
        settleSideQuestion(
          latest,
          id,
          result._tag === "Success"
            ? { answer: result.value }
            : { failure: formatEnvironmentQueryError(result.cause) },
        ),
      ),
    );
  };

  const dismiss = useCallback(() => setPanel(null), []);
  const banner = useMemo(
    () =>
      current === null
        ? null
        : sideQuestionBannerItem({
            id: `side-question:${current.threadKey}`,
            question: current.question,
            outcome: current.outcome,
            cwd,
            threadRef,
            onDismiss: dismiss,
          }),
    [current, cwd, dismiss, threadRef],
  );

  return { banner, ask };
}
