import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import {
  CloudApiError,
  type ClaudeCloudApi,
  type ClaudeCloudError,
  type CloudEventSummary,
  type CloudFrame,
  type CloudOutgoingEvent,
  type CloudRepoSource,
} from "../claudeCloudApi.ts";
import {
  githubRepoSourceFromIdentity,
  makeClaudeCloudAdapter,
  readClaudeCloudSessionId,
} from "./ClaudeCloudAdapter.ts";

const instanceId = ProviderInstanceId.make("claudeCloud");
const driver = ProviderDriverKind.make("claudeCloud");
const threadId = ThreadId.make("thread-cloud-1");
const SESSION = "cse_one";

type Connection = Queue.Queue<
  CloudFrame | { readonly end: true } | { readonly fail: ClaudeCloudError }
>;

const worker = (
  sequenceNum: number,
  eventType: string,
  payload: Record<string, unknown>,
): CloudFrame => ({
  _tag: "client_event",
  eventId: `event-${sequenceNum}`,
  sequenceNum,
  eventType,
  source: "worker",
  payload,
});
const assistant = (sequenceNum: number, content: ReadonlyArray<Record<string, unknown>>) =>
  worker(sequenceNum, "assistant", { type: "assistant", message: { role: "assistant", content } });
const text = (sequenceNum: number, value: string) =>
  assistant(sequenceNum, [{ type: "text", text: value }]);
const result = (sequenceNum: number, extra: Record<string, unknown> = {}) =>
  worker(sequenceNum, "result", {
    type: "result",
    subtype: "success",
    is_error: false,
    total_cost_usd: 0.05,
    num_turns: 1,
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 5 },
    ...extra,
  });

interface HarnessOptions {
  readonly repo?: CloudRepoSource | null;
  /** Statuses for successive createSession calls; 0 means succeed. */
  readonly createFailures?: ReadonlyArray<number>;
  readonly getSession?: ClaudeCloudApi["getSession"];
  readonly latestEvents?: ReadonlyArray<CloudEventSummary>;
  readonly sendFailure?: ClaudeCloudError;
}

const harness = (options: HarnessOptions = {}) =>
  Effect.gen(function* () {
    const sent: Array<{ readonly id: string; readonly events: ReadonlyArray<CloudOutgoingEvent> }> =
      [];
    const created: Array<{
      sources: ReadonlyArray<CloudRepoSource>;
      model?: string;
      effort?: string;
    }> = [];
    const archived: string[] = [];
    const streamCalls: Array<{ id: string; lastEventId?: number }> = [];
    const connections: Connection[] = [];
    const connectionSignals = new Map<number, Deferred.Deferred<Connection>>();
    const signal = (index: number) => {
      let deferred = connectionSignals.get(index);
      if (deferred === undefined) {
        deferred = Deferred.makeUnsafe<Connection>();
        connectionSignals.set(index, deferred);
      }
      return deferred;
    };
    let createCalls = 0;

    const api: ClaudeCloudApi = {
      profile: Effect.succeed({ email: "a@b.c", orgUuid: "org" }),
      createSession: (input) =>
        Effect.gen(function* () {
          const status = options.createFailures?.[createCalls] ?? 0;
          createCalls += 1;
          created.push({
            sources: input.sources,
            ...(input.model === undefined ? {} : { model: input.model }),
            ...(input.effort === undefined ? {} : { effort: input.effort }),
          });
          if (status !== 0) {
            return yield* new CloudApiError({ kind: "transport", status, detail: "refused" });
          }
          return { id: createCalls === 1 ? SESSION : `cse_${createCalls}`, sessionUrl: null };
        }),
      getSession: options.getSession ?? ((id) => Effect.succeed({ id, archived: false })),
      latestEvents: () => Effect.succeed(options.latestEvents ?? []),
      sendEvents: (id, events) =>
        options.sendFailure
          ? Effect.fail(options.sendFailure)
          : Effect.sync(() => {
              sent.push({ id, events });
            }),
      archive: (id) =>
        Effect.sync(() => {
          archived.push(id);
        }),
      streamFrames: (id, streamOptions) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const index = connections.length;
            const connection = yield* Queue.unbounded<
              CloudFrame | { readonly end: true } | { readonly fail: ClaudeCloudError }
            >();
            connections.push(connection);
            streamCalls.push({
              id,
              ...(streamOptions?.lastEventId === undefined
                ? {}
                : { lastEventId: streamOptions.lastEventId }),
            });
            yield* Deferred.succeed(signal(index), connection);
            return Stream.fromQueue(connection).pipe(
              Stream.takeWhile((item) => !("end" in item)),
              Stream.mapEffect((item) =>
                "fail" in item ? Effect.fail(item.fail) : Effect.succeed(item as CloudFrame),
              ),
            );
          }),
        ),
    };

    const adapter = yield* makeClaudeCloudAdapter(api, {
      instanceId,
      resolveRepoSource: () => Effect.succeed(options.repo ?? null),
      reconnectDelays: [Duration.zero, Duration.zero],
    });
    // The collector must be subscribed before anything publishes; a forked
    // fiber only starts once the caller yields.
    const collect = (until: (event: ProviderRuntimeEvent) => boolean) =>
      Effect.gen(function* () {
        const fiber = yield* adapter.streamEvents.pipe(
          Stream.takeUntil(until),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        return fiber;
      });
    return {
      adapter,
      sent,
      created,
      archived,
      streamCalls,
      connection: (index: number) => Deferred.await(signal(index)),
      collect,
      start: (input: { resumeCursor?: unknown; cwd?: string } = {}) =>
        adapter.startSession({
          threadId,
          provider: driver,
          providerInstanceId: instanceId,
          runtimeMode: "full-access",
          ...input,
        }),
    };
  });

