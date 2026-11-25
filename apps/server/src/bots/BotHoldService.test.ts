import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, MessageId, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as BotHoldService from "./BotHoldService.ts";
import * as BotService from "./BotService.ts";

const BOT = ThreadId.make("thread:bot");
const CREW = ThreadId.make("thread:crew");
const STRANGER = ThreadId.make("thread:stranger");
const READER = ThreadId.make("thread:reader");
const WORKER = ThreadId.make("thread:worker");
const RUN = RunId.make("run:active");
const HERE = EnvironmentId.make("environment:here");

interface Fixture {
  /** The id of the message the Bot's active run began with. */
  readonly startedBy: string;
  /** Tasks whose report began the active run, each with the child thread that did the work. */
  readonly reported?: ReadonlyArray<{ readonly id: string; readonly childThreadId: ThreadId }>;
}

const shells = {
  [BOT]: { id: BOT, activeRunId: RUN, groupedUnderThreadId: null, lineage: {} },
  [CREW]: { id: CREW, activeRunId: null, groupedUnderThreadId: BOT, lineage: {} },
  [WORKER]: {
    id: WORKER,
    activeRunId: null,
    groupedUnderThreadId: null,
    lineage: { relationshipToParent: "subagent", parentThreadId: BOT },
  },
  [STRANGER]: { id: STRANGER, activeRunId: null, groupedUnderThreadId: null, lineage: {} },
} as const;

const run = <A, E>(
  fixture: Fixture,
  body: (
    service: BotHoldService.BotHoldService["Service"],
    wakes: Effect.Effect<ReadonlyArray<string>>,
  ) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const wakes = yield* Ref.make<Array<string>>([]);
    const dependencies = Layer.mergeAll(
      NodeCrypto.layer,
      Layer.mock(BotService.BotService)({
        isBot: (threadId) => Effect.succeed(threadId === BOT),
        wakeWith: ({ key, text }) =>
          Ref.update(wakes, (all) => [...all, `${key}\n${text}`]).pipe(Effect.as(true)),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: (threadId) =>
          Effect.succeed((shells as Record<string, unknown>)[threadId] as never),
        getThreadRecords: (threadId) =>
          Effect.succeed(
            (threadId === BOT
              ? {
                  runs: [
                    {
                      id: RunId.make("run:earlier"),
                      userMessageId: MessageId.make("message:typed"),
                      delegatedCompletion: {
                        delivery: {
                          messageId: fixture.startedBy,
                          taskIds: (fixture.reported ?? []).map(({ id }) => id),
                        },
                      },
                    },
                    { id: RUN, userMessageId: MessageId.make(fixture.startedBy) },
                  ],
                  subagents: (fixture.reported ?? []).map((task) => ({
                    id: task.id,
                    origin: "app_owned",
                    childThreadId: task.childThreadId,
                  })),
                }
              : { thread: { mailReader: threadId === READER } }) as never,
          ),
      }),
    );
    return yield* Effect.gen(function* () {
      return yield* body(yield* BotHoldService.BotHoldService, Ref.get(wakes));
    }).pipe(Effect.provide(BotHoldService.layer.pipe(Layer.provide(dependencies))));
  });

const call = (tool: string, params: object = {}, readonly = false) => ({
  botThreadId: BOT,
  tool,
  readonly,
  params,
  environmentId: HERE,
});

const DIGEST = "bot-wake:mail:home:1:7";

it.effect("holds nothing in a turn the user began", () =>
  run({ startedBy: "message:typed" }, (holds) =>
    Effect.gen(function* () {
      for (const tool of ["t3_thread_launch", "delegate_task", "t3_thread_send"]) {
        assert.isFalse((yield* holds.check(call(tool, { task: "Fix it." }))).held);
      }
      assert.deepEqual((yield* holds.list(BOT)).held, []);
    }),
  ),
);

