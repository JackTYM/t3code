import {
  type SideQuestionAnswer,
  type SideQuestionAskInput,
  SideQuestionError,
  type SideQuestionUnavailableReason,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

/**
 * Asks a question of a thread's live provider session. A stopped session is
 * reported, never started: a side question must not spend a turn or cost the
 * thread a session it did not have.
 */
export class SessionSideQuestions extends Context.Service<
  SessionSideQuestions,
  {
    readonly ask: (
      input: SideQuestionAskInput,
    ) => Effect.Effect<SideQuestionAnswer, SideQuestionError>;
  }
>()("t3/sideQuestions/SessionSideQuestions") {}

const make = Effect.gen(function* () {
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;

  const ask = Effect.fn("SessionSideQuestions.ask")(function* (input: SideQuestionAskInput) {
    const { threadId } = input;
    const fail = (reason: SideQuestionError["reason"], cause?: unknown) =>
      new SideQuestionError({ threadId, reason, ...(cause === undefined ? {} : { cause }) });
    const unavailable = (reason: SideQuestionUnavailableReason) => fail(reason);

    const projection = yield* threadManagement
      .getThreadRecords(threadId, ["providerThreads"])
      .pipe(Effect.mapError((cause) => fail("request-failed", cause)));
    const providerThread =
      projection.providerThreads.find(
        (candidate) => candidate.id === projection.thread.activeProviderThreadId,
      ) ?? projection.providerThreads.at(-1);
    if (providerThread?.providerSessionId == null) return yield* unavailable("session-stopped");
    const runtime = Option.getOrUndefined(
      yield* providerSessions
        .get(providerThread.providerSessionId)
        .pipe(Effect.mapError((cause) => fail("request-failed", cause))),
    );
    if (runtime === undefined) return yield* unavailable("session-stopped");
    if (runtime.sideQuestions === undefined) return yield* unavailable("provider-unsupported");

    const outcome = yield* runtime.sideQuestions
      .ask({
        providerThread,
        question: input.question,
        history: input.history ?? [],
      })
      .pipe(Effect.mapError((cause) => fail("request-failed", cause)));
    switch (outcome.status) {
      case "unavailable":
        return yield* unavailable(outcome.reason);
      case "no-answer":
        return yield* fail("no-answer");
      case "answered":
        return { response: outcome.response, synthetic: outcome.synthetic };
    }
  });

  return SessionSideQuestions.of({ ask });
});

export const layer = Layer.effect(SessionSideQuestions, make);
