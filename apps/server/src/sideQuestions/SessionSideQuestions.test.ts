import {
  ProviderDriverKind,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
  type OrchestrationV2ProviderThread,
  type SideQuestionError,
  type SideQuestionExchange,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SessionSideQuestions from "./SessionSideQuestions.ts";

const threadId = ThreadId.make("thread-side-question");
const providerThreadId = ProviderThreadId.make("provider-thread-side-question");
const providerSessionId = ProviderSessionId.make("provider-session-side-question");

function makeLayer(input: {
  readonly sessionId?: ProviderSessionId | null;
  readonly live?: boolean;
  readonly control?: ProviderAdapter.ProviderAdapterV2SideQuestions;
}) {
  return SessionSideQuestions.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: () =>
            Effect.succeed({
              thread: { activeProviderThreadId: providerThreadId },
              providerThreads:
                input.sessionId === null
                  ? []
                  : [
                      {
                        id: providerThreadId,
                        providerSessionId: input.sessionId ?? providerSessionId,
                      } as OrchestrationV2ProviderThread,
                    ],
            } as never),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          get: () =>
            Effect.succeed(
              input.live === false
                ? Option.none()
                : Option.some(
                    (input.control === undefined
                      ? {}
                      : {
                          sideQuestions: input.control,
                        }) as ProviderAdapter.ProviderAdapterV2SessionRuntime,
                  ),
            ),
        }),
      ),
    ),
  );
}

/** A control that records what the provider was asked, with the outcome scripted per test. */
function makeControl(outcome: ProviderAdapter.ProviderAdapterV2SideQuestionOutcome) {
  const asked: Array<{ question: string; history: ReadonlyArray<SideQuestionExchange> }> = [];
  const control: ProviderAdapter.ProviderAdapterV2SideQuestions = {
    ask: ({ question, history }) =>
      Effect.sync(() => {
        asked.push({ question, history });
        return outcome;
      }),
  };
  return { control, asked };
}

const reason = <A, R>(effect: Effect.Effect<A, SideQuestionError, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.reason),
  );

describe("SessionSideQuestions", () => {
  it.effect("refuses a thread that never started a session instead of starting one", () =>
    Effect.gen(function* () {
      const questions = yield* SessionSideQuestions.SessionSideQuestions;
      assert.equal(yield* reason(questions.ask({ threadId, question: "why?" })), "session-stopped");
    }).pipe(Effect.provide(makeLayer({ sessionId: null }))),
  );

  it.effect("refuses a session that is no longer running", () =>
    Effect.gen(function* () {
      const questions = yield* SessionSideQuestions.SessionSideQuestions;
      assert.equal(yield* reason(questions.ask({ threadId, question: "why?" })), "session-stopped");
    }).pipe(Effect.provide(makeLayer({ live: false }))),
  );

  it.effect("tells a provider without the control apart from a stopped session", () =>
    Effect.gen(function* () {
      const questions = yield* SessionSideQuestions.SessionSideQuestions;
      assert.equal(
        yield* reason(questions.ask({ threadId, question: "why?" })),
        "provider-unsupported",
      );
    }).pipe(Effect.provide(makeLayer({}))),
  );

  it.effect("passes the question and earlier exchanges through and returns the answer", () => {
    const { control, asked } = makeControl({
      status: "answered",
      response: "Because of the cache.",
      synthetic: false,
    });
    const history = [{ question: "what changed?", response: "The adapter." }];
    return Effect.gen(function* () {
      const questions = yield* SessionSideQuestions.SessionSideQuestions;
      assert.deepEqual(yield* questions.ask({ threadId, question: "why?", history }), {
        response: "Because of the cache.",
        synthetic: false,
      });
      assert.deepEqual(asked, [{ question: "why?", history }]);
    }).pipe(Effect.provide(makeLayer({ control })));
  });

  it.effect("asks with no history when the client sent none", () => {
    const { control, asked } = makeControl({
      status: "answered",
      response: "ok",
      synthetic: false,
    });
    return Effect.gen(function* () {
      const questions = yield* SessionSideQuestions.SessionSideQuestions;
      yield* questions.ask({ threadId, question: "why?" });
      assert.deepEqual(asked, [{ question: "why?", history: [] }]);
    }).pipe(Effect.provide(makeLayer({ control })));
  });

  it.effect("keeps a synthetic answer marked so the client does not present it as real", () => {
    const { control } = makeControl({
      status: "answered",
      response: "(No answer available for this side question.)",
      synthetic: true,
    });
    return Effect.gen(function* () {
      const questions = yield* SessionSideQuestions.SessionSideQuestions;
      const answer = yield* questions.ask({ threadId, question: "why?" });
      assert.equal(answer.synthetic, true);
    }).pipe(Effect.provide(makeLayer({ control })));
  });

  it.effect(
    "surfaces the session reason when the adapter cannot ask this particular session",
    () => {
      const { control } = makeControl({ status: "unavailable", reason: "session-unsupported" });
      return Effect.gen(function* () {
        const questions = yield* SessionSideQuestions.SessionSideQuestions;
        assert.equal(
          yield* reason(questions.ask({ threadId, question: "why?" })),
          "session-unsupported",
        );
      }).pipe(Effect.provide(makeLayer({ control })));
    },
  );

  it.effect("reports a provider that produced nothing as no answer", () => {
    const { control } = makeControl({ status: "no-answer" });
    return Effect.gen(function* () {
      const questions = yield* SessionSideQuestions.SessionSideQuestions;
      assert.equal(yield* reason(questions.ask({ threadId, question: "why?" })), "no-answer");
    }).pipe(Effect.provide(makeLayer({ control })));
  });

  it.effect("maps a failed provider request to request-failed without echoing its error", () => {
    const control: ProviderAdapter.ProviderAdapterV2SideQuestions = {
      ask: () =>
        Effect.fail(
          new ProviderAdapter.ProviderAdapterProtocolError({
            driver: ProviderDriverKind.make("claudeAgent"),
            detail: "Claude side question request failed",
            cause: new Error("side_question timed out"),
          }),
        ),
    };
    return Effect.gen(function* () {
      const questions = yield* SessionSideQuestions.SessionSideQuestions;
      const error = yield* Effect.flip(questions.ask({ threadId, question: "why?" }));
      assert.equal(error.reason, "request-failed");
      assert.equal(error.message, "Could not ask the side question.");
    }).pipe(Effect.provide(makeLayer({ control })));
  });
});