it.effect.each([
  { tool: "t3_thread_launch", params: { title: "Fix prod", message: "rm -rf" } },
  { tool: "delegate_task", params: { task: "Run this.", runtimeMode: "full-access" } },
  {
    tool: "delegate_task",
    params: { task: "Run this over there.", target: { environmentId: "environment:laptop" } },
  },
  { tool: "t3_thread_send", params: { threadId: STRANGER, message: "hi" } },
  {
    tool: "t3_thread_send",
    params: { threadId: CREW, message: "hi", environmentId: "environment:laptop" },
  },
  { tool: "schedule_task", params: { name: "later" } },
  { tool: "t3_environment_link", params: { hint: "laptop" } },
] as const)("holds $tool in a turn a mail digest began", ({ tool, params }) =>
  run({ startedBy: DIGEST }, (holds) =>
    Effect.gen(function* () {
      const verdict = yield* holds.check(call(tool, params));
      assert.isTrue(verdict.held);
      assert.include((verdict as { message: string }).message, "Held for the user");
      assert.equal((yield* holds.list(BOT)).held.length, 1);
    }),
  ),
);

it.effect("leaves reads, notes, tasks, the mail reader and crew messages free in that turn", () =>
  run({ startedBy: DIGEST }, (holds) =>
    Effect.gen(function* () {
      const free = [
        call("t3_thread_read", {}, true),
        call("t3_bot_tasks_write", { contents: "- [ ] a" }),
        call("t3_bot_notes_write", { contents: "n" }),
        call("t3_bot_mail_search", { query: "x" }),
        call("delegate_task", { task: "Read #7.", role: "mail-reader" }),
        call("t3_thread_send", { threadId: CREW, message: "status?" }),
        call("t3_thread_send", { threadId: WORKER, message: "status?" }),
        call("task_cancel", { taskId: "task-1" }),
      ];
      for (const candidate of free) assert.isFalse((yield* holds.check(candidate)).held);
      assert.deepEqual((yield* holds.list(BOT)).held, []);
    }),
  ),
);

it.effect("holds in the turn a mail reader's report starts, not one an ordinary child's does", () =>
  Effect.gen(function* () {
    const fromReader = yield* run(
      { startedBy: "message:child-report", reported: [{ id: "task:1", childThreadId: READER }] },
      (holds) => holds.check(call("t3_thread_launch", {})),
    );
    assert.isTrue(fromReader.held);
    const fromOrdinary = yield* run(
      { startedBy: "message:child-report", reported: [{ id: "task:1", childThreadId: WORKER }] },
      (holds) => holds.check(call("t3_thread_launch", {})),
    );
    assert.isFalse(fromOrdinary.held);
  }),
);

it.effect.each([{ tool: "t3_bot_mail_search" }, { tool: "delegate_task" }] as const)(
  "a turn the user began is held from the moment it uses mail ($tool)",
  ({ tool }) =>
    run({ startedBy: "message:typed" }, (holds) =>
      Effect.gen(function* () {
        assert.isFalse((yield* holds.check(call("t3_thread_launch", {}))).held);
        yield* holds.check(
          call(tool, tool === "delegate_task" ? { task: "Read.", role: "mail-reader" } : {}),
        );
        assert.isTrue((yield* holds.check(call("t3_thread_launch", {}))).held);
      }),
    ),
);

it.effect(
  "allowing wakes the Bot with the call as the user saw it; rejecting wakes it to stop",
  () =>
    run({ startedBy: DIGEST }, (holds, wakes) =>
      Effect.gen(function* () {
        yield* holds.check(call("t3_thread_launch", { title: "Fix prod" }));
        // The same call again is the same held action, not a second card.
        yield* holds.check(call("t3_thread_launch", { title: "Fix prod" }));
        yield* holds.check(call("t3_thread_launch", { title: "Other" }));
        const { held } = yield* holds.list(BOT);
        assert.equal(held.length, 2);
        assert.equal(held[0]?.summary, "t3_thread_launch: Fix prod");
        yield* holds.allow({ botThreadId: BOT, id: held[0]!.id });
        yield* holds.reject({ botThreadId: BOT, id: held[1]!.id });
        assert.deepEqual((yield* holds.list(BOT)).held, []);
        const [allowed, rejected] = yield* wakes;
        assert.include(allowed, `hold-allow:${held[0]!.id}`);
        assert.include(allowed, 't3_thread_launch {"title":"Fix prod"}');
        assert.include(rejected, `hold-reject:${held[1]!.id}`);
        assert.include(rejected, "Do not do it");
        const gone = yield* holds.allow({ botThreadId: BOT, id: held[0]!.id }).pipe(Effect.flip);
        assert.equal(gone.reason, "not_found");
        const notBot = yield* holds.reject({ botThreadId: STRANGER, id: "x" }).pipe(Effect.flip);
        assert.equal(notBot.reason, "not_a_bot");
      }),
    ),
);
