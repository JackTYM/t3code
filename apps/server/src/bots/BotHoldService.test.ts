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
  /** A run that may become active later, and the message it began with. */
  readonly later?: { readonly id: RunId; readonly startedBy: string };
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
                    ...(fixture.later === undefined
                      ? []
                      : [
                          {
                            id: fixture.later.id,
                            userMessageId: MessageId.make(fixture.later.startedBy),
                          },
                        ]),
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

it.effect.each([
  { startedBy: "bot-wake:watcher:home:calendar:event:1" },
  { startedBy: "bot-wake:watcher:home:calendar:1700000000:2:abc" },
  { startedBy: "bot-wake:watcher-review:home:calendar:abc" },
] as const)("holds a consequential call in a turn a watcher wake began", ({ startedBy }) =>
  run({ startedBy }, (holds) =>
    Effect.gen(function* () {
      const verdict = yield* holds.check(call("t3_thread_launch", { title: "Fix prod" }));
      assert.isTrue(verdict.held);
      assert.include((verdict as { message: string }).message, "a watcher's output");
      assert.isFalse((yield* holds.check(call("t3_bot_mail_search", {}))).held);
    }),
  ),
);

// A health wake is the server's own words, written from fixed fields, so it is no more influenced
// than a message the user typed. It must not match the mail or watcher prefixes, which do hold.
it.effect.each([
  { startedBy: "bot-wake:health:0123456789ab:1", held: false },
  { startedBy: "bot-wake:health:0123456789ab:7", held: false },
  { startedBy: DIGEST, held: true },
  { startedBy: "bot-wake:watcher:home:disk:1700000000:2:abc", held: true },
  { startedBy: "bot-wake:watcher-review:home:disk:abc", held: true },
] as const)(
  "a turn that began with $startedBy holds consequential calls: $held",
  ({ startedBy, held }) =>
    run({ startedBy }, (holds) =>
      Effect.gen(function* () {
        for (const tool of ["t3_thread_launch", "delegate_task", "schedule_task"]) {
          assert.strictEqual((yield* holds.check(call(tool, { title: "Fix it." }))).held, held);
        }
        assert.strictEqual((yield* holds.list(BOT)).held.length, held ? 3 : 0);
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

it.effect("lets a Bot set its own model in that turn but holds it aimed at another thread", () =>
  run({ startedBy: DIGEST }, (holds) =>
    Effect.gen(function* () {
      const model = { instanceId: "claudeAgent", model: "claude-opus-5-5" };
      for (const params of [{ modelSelection: model }, { threadId: BOT, modelSelection: model }]) {
        assert.isFalse((yield* holds.check(call("t3_thread_configure", params))).held);
      }
      assert.deepEqual((yield* holds.list(BOT)).held, []);
      for (const params of [
        { threadId: CREW, modelSelection: model },
        { threadId: STRANGER, modelSelection: model },
        { environmentId: "environment:laptop", modelSelection: model },
        { threadId: BOT, environmentId: "environment:laptop", modelSelection: model },
      ]) {
        assert.isTrue((yield* holds.check(call("t3_thread_configure", params))).held);
      }
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

const HEALTH = "bot-wake:health:0123456789ab:1";

// A repair crew runs as the Bot's crew with the user's reach, so only the server's own health wake
// may ask for one. A client picks its own message ids, so `RepairService` checks the rest again.
it.effect.each([
  { startedBy: "message:typed" },
  { startedBy: DIGEST },
  { startedBy: "bot-wake:watcher:home:disk:event:1" },
  { startedBy: "bot-wake:health-ish:0123456789ab:1" },
  { startedBy: "bot-wake:health:0123456789ab" },
  { startedBy: "message:bot-wake:health:0123456789ab:1" },
] as const)("refuses t3_bot_repair_start in a turn that began with $startedBy", ({ startedBy }) =>
  run({ startedBy }, (holds) =>
    Effect.gen(function* () {
      const verdict = yield* holds.check(call("t3_bot_repair_start", { signalId: "0123456789ab" }));
      assert.isTrue(verdict.held);
      assert.include((verdict as { message: string }).message, "Health");
      // Refused, not held: there is no card for the user to allow, since allowing would only
      // start another turn that is not a health turn either.
      assert.deepEqual((yield* holds.list(BOT)).held, []);
    }),
  ),
);

it.effect("allows t3_bot_repair_start in a health turn, tainted or not", () =>
  run({ startedBy: HEALTH }, (holds) =>
    Effect.gen(function* () {
      const start = call("t3_bot_repair_start", { signalId: "0123456789ab" });
      assert.isFalse((yield* holds.check(start)).held);
      yield* holds.check(call("t3_bot_mail_search", {}, true));
      assert.isFalse((yield* holds.check(start)).held);
    }),
  ),
);

it.effect.each([
  { tool: "t3_bot_watcher_list", readonly: true },
  { tool: "t3_thread_read", readonly: true },
  { tool: "t3_thread_search", readonly: true },
  { tool: "list_issues", readonly: true },
  { tool: "t3_bot_mail_search", readonly: true },
] as const)("a health turn that reads with $tool is held like an influenced one", (read) =>
  run({ startedBy: HEALTH }, (holds) =>
    Effect.gen(function* () {
      // Untouched, a health turn is as free as one the user typed.
      assert.isFalse((yield* holds.check(call("t3_thread_launch", { title: "Fix" }))).held);
      assert.isFalse((yield* holds.check(call(read.tool, {}, read.readonly))).held);
      for (const consequential of ["t3_thread_launch", "delegate_task", "t3_thread_send"]) {
        assert.isTrue((yield* holds.check(call(consequential, { threadId: STRANGER }))).held);
      }
      // Its own notes and tasks stay free, and so does the repair it was woken for.
      assert.isFalse(
        (yield* holds.check(call("t3_bot_tasks_write", { contents: "- [ ] a" }))).held,
      );
      assert.isFalse(
        (yield* holds.check(call("t3_bot_repair_start", { signalId: "0123456789ab" }))).held,
      );
    }),
  ),
);

it.effect("in a health turn the Bot's own memory is not outside text", () =>
  run({ startedBy: HEALTH }, (holds) =>
    Effect.gen(function* () {
      yield* holds.check(call("t3_bot_memory_read", {}, true));
      yield* holds.check(call("t3_bot_repair_start", { signalId: "0123456789ab" }));
      assert.isFalse((yield* holds.check(call("t3_thread_launch", { title: "Fix" }))).held);
    }),
  ),
);

it.effect("the repair stays allowed whichever side of the read it comes on", () =>
  run({ startedBy: HEALTH }, (holds) =>
    Effect.gen(function* () {
      const start = call("t3_bot_repair_start", { signalId: "0123456789ab" });
      assert.isFalse((yield* holds.check(start)).held);
      yield* holds.check(call("t3_bot_watcher_list", {}, true));
      assert.isTrue((yield* holds.check(call("t3_thread_launch", {}))).held);
      assert.isFalse((yield* holds.check(start)).held);
    }),
  ),
);

// The reads only count in a health turn: a turn the user typed is not made stricter by them.
it.effect.each(["t3_bot_watcher_list", "t3_thread_read"] as const)(
  "%s taints nothing in a turn the user began",
  (tool) =>
    run({ startedBy: "message:typed" }, (holds) =>
      Effect.gen(function* () {
        yield* holds.check(call(tool, {}, true));
        assert.isFalse((yield* holds.check(call("t3_thread_launch", {}))).held);
      }),
    ),
);

it.effect(
  "the next turn is its own: a health turn does not leave the Bot able to start a repair",
  () => {
    const next = RunId.make("run:next");
    const start = call("t3_bot_repair_start", { signalId: "0123456789ab" });
    return run({ startedBy: HEALTH, later: { id: next, startedBy: "message:typed" } }, (holds) =>
      Effect.gen(function* () {
        const bot = shells[BOT] as { activeRunId: RunId };
        assert.isFalse((yield* holds.check(start)).held);
        assert.isFalse((yield* holds.check(start)).held);
        bot.activeRunId = next;
        try {
          assert.isTrue((yield* holds.check(start)).held);
          // And the reads of the new turn are not counted against it.
          yield* holds.check(call("t3_thread_read", {}, true));
          assert.isFalse((yield* holds.check(call("t3_thread_launch", {}))).held);
        } finally {
          bot.activeRunId = RUN;
        }
      }),
    );
  },
);
