import {
  AuthOrchestrationOperateScope,
  SIDE_QUESTION_HISTORY_LIMIT,
  WS_METHODS,
  clientRpcRequiredScopes,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  parseSideQuestionCommand,
  settleSideQuestion,
  sideQuestionPanelForThread,
  startSideQuestion,
  type SideQuestionPanel,
} from "./sideQuestions.ts";

describe("parseSideQuestionCommand", () => {
  it("reads the question after /btw", () => {
    expect(parseSideQuestionCommand("/btw what does this flag do?")).toBe(
      "what does this flag do?",
    );
  });

  it("keeps a multi-line question whole", () => {
    expect(parseSideQuestionCommand("/btw first line\nsecond line\n")).toBe(
      "first line\nsecond line",
    );
  });

  it("matches the command regardless of case and surrounding whitespace", () => {
    expect(parseSideQuestionCommand("  /BTW  why?  ")).toBe("why?");
  });

  it("reports the bare command as an empty question rather than an ordinary message", () => {
    expect(parseSideQuestionCommand("/btw")).toBe("");
    expect(parseSideQuestionCommand("/btw   \n")).toBe("");
  });

  it("leaves everything else to be sent as a message", () => {
    expect(parseSideQuestionCommand("btw what?")).toBeNull();
    expect(parseSideQuestionCommand("please /btw what?")).toBeNull();
    expect(parseSideQuestionCommand("/btwfoo bar")).toBeNull();
    expect(parseSideQuestionCommand("/compact")).toBeNull();
  });
});

describe("side question permissions", () => {
  it("needs operate access because answering spends a model call", () => {
    expect(clientRpcRequiredScopes(WS_METHODS.sideQuestionsAsk, undefined)).toEqual([
      AuthOrchestrationOperateScope,
    ]);
  });
});

describe("side question panel", () => {
  const answered = (response: string, synthetic = false) => ({
    answer: { response, synthetic },
  });
  const ask = (
    panel: SideQuestionPanel | null,
    id: number,
    question: string,
    threadKey = "thread-a",
  ) => startSideQuestion(panel, { id, threadKey, question });

  it("shows a question as pending until it settles", () => {
    expect(ask(null, 1, "why?")).toMatchObject({
      question: "why?",
      outcome: { status: "pending" },
      exchanges: [],
    });
  });

  it("carries answered questions into the next one so a follow-up has context", () => {
    const first = settleSideQuestion(ask(null, 1, "what changed?"), 1, answered("The adapter."));
    expect(ask(first, 2, "why?").exchanges).toEqual([
      { question: "what changed?", response: "The adapter." },
    ]);
  });

  it("starts clean in another thread instead of leaking context across threads", () => {
    const first = settleSideQuestion(ask(null, 1, "what changed?"), 1, answered("The adapter."));
    expect(ask(first, 2, "why?", "thread-b").exchanges).toEqual([]);
    expect(sideQuestionPanelForThread(first, "thread-b")).toBeNull();
  });

  it("does not build on a failed or synthetic answer", () => {
    const failed = settleSideQuestion(ask(null, 1, "a"), 1, { failure: "No answer came back." });
    expect(failed?.outcome).toEqual({ status: "failed", message: "No answer came back." });
    expect(failed?.exchanges).toEqual([]);
    const synthetic = settleSideQuestion(ask(null, 1, "a"), 1, answered("(No answer.)", true));
    expect(synthetic?.outcome).toMatchObject({ status: "answered" });
    expect(synthetic?.exchanges).toEqual([]);
  });

  it("keeps only the most recent exchanges", () => {
    let panel: SideQuestionPanel | null = null;
    for (let id = 1; id <= SIDE_QUESTION_HISTORY_LIMIT + 2; id += 1) {
      panel = settleSideQuestion(ask(panel, id, `q${id}`), id, answered(`a${id}`));
    }
    expect(panel?.exchanges).toHaveLength(SIDE_QUESTION_HISTORY_LIMIT);
    expect(panel?.exchanges[0]?.question).toBe("q3");
    expect(panel?.exchanges.at(-1)?.question).toBe(`q${SIDE_QUESTION_HISTORY_LIMIT + 2}`);
  });

  it("ignores a late answer for a question that was replaced or dismissed", () => {
    const second = ask(ask(null, 1, "first"), 2, "second");
    expect(settleSideQuestion(second, 1, answered("late"))).toBe(second);
    expect(settleSideQuestion(null, 1, answered("late"))).toBeNull();
  });
});
