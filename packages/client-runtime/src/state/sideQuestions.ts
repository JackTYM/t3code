import {
  SIDE_QUESTION_HISTORY_LIMIT,
  WS_METHODS,
  type SideQuestionAnswer,
  type SideQuestionExchange,
} from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

/**
 * Reads a composer message as `/btw <question>`. Returns the question, an empty
 * string for the bare command, and null for anything else, which is an ordinary
 * message.
 */
export function parseSideQuestionCommand(prompt: string): string | null {
  const match = /^\/btw(?:\s+([\s\S]*))?$/iu.exec(prompt.trim());
  return match === null ? null : (match[1]?.trim() ?? "");
}

export type SideQuestionOutcome =
  | { readonly status: "pending" }
  | { readonly status: "answered"; readonly answer: SideQuestionAnswer }
  | { readonly status: "failed"; readonly message: string };

export interface SideQuestionPanel {
  readonly id: number;
  readonly threadKey: string;
  readonly question: string;
  readonly outcome: SideQuestionOutcome;
  /** Answered questions, sent with the next one so a follow-up reads in context. */
  readonly exchanges: ReadonlyArray<SideQuestionExchange>;
}

/** The panel belongs to the thread it was asked in; another thread starts clean. */
export function sideQuestionPanelForThread(
  panel: SideQuestionPanel | null,
  threadKey: string,
): SideQuestionPanel | null {
  return panel?.threadKey === threadKey ? panel : null;
}

export function startSideQuestion(
  panel: SideQuestionPanel | null,
  next: { readonly id: number; readonly threadKey: string; readonly question: string },
): SideQuestionPanel {
  return {
    ...next,
    outcome: { status: "pending" },
    exchanges: sideQuestionPanelForThread(panel, next.threadKey)?.exchanges ?? [],
  };
}

/** A dismissed or replaced panel has no use for a late answer, so it is left as it is. */
export function settleSideQuestion(
  panel: SideQuestionPanel | null,
  id: number,
  settled: { readonly answer: SideQuestionAnswer } | { readonly failure: string },
): SideQuestionPanel | null {
  if (panel === null || panel.id !== id) return panel;
  if ("failure" in settled) {
    return { ...panel, outcome: { status: "failed", message: settled.failure } };
  }
  return {
    ...panel,
    outcome: { status: "answered", answer: settled.answer },
    // A synthetic answer is the provider's apology, not something to build on.
    exchanges: settled.answer.synthetic
      ? panel.exchanges
      : [...panel.exchanges, { question: panel.question, response: settled.answer.response }].slice(
          -SIDE_QUESTION_HISTORY_LIMIT,
        ),
  };
}

export function createSideQuestionEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    // Not serialized: a side question is meant to be asked while another is still out.
    ask: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:side-questions:ask",
      tag: WS_METHODS.sideQuestionsAsk,
    }),
  };
}
