import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * A side question is answered from a thread's live provider session without
 * becoming part of the thread: no message, no turn, no tools. It can be asked
 * while the thread is working, which is the point.
 */

export const SideQuestionExchange = Schema.Struct({
  question: Schema.String,
  response: Schema.String,
});
export type SideQuestionExchange = typeof SideQuestionExchange.Type;

/** Earlier side questions the provider should read as context for a follow-up. */
export const SIDE_QUESTION_HISTORY_LIMIT = 8;

export const SideQuestionAskInput = Schema.Struct({
  threadId: ThreadId,
  question: TrimmedNonEmptyString,
  history: Schema.optional(
    Schema.Array(SideQuestionExchange).check(Schema.isMaxLength(SIDE_QUESTION_HISTORY_LIMIT)),
  ),
});
export type SideQuestionAskInput = typeof SideQuestionAskInput.Type;

export const SideQuestionAnswer = Schema.Struct({
  response: Schema.String,
  /** The provider could not answer and wrote the text itself, so it is not a real answer. */
  synthetic: Schema.Boolean,
});
export type SideQuestionAnswer = typeof SideQuestionAnswer.Type;

export const SideQuestionUnavailableReason = Schema.Literals([
  "provider-unsupported",
  "session-stopped",
  "session-unsupported",
]);
export type SideQuestionUnavailableReason = typeof SideQuestionUnavailableReason.Type;

export const SideQuestionErrorReason = Schema.Literals([
  ...SideQuestionUnavailableReason.literals,
  "no-answer",
  "request-failed",
]);
export type SideQuestionErrorReason = typeof SideQuestionErrorReason.Type;

export class SideQuestionError extends Schema.TaggedError<SideQuestionError>()(
  "SideQuestionError",
  {
    threadId: ThreadId,
    reason: SideQuestionErrorReason,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "provider-unsupported":
        return "This thread's provider cannot answer side questions.";
      case "session-stopped":
        return "This thread has no running session. Send a message to start one.";
      case "session-unsupported":
        return "This session cannot answer side questions. Updating the provider's CLI may help.";
      case "no-answer":
        return "No answer came back. Try again, or ask in the main conversation.";
      case "request-failed":
        return "Could not ask the side question.";
    }
  }
}