const types = (events: ReadonlyArray<ProviderRuntimeEvent>) => events.map((event) => event.type);
const userMessages = (sent: ReturnType<typeof Array.prototype.slice>) =>
  (sent as Array<{ events: ReadonlyArray<CloudOutgoingEvent> }>).flatMap((entry) =>
    entry.events.filter((event) => event.eventType === "user"),
  );

it.layer(NodeServices.layer)("ClaudeCloudAdapter", (it) => {
  it.effect("starts a cloud session with the GitHub repo, model and effort", () =>
    Effect.gen(function* () {
      const h = yield* harness({ repo: { url: "https://github.com/o/r" } });
      const events = yield* h.collect((event) => event.type === "session.state.changed");
      const session = yield* h.adapter.startSession({
        threadId,
        provider: driver,
        providerInstanceId: instanceId,
        cwd: "/work/repo",
        runtimeMode: "full-access",
        modelSelection: {
          instanceId,
          model: "claude-sonnet-5",
          options: [{ id: "effort", value: "low" }],
        },
      });
      assert.deepStrictEqual(types(yield* Fiber.join(events)), [
        "session.started",
        "thread.started",
        "session.state.changed",
      ]);
      assert.strictEqual(h.created[0]?.sources[0]?.url, "https://github.com/o/r");
      assert.strictEqual(h.created[0]?.model, "claude-sonnet-5");
      assert.strictEqual(h.created[0]?.effort, "low");
      // The cwd is echoed back so the thread does not look like it changed directory.
      assert.strictEqual(session.cwd, "/work/repo");
      assert.deepStrictEqual(session.resumeCursor, { version: 1, sessionId: SESSION });
      assert.strictEqual(readClaudeCloudSessionId(session.resumeCursor), SESSION);
      // A fresh session streams from the beginning.
      yield* h.connection(0);
      assert.strictEqual(h.streamCalls[0]?.lastEventId, undefined);
    }),
  );

  it.effect("runs without a repo when the project has no GitHub remote", () =>
    Effect.gen(function* () {
      const h = yield* harness({ repo: null });
      yield* h.start({ cwd: "/work" });
      assert.deepStrictEqual(h.created[0]?.sources, []);
    }),
  );

  it.effect("retries without the repo when the cloud refuses it", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        repo: { url: "https://github.com/o/private" },
        createFailures: [400],
      });
      const warnings = yield* h.collect((event) => event.type === "runtime.warning");
      yield* h.start({ cwd: "/work" });
      assert.strictEqual(h.created.length, 2);
      assert.strictEqual(h.created[0]?.sources.length, 1);
      assert.strictEqual(h.created[1]?.sources.length, 0);
      const last = (yield* Fiber.join(warnings)).at(-1);
      assert.strictEqual(last?.type, "runtime.warning");
    }),
  );

  it.effect("sends a turn and maps text and the result, including cost", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.start();
      const events = yield* h.collect((event) => event.type === "turn.completed");
      const turn = yield* h.adapter.sendTurn({ threadId, input: "say pong", attachments: [] });
      const wire = userMessages(h.sent)[0];
      assert.strictEqual(wire?.eventType, "user");
      assert.deepStrictEqual((wire?.payload as { message: unknown }).message, {
        role: "user",
        content: "say pong",
      });
      assert.strictEqual((wire?.payload as { session_id: string }).session_id, SESSION);

      const connection = yield* h.connection(0);
      yield* Queue.offer(connection, text(1, "pong"));
      yield* Queue.offer(connection, result(2));
      const got = yield* Fiber.join(events);
      assert.deepStrictEqual(types(got), [
        "turn.started",
        "content.delta",
        "item.completed",
        "turn.completed",
      ]);
      const completed = got.at(-1);
      assert.isTrue(completed?.type === "turn.completed");
      if (completed?.type === "turn.completed") {
        assert.strictEqual(completed.turnId, turn.turnId);
        assert.strictEqual(completed.payload.state, "completed");
        assert.strictEqual(completed.payload.totalCostUsd, 0.05);
        assert.strictEqual(completed.payload.tokenUsage?.usageStatus, "complete");
      }
      const delta = got[1];
      assert.isTrue(delta?.type === "content.delta" && delta.payload.delta === "pong");
    }),
  );

  it.effect("maps tool use and tool results, and ignores the echo of our own message", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.start();
      const events = yield* h.collect((event) => event.type === "turn.completed");
      yield* h.adapter.sendTurn({ threadId, input: "list files", attachments: [] });
      const connection = yield* h.connection(0);
      yield* Queue.offer(connection, {
        _tag: "client_event",
        eventId: "echo",
        sequenceNum: 1,
        eventType: "user",
        source: "client",
        payload: { type: "user", message: { role: "user", content: "list files" } },
      });
      yield* Queue.offer(
        connection,
        assistant(2, [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }]),
      );
      yield* Queue.offer(
        connection,
        worker(3, "user", {
          type: "user",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "a.txt" }],
          },
        }),
      );
      yield* Queue.offer(connection, text(4, "done"));
      yield* Queue.offer(connection, result(5));
      const got = yield* Fiber.join(events);
      assert.deepStrictEqual(types(got), [
        "turn.started",
        "item.started",
        "content.delta",
        "item.completed",
        "content.delta",
        "item.completed",
        "turn.completed",
      ]);
      const started = got[1];
      assert.isTrue(
        started?.type === "item.started" && started.payload.itemType === "command_execution",
      );
      const output = got[2];
      assert.isTrue(
        output?.type === "content.delta" &&
          output.payload.streamKind === "command_output" &&
          output.payload.delta === "a.txt",
      );
    }),
  );

  it.effect("closes tools still running when the turn ends", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.start();
      const events = yield* h.collect((event) => event.type === "turn.completed");
      yield* h.adapter.sendTurn({ threadId, input: "go", attachments: [] });
      const connection = yield* h.connection(0);
      yield* Queue.offer(
        connection,
        assistant(1, [{ type: "tool_use", id: "toolu_9", name: "Bash", input: { command: "x" } }]),
      );
      yield* Queue.offer(connection, result(2));
      const got = yield* Fiber.join(events);
      assert.deepStrictEqual(types(got), [
        "turn.started",
        "item.started",
        "item.completed",
        "turn.completed",
      ]);
    }),
  );

  it.effect("interrupts with a control request and reports the turn as interrupted", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.start();
      const events = yield* h.collect((event) => event.type === "turn.completed");
      yield* h.adapter.sendTurn({ threadId, input: "write an essay", attachments: [] });
      yield* h.adapter.interruptTurn(threadId);
      const control = h.sent
        .flatMap((entry) => entry.events)
        .find((e) => e.eventType === "control_request");
      assert.deepStrictEqual((control?.payload as { request: unknown }).request, {
        subtype: "interrupt",
      });
      const connection = yield* h.connection(0);
      yield* Queue.offer(
        connection,
        result(2, { subtype: "error_during_execution", is_error: true, total_cost_usd: 0.01 }),
      );
      const completed = (yield* Fiber.join(events)).at(-1);
      assert.isTrue(
        completed?.type === "turn.completed" && completed.payload.state === "interrupted",
      );
    }),
  );

  it.effect("does nothing when interrupting with no turn running", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.start();
      yield* h.adapter.interruptTurn(threadId);
      assert.strictEqual(h.sent.length, 0);
    }),
  );

  it.effect("attributes results to queued turns in the order they were sent", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.start();
      const events = yield* h.adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "turn.completed"),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      const first = yield* h.adapter.sendTurn({ threadId, input: "one", attachments: [] });
      const second = yield* h.adapter.sendTurn({ threadId, input: "two", attachments: [] });
      const connection = yield* h.connection(0);
      yield* Queue.offer(connection, result(1));
      yield* Queue.offer(connection, result(2));
      const done = yield* Fiber.join(events);
      assert.deepStrictEqual(
        done.map((event) => event.turnId),
        [first.turnId, second.turnId],
      );
    }),
  );

  it.effect("fails the turn when the message cannot be delivered", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        sendFailure: new CloudApiError({ kind: "rate_limit", status: 429, detail: "slow down" }),
      });
      yield* h.start();
      const events = yield* h.collect((event) => event.type === "turn.completed");
      const error = yield* h.adapter
        .sendTurn({ threadId, input: "hi", attachments: [] })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "ProviderAdapterRequestError");
      const completed = (yield* Fiber.join(events)).at(-1);
      assert.isTrue(completed?.type === "turn.completed" && completed.payload.state === "failed");
    }),
  );

  it.effect("fails a turn the cloud reports as undeliverable", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.start();
      const events = yield* h.collect((event) => event.type === "turn.completed");
      yield* h.adapter.sendTurn({ threadId, input: "hi", attachments: [] });
      const eventId = userMessages(h.sent)[0]?.eventId ?? "";
      const connection = yield* h.connection(0);
      yield* Queue.offer(connection, {
        _tag: "delivery_update",
        eventId,
        status: "DELIVERY_STATUS_FAILED",
      });
      const completed = (yield* Fiber.join(events)).at(-1);
      assert.isTrue(completed?.type === "turn.completed" && completed.payload.state === "failed");
    }),
  );

  it.effect("rejects attachments and empty messages", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.start();
      const attachment = {
        type: "image" as const,
        id: "a",
        name: "a.png",
        mimeType: "image/png",
        sizeBytes: 1,
      };
      const withAttachment = yield* h.adapter
        .sendTurn({ threadId, input: "look", attachments: [attachment] })
        .pipe(Effect.flip);
      assert.strictEqual(withAttachment._tag, "ProviderAdapterRequestError");
      const empty = yield* h.adapter.sendTurn({ threadId, attachments: [] }).pipe(Effect.flip);
      assert.strictEqual(empty._tag, "ProviderAdapterRequestError");
      assert.strictEqual(h.sent.length, 0);
    }),
  );

  it.effect("switches the model in-session before sending the next message", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.start();
      yield* h.adapter.sendTurn({
        threadId,
        input: "hi",
        attachments: [],
        modelSelection: { instanceId, model: "claude-haiku-4-5" },
      });
      const kinds = h.sent.flatMap((entry) => entry.events).map((event) => event.eventType);
      assert.deepStrictEqual(kinds, ["control_request", "user"]);
      const request = (h.sent[0]?.events[0]?.payload as { request: Record<string, unknown> })
        .request;
      assert.deepStrictEqual(request, { subtype: "set_model", model: "claude-haiku-4-5" });
    }),
  );

  it.effect("reconnects from the last sequence without repeating events", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.start();
      const events = yield* h.collect((event) => event.type === "turn.completed");
      yield* h.adapter.sendTurn({ threadId, input: "hi", attachments: [] });
      const first = yield* h.connection(0);
      yield* Queue.offer(first, text(1, "part one"));
      yield* Queue.offer(first, { end: true });

      const second = yield* h.connection(1);
      // The server replays from before our high-water mark; only news may pass.
      yield* Queue.offer(second, text(1, "part one"));
      yield* Queue.offer(second, text(2, "part two"));
      yield* Queue.offer(second, result(3));
      const got = yield* Fiber.join(events);
      assert.strictEqual(h.streamCalls[1]?.lastEventId, 1);
      assert.deepStrictEqual(
        got
          .filter((event) => event.type === "content.delta")
          .map((event) => (event.type === "content.delta" ? event.payload.delta : "")),
        ["part one", "part two"],
      );
    }),
  );

  it.effect("fails the turn with a sign-in hint when the login stops working mid-stream", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.start();
      const events = yield* h.collect(
        (event) => event.type === "session.state.changed" && event.payload.state === "error",
      );
      yield* h.adapter.sendTurn({ threadId, input: "hi", attachments: [] });
      const connection = yield* h.connection(0);
      yield* Queue.offer(connection, {
        fail: new CloudApiError({ kind: "auth", status: 401, detail: "expired" }),
      });
      const got = yield* Fiber.join(events);
      const completed = got.find((event) => event.type === "turn.completed");
      assert.isTrue(completed?.type === "turn.completed" && completed.payload.state === "failed");
      assert.include(
        completed?.type === "turn.completed" ? (completed.payload.errorMessage ?? "") : "",
        "`claude`",
      );
      assert.isTrue(got.some((event) => event.type === "runtime.error"));
      assert.strictEqual((yield* h.adapter.listSessions())[0]?.status, "error");
    }),
  );

  it.effect("gives up and fails the turn when the connection keeps dropping", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.start();
      const events = yield* h.collect((event) => event.type === "turn.completed");
      yield* h.adapter.sendTurn({ threadId, input: "hi", attachments: [] });
      // Two reconnect delays are configured, so the third drop is final.
      for (const index of [0, 1, 2]) {
        yield* Queue.offer(yield* h.connection(index), { end: true });
      }
      const completed = (yield* Fiber.join(events)).at(-1);
      assert.isTrue(completed?.type === "turn.completed" && completed.payload.state === "failed");
    }),
  );

  it.effect("re-attaches to a stored session and skips what it already saw", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        latestEvents: [
          { sequenceNum: 40, eventType: "result", source: "worker" },
          { sequenceNum: 39, eventType: "assistant", source: "worker" },
          { sequenceNum: 38, eventType: "user", source: "client" },
        ],
      });
      const session = yield* h.start({ resumeCursor: { version: 1, sessionId: "cse_old" } });
      assert.strictEqual(h.created.length, 0);
      assert.deepStrictEqual(session.resumeCursor, { version: 1, sessionId: "cse_old" });
      yield* h.connection(0);
      assert.strictEqual(h.streamCalls[0]?.lastEventId, 40);
    }),
  );

  it.effect("swallows the result of a turn that was still running before a restart", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        latestEvents: [
          { sequenceNum: 12, eventType: "assistant", source: "worker" },
          { sequenceNum: 11, eventType: "user", source: "client" },
          { sequenceNum: 10, eventType: "result", source: "worker" },
        ],
      });
      yield* h.start({ resumeCursor: { version: 1, sessionId: "cse_old" } });
      const events = yield* h.collect((event) => event.type === "turn.completed");
      const turn = yield* h.adapter.sendTurn({ threadId, input: "next", attachments: [] });
      const connection = yield* h.connection(0);
      // The old turn finishes first; it must not complete the new one.
      yield* Queue.offer(connection, text(13, "late reply to the old turn"));
      yield* Queue.offer(connection, result(14));
      yield* Queue.offer(connection, text(15, "reply to the new turn"));
      yield* Queue.offer(connection, result(16));
      const got = yield* Fiber.join(events);
      assert.deepStrictEqual(types(got), [
        "turn.started",
        "content.delta",
        "item.completed",
        "turn.completed",
      ]);
      const delta = got[1];
      assert.isTrue(
        delta?.type === "content.delta" && delta.payload.delta === "reply to the new turn",
      );
      assert.strictEqual(got.at(-1)?.turnId, turn.turnId);
    }),
  );

  it.effect("starts a new session, with a warning, when the stored one is gone", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        getSession: () =>
          Effect.fail(new CloudApiError({ kind: "not_found", status: 404, detail: "gone" })),
      });
      const warnings = yield* h.collect((event) => event.type === "runtime.warning");
      const session = yield* h.start({ resumeCursor: { version: 1, sessionId: "cse_gone" } });
      assert.strictEqual(h.created.length, 1);
      assert.deepStrictEqual(session.resumeCursor, { version: 1, sessionId: SESSION });
      assert.isTrue((yield* Fiber.join(warnings)).length > 0);
    }),
  );

  it.effect("treats an archived stored session as gone", () =>
    Effect.gen(function* () {
      const h = yield* harness({
        getSession: (id) => Effect.succeed({ id, archived: true }),
      });
      yield* h.start({ resumeCursor: { version: 1, sessionId: "cse_archived" } });
      assert.strictEqual(h.created.length, 1);
    }),
  );

  it.effect("stopping detaches without archiving; releasing the thread archives it", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const session = yield* h.start();
      yield* h.adapter.stopSession(threadId);
      assert.deepStrictEqual(h.archived, []);
      assert.isFalse(yield* h.adapter.hasSession(threadId));

      // After a stop only the stored cursor knows the session.
      const release = h.adapter.releaseThread;
      if (release === undefined) return assert.fail("the adapter should release threads");
      yield* release({ threadId, resumeCursor: session.resumeCursor });
      assert.deepStrictEqual(h.archived, [SESSION]);
    }),
  );

  it.effect("emits session.exited once when stopping", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.start();
      const events = yield* h.collect((event) => event.type === "session.exited");
      yield* h.adapter.stopSession(threadId);
      yield* h.adapter.stopSession(threadId);
      assert.strictEqual((yield* Fiber.join(events)).length, 1);
    }),
  );

  it.effect("declares what it cannot do", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.start();
      assert.strictEqual(h.adapter.capabilities.usesLocalWorkspace, false);
      assert.strictEqual(h.adapter.capabilities.supportsConversationRollback, false);
      const rollback = yield* h.adapter.rollbackThread(threadId, 1).pipe(Effect.flip);
      assert.strictEqual(rollback._tag, "ProviderAdapterRequestError");
      assert.isUndefined(h.adapter.mcp);
      assert.isUndefined(h.adapter.compaction);
    }),
  );
});

it.layer(NodeServices.layer)("githubRepoSourceFromIdentity", (it) => {
  it.effect("offers only GitHub remotes", () =>
    Effect.sync(() => {
      assert.deepStrictEqual(
        githubRepoSourceFromIdentity({ provider: "github", owner: "o", name: "r" }),
        { url: "https://github.com/o/r" },
      );
      assert.isNull(githubRepoSourceFromIdentity({ provider: "gitlab", owner: "o", name: "r" }));
      assert.isNull(githubRepoSourceFromIdentity({ provider: "github", owner: "o" }));
      assert.isNull(githubRepoSourceFromIdentity(null));
    }),
  );
});
