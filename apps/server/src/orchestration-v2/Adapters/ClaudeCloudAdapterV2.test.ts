import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import {
  ClaudeCloudApiError,
  ClaudeCloudSignInError,
  type ClaudeCloudApi,
  type ClaudeCloudError,
  type CloudEventSummary,
  type CloudFrame,
  type CloudRepoSource,
} from "@t3tools/provider-claude-cloud/server";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { makeClaudeCloudAdapterV2 } from "./ClaudeCloudAdapterV2.ts";

const DRIVER = ProviderDriverKind.make("claudeCloud");
const INSTANCE_ID = ProviderInstanceId.make("claudeCloud");
const THREAD_ID = ThreadId.make("thread-cloud-test");
const SESSION_ID = ProviderSessionId.make("session-cloud-test");
const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/workspace/project",
});
const selection = (options: ModelSelection["options"] = []): ModelSelection => ({
  instanceId: INSTANCE_ID,
  model: "claude-sonnet-4-6",
  ...(options.length === 0 ? {} : { options }),
});

interface Call {
  readonly method: keyof ClaudeCloudApi;
  readonly args: ReadonlyArray<unknown>;
}

type Reply<A> = Effect.Effect<A, ClaudeCloudError>;

/** An API fake at the HTTP/SSE boundary: each stream is a queue the test feeds. */
const makeFakeApi = Effect.fnUntraced(function* () {
  const calls: Array<Call> = [];
  const callQueue = yield* Queue.unbounded<Call>();
  const streams: Array<Queue.Queue<CloudFrame, ClaudeCloudError | Cause.Done>> = [];
  const streamOpened = yield* Queue.unbounded<number>();
  const replies = new Map<string, Array<Reply<unknown>>>();
  const record = (method: Call["method"], ...args: ReadonlyArray<unknown>) => {
    const call = { method, args };
    calls.push(call);
    Queue.offerUnsafe(callQueue, call);
  };
  const reply = <A>(method: string, fallback: A): Reply<A> =>
    (replies.get(method)?.shift() as Reply<A> | undefined) ?? Effect.succeed(fallback);
  let created = 0;
  const api: ClaudeCloudApi = {
    profile: Effect.succeed({ email: "dev@example.com", orgUuid: "org" }),
    createSession: (input) =>
      Effect.suspend(() => {
        record("createSession", input);
        created += 1;
        return reply("createSession", { id: `cloud-session-${created}`, sessionUrl: null });
      }),
    getSession: (id) =>
      Effect.suspend(() => {
        record("getSession", id);
        return reply("getSession", { id, archived: false });
      }),
    latestEvents: (id, limit) =>
      Effect.suspend(() => {
        record("latestEvents", id, limit);
        return reply<ReadonlyArray<CloudEventSummary>>("latestEvents", []);
      }),
    sendEvents: (id, events) =>
      Effect.suspend(() => {
        record("sendEvents", id, events);
        return reply("sendEvents", undefined);
      }),
    archive: (id) =>
      Effect.suspend(() => {
        record("archive", id);
        return reply("archive", undefined);
      }),
    streamFrames: (id, options) =>
      Stream.unwrap(
        Effect.gen(function* () {
          record("streamFrames", id, options);
          const queue = yield* Queue.unbounded<CloudFrame, ClaudeCloudError | Cause.Done>();
          streams.push(queue);
          yield* Queue.offer(streamOpened, streams.length - 1);
          return Stream.fromQueue(queue);
        }),
      ),
  };
  return {
    api,
    calls,
    queueReply: (method: string, value: Reply<unknown>) => {
      replies.set(method, [...(replies.get(method) ?? []), value]);
    },
    takeCall: Effect.fnUntraced(function* (method: Call["method"]) {
      while (true) {
        const call = yield* Queue.take(callQueue);
        if (call.method === method) return call;
      }
    }),
    awaitStream: Queue.take(streamOpened),
    push: (frames: ReadonlyArray<CloudFrame>) =>
      Effect.suspend(() => Queue.offerAll(streams.at(-1)!, frames)),
    dropStream: (error: ClaudeCloudError) =>
      Effect.suspend(() => Queue.fail(streams.at(-1)!, error)),
  };
});

type FakeApi = Effect.Success<ReturnType<typeof makeFakeApi>>;

const event = (
  sequenceNum: number,
  eventType: string,
  payload: Record<string, unknown>,
  source = "worker",
): CloudFrame => ({
  _tag: "sessionEvent",
  eventId: `event-${sequenceNum}`,
  sequenceNum,
  eventType,
  source,
  payload,
});
const assistantText = (sequenceNum: number, text: string) =>
  event(sequenceNum, "assistant", {
    type: "assistant",
    parent_tool_use_id: null,
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
const success = (sequenceNum: number, extra: Record<string, unknown> = {}) =>
  event(sequenceNum, "result", {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "",
    total_cost_usd: 0.0123,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 },
    ...extra,
  });

const makeHarness = Effect.fnUntraced(function* (
  fake: FakeApi,
  options: {
    readonly repo?: CloudRepoSource | null;
    readonly modelSelection?: ModelSelection;
    readonly reconnectDelays?: ReadonlyArray<Duration.Input>;
  } = {},
) {
  const adapter = yield* makeClaudeCloudAdapterV2({
    instanceId: INSTANCE_ID,
    api: fake.api,
    defaultCwd: "/workspace/project",
    resolveRepoSource: () => Effect.succeed(options.repo ?? null),
    ...(options.reconnectDelays === undefined ? {} : { reconnectDelays: options.reconnectDelays }),
  });
  const sessionScope = yield* Scope.make();
  const runtime = yield* adapter
    .openSession({
      threadId: THREAD_ID,
      providerSessionId: SESSION_ID,
      modelSelection: options.modelSelection ?? selection(),
      runtimePolicy,
    })
    .pipe(Scope.provide(sessionScope));
  const emitted = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  const allEvents: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
  yield* runtime.events.pipe(
    Stream.runForEach((next) =>
      Effect.sync(() => {
        allEvents.push(next);
        Queue.offerUnsafe(emitted, next);
      }),
    ),
    Effect.forkIn(sessionScope),
  );
  const takeEvent = Effect.fnUntraced(function* <
    T extends ProviderAdapter.ProviderAdapterV2Event["type"],
  >(
    type: T,
    predicate: (
      event: Extract<ProviderAdapter.ProviderAdapterV2Event, { type: T }>,
    ) => boolean = () => true,
  ) {
    while (true) {
      const next = yield* Queue.take(emitted);
      if (
        next.type === type &&
        predicate(next as Extract<ProviderAdapter.ProviderAdapterV2Event, { type: T }>)
      ) {
        return next as Extract<ProviderAdapter.ProviderAdapterV2Event, { type: T }>;
      }
    }
  });
  return { adapter, runtime, sessionScope, allEvents, takeEvent };
});

type Harness = Effect.Success<ReturnType<typeof makeHarness>>;

const turnInput = Effect.fnUntraced(function* (
  providerThread: OrchestrationV2ProviderThread,
  runOrdinal = 1,
  overrides: { readonly text?: string; readonly modelSelection?: ModelSelection } = {},
): Effect.fn.Return<ProviderAdapter.ProviderAdapterV2TurnInput> {
  const now = yield* DateTime.now;
  const modelSelection = overrides.modelSelection ?? selection();
  const appThread: OrchestrationV2AppThread = {
    id: THREAD_ID,
    projectId: ProjectId.make("project-cloud-test"),
    title: "Cloud test",
    createdBy: "user",
    creationSource: "web",
    providerInstanceId: INSTANCE_ID,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: providerThread.id,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: THREAD_ID },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  return {
    appThread,
    threadId: THREAD_ID,
    runId: RunId.make(`run-${runOrdinal}`),
    runOrdinal,
    providerTurnOrdinal: runOrdinal,
    attemptId: RunAttemptId.make(`attempt-${runOrdinal}`),
    rootNodeId: NodeId.make(`root-${runOrdinal}`),
    providerThread,
    message: {
      messageId: MessageId.make(`message-${runOrdinal}`),
      text: overrides.text ?? "Reply with exactly: pong",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
    },
    modelSelection,
    runtimePolicy,
  };
});

const storedThread = Effect.fnUntraced(function* (nativeId: string | null) {
  const now = yield* DateTime.now;
  return {
    id: ProviderThreadId.make("provider-thread-cloud"),
    driver: DRIVER,
    providerInstanceId: INSTANCE_ID,
    providerSessionId: SESSION_ID,
    appThreadId: THREAD_ID,
    ownerNodeId: null,
    nativeThreadRef: nativeId === null ? null : { driver: DRIVER, nativeId, strength: "strong" },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  } satisfies OrchestrationV2ProviderThread;
});

const ensure = (harness: Harness) =>
  harness.runtime.ensureThread({
    threadId: THREAD_ID,
    title: "Cloud test",
    modelSelection: selection(),
    runtimePolicy,
  });

/** The user message a turn sent, read back from the fake's recorded call. */
const sentUserEvent = Effect.fnUntraced(function* (fake: FakeApi) {
  while (true) {
    const call = yield* fake.takeCall("sendEvents");
    const [sent] = call.args[1] as ReadonlyArray<{
      readonly eventId: string;
      readonly eventType: string;
      readonly payload: Record<string, unknown>;
    }>;
    if (sent?.eventType === "user") return sent;
  }
});

const terminalOf = (harness: Harness) => harness.takeEvent("turn.terminal");

const testLayer = IdAllocator.layer;
const isEnsureThreadError = Schema.is(ProviderAdapter.ProviderAdapterEnsureThreadError);

describe("ClaudeCloudAdapterV2", () => {
  it.effect("maps a reply, ignores its own echo, and settles with the result's usage", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeApi();
      const harness = yield* makeHarness(fake);
      const providerThread = yield* ensure(harness);
      assert.strictEqual(providerThread.nativeThreadRef?.nativeId, "cloud-session-1");
      yield* fake.awaitStream;
      yield* harness.runtime.startTurn(yield* turnInput(providerThread));
      const sent = yield* sentUserEvent(fake);
      assert.deepStrictEqual(sent.payload.message, {
        role: "user",
        content: "Reply with exactly: pong",
      });
      yield* fake.push([
        // The cloud echoes our own message back; it must not become output.
        event(1, "user", { type: "user", message: { role: "user", content: "x" } }, "client"),
        assistantText(2, "pong"),
        success(3),
      ]);
      const terminal = yield* terminalOf(harness);
      assert.strictEqual(terminal.status, "completed");
      const items = harness.allEvents.flatMap((next) =>
        next.type === "turn_item.updated" ? [next.turnItem] : [],
      );
      assert.deepStrictEqual(
        items.map((item) => (item.type === "assistant_message" ? item.text : item.type)),
        ["pong"],
      );
      const settled = harness.allEvents.findLast(
        (next) => next.type === "provider_turn.updated" && next.providerTurn.status !== "running",
      );
      assert.strictEqual(settled?.type, "provider_turn.updated");
      if (settled?.type === "provider_turn.updated") {
        assert.strictEqual(settled.providerTurn.tokenUsage?.inputTokens, 12);
        assert.strictEqual(settled.providerTurn.tokenUsage?.outputTokens, 5);
        assert.strictEqual(settled.providerTurn.turnTokenUsage?.usageStatus, "complete");
      }
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("shows a tool call running, then completed with its output", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeApi();
      const harness = yield* makeHarness(fake);
      const providerThread = yield* ensure(harness);
      yield* fake.awaitStream;
      yield* harness.runtime.startTurn(yield* turnInput(providerThread));
      yield* sentUserEvent(fake);
      yield* fake.push([
        event(1, "assistant", {
          type: "assistant",
          parent_tool_use_id: null,
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }],
          },
        }),
      ]);
      const running = yield* harness.takeEvent("turn_item.updated");
      assert.strictEqual(running.turnItem.type, "command_execution");
      assert.strictEqual(running.turnItem.status, "running");
      yield* fake.push([
        event(2, "user", {
          type: "user",
          parent_tool_use_id: null,
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "README.md" }],
          },
        }),
        // Subagent traffic is not mapped yet and must not leak into the root turn.
        event(3, "assistant", {
          type: "assistant",
          parent_tool_use_id: "toolu_task",
          message: { role: "assistant", content: [{ type: "text", text: "from a subagent" }] },
        }),
        success(4),
      ]);
      const completed = yield* harness.takeEvent("turn_item.updated");
      assert.strictEqual(completed.turnItem.status, "completed");
      assert.strictEqual(
        completed.turnItem.type === "command_execution" ? completed.turnItem.output : undefined,
        "README.md",
      );
      assert.strictEqual((yield* terminalOf(harness)).status, "completed");
      assert.isFalse(
        harness.allEvents.some(
          (next) =>
            next.type === "turn_item.updated" &&
            next.turnItem.type === "assistant_message" &&
            next.turnItem.text === "from a subagent",
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("interrupts with a control request and settles the error result as interrupted", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeApi();
      const harness = yield* makeHarness(fake);
      const providerThread = yield* ensure(harness);
      yield* fake.awaitStream;
      yield* harness.runtime.startTurn(yield* turnInput(providerThread));
      yield* sentUserEvent(fake);
      const running = yield* harness.takeEvent(
        "provider_turn.updated",
        (next) => next.providerTurn.status === "running",
      );
      yield* harness.runtime.interruptTurn({
        providerThread,
        providerTurnId: running.providerTurn.id,
      });
      const control = yield* fake.takeCall("sendEvents");
      assert.deepStrictEqual(
        (control.args[1] as ReadonlyArray<{ payload: { request: unknown } }>)[0]?.payload.request,
        { subtype: "interrupt" },
      );
      yield* fake.push([
        event(1, "result", {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: [],
        }),
      ]);
      const terminal = yield* terminalOf(harness);
      assert.strictEqual(terminal.status, "interrupted");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("does not let a turn still running from before a restart complete the next one", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeApi();
      // Newest first: our last message has no result yet, so the cloud is still on it.
      fake.queueReply(
        "latestEvents",
        Effect.succeed([
          { sequenceNum: 10, eventType: "user", source: "client" },
          { sequenceNum: 9, eventType: "result", source: "worker" },
        ]),
      );
      const harness = yield* makeHarness(fake);
      const resumed = yield* harness.runtime.resumeThread({
        providerThread: yield* storedThread("cloud-session-old"),
      });
      const stream = yield* fake.takeCall("streamFrames");
      assert.deepStrictEqual(stream.args, ["cloud-session-old", { lastEventId: 10 }]);
      yield* fake.awaitStream;
      yield* harness.runtime.startTurn(yield* turnInput(resumed));
      yield* sentUserEvent(fake);
      yield* fake.push([assistantText(11, "old reply"), success(12)]);
      yield* fake.push([assistantText(14, "new reply"), success(15)]);
      const terminal = yield* terminalOf(harness);
      assert.strictEqual(terminal.status, "completed");
      assert.deepStrictEqual(
        harness.allEvents.flatMap((next) =>
          next.type === "turn_item.updated" && next.turnItem.type === "assistant_message"
            ? [next.turnItem.text]
            : [],
        ),
        ["new reply"],
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.live("reconnects a dropped stream from the last sequence without duplicating output", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeApi();
      const harness = yield* makeHarness(fake, { reconnectDelays: ["1 millis"] });
      const providerThread = yield* ensure(harness);
      yield* fake.awaitStream;
      yield* harness.runtime.startTurn(yield* turnInput(providerThread));
      yield* sentUserEvent(fake);
      yield* fake.push([assistantText(1, "first")]);
      yield* harness.takeEvent("turn_item.updated");
      yield* fake.dropStream(new ClaudeCloudApiError({ kind: "transport", detail: "reset" }));
      yield* fake.awaitStream;
      const reopened = fake.calls.findLast((call) => call.method === "streamFrames");
      assert.deepStrictEqual(reopened?.args, ["cloud-session-1", { lastEventId: 1 }]);
      yield* fake.push([assistantText(1, "first"), assistantText(2, "second"), success(3)]);
      assert.strictEqual((yield* terminalOf(harness)).status, "completed");
      assert.deepStrictEqual(
        harness.allEvents.flatMap((next) =>
          next.type === "turn_item.updated" && next.turnItem.type === "assistant_message"
            ? [next.turnItem.text]
            : [],
        ),
        ["first", "second"],
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("fails the turn with the sign-in message when the login is unusable", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeApi();
      const signIn = new ClaudeCloudSignInError({ reason: "expired" });
      // Re-attaching after a restart hits the expired login: the session must
      // be kept, and the turn must say why it cannot run.
      fake.queueReply("getSession", Effect.fail(signIn));
      fake.queueReply("getSession", Effect.fail(signIn));
      const harness = yield* makeHarness(fake);
      const resumed = yield* harness.runtime.resumeThread({
        providerThread: yield* storedThread("cloud-session-old"),
      });
      assert.strictEqual(resumed.nativeThreadRef?.nativeId, "cloud-session-old");
      yield* harness.runtime.startTurn(yield* turnInput(resumed));
      const terminal = yield* terminalOf(harness);
      assert.strictEqual(terminal.status, "failed");
      if (terminal.status === "failed") {
        assert.strictEqual(terminal.failure.class, "permission_error");
        assert.strictEqual(terminal.failure.message, signIn.message);
      }
      assert.isFalse(fake.calls.some((call) => call.method === "createSession"));

      // A new thread reports it through the thread-load failure instead.
      const fresh = yield* makeFakeApi();
      fresh.queueReply("createSession", Effect.fail(signIn));
      const freshHarness = yield* makeHarness(fresh);
      const exit = yield* Effect.exit(ensure(freshHarness));
      assert.isTrue(Exit.isFailure(exit));
      const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
      assert.strictEqual(
        isEnsureThreadError(error)
          ? (error.cause as Error).message
          : undefined,
        signIn.message,
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("retries without the repository when the cloud cannot reach it, and says so", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeApi();
      fake.queueReply(
        "createSession",
        Effect.fail(new ClaudeCloudApiError({ kind: "transport", status: 400, detail: "repo" })),
      );
      const harness = yield* makeHarness(fake, {
        repo: { url: "https://github.com/acme/private" },
      });
      const providerThread = yield* ensure(harness);
      const creates = fake.calls.filter((call) => call.method === "createSession");
      assert.deepStrictEqual(
        creates.map((call) => (call.args[0] as { sources: unknown }).sources),
        [[{ url: "https://github.com/acme/private" }], []],
      );
      yield* fake.awaitStream;
      yield* harness.runtime.startTurn(yield* turnInput(providerThread));
      const notice = yield* harness.takeEvent(
        "turn_item.updated",
        (next) => next.turnItem.type === "system_notice",
      );
      assert.include(
        notice.turnItem.type === "system_notice" ? notice.turnItem.message : "",
        "could not access this repository",
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("archives the cloud session only when the thread is released, never on close", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeApi();
      const harness = yield* makeHarness(fake);
      yield* ensure(harness);
      yield* Scope.close(harness.sessionScope, Exit.void);
      assert.isFalse(fake.calls.some((call) => call.method === "archive"));

      yield* harness.adapter.releaseNativeThread!({ nativeThreadId: "cloud-session-1" });
      fake.queueReply(
        "archive",
        Effect.fail(new ClaudeCloudApiError({ kind: "notFound", status: 404, detail: "gone" })),
      );
      // Already gone counts as archived.
      yield* harness.adapter.releaseNativeThread!({ nativeThreadId: "cloud-session-1" });
      assert.deepStrictEqual(
        fake.calls.filter((call) => call.method === "archive").map((call) => call.args[0]),
        ["cloud-session-1", "cloud-session-1"],
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("rejects attachments on the turn instead of dropping them", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeApi();
      const harness = yield* makeHarness(fake);
      const providerThread = yield* ensure(harness);
      const input = yield* turnInput(providerThread);
      yield* harness.runtime.startTurn({
        ...input,
        message: {
          ...input.message,
          attachments: [
            { type: "file", id: "file_1", name: "a.txt", mimeType: "text/plain", sizeBytes: 1 },
          ],
        },
      });
      const terminal = yield* terminalOf(harness);
      assert.strictEqual(
        terminal.status === "failed" ? terminal.failure.class : null,
        "validation_error",
      );
      assert.isFalse(fake.calls.some((call) => call.method === "sendEvents"));
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("forwards only API effort levels and switches models with set_model", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeApi();
      const harness = yield* makeHarness(fake);
      // Ultracode is a Claude Code orchestration mode, not an API effort level.
      yield* harness.runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: {
          instanceId: INSTANCE_ID,
          model: "claude-fable-5-1",
          options: [{ id: "effort", value: "ultracode" }],
        },
        runtimePolicy,
      });
      const created = yield* fake.takeCall("createSession");
      assert.isUndefined((created.args[0] as { effort?: string }).effort);

      const other = yield* makeFakeApi();
      const otherHarness = yield* makeHarness(other);
      const providerThread = yield* otherHarness.runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: selection([{ id: "effort", value: "high" }]),
        runtimePolicy,
      });
      const otherCreated = yield* other.takeCall("createSession");
      assert.strictEqual((otherCreated.args[0] as { effort?: string }).effort, "high");
      yield* other.awaitStream;
      yield* otherHarness.runtime.startTurn(
        yield* turnInput(providerThread, 1, {
          modelSelection: { instanceId: INSTANCE_ID, model: "claude-opus-4-6" },
        }),
      );
      const control = yield* other.takeCall("sendEvents");
      assert.deepStrictEqual(
        (control.args[1] as ReadonlyArray<{ payload: { request: unknown } }>)[0]?.payload.request,
        // The worker is Claude Code, so it takes the CLI's context-window suffix.
        { subtype: "set_model", model: "claude-opus-4-6[1m]" },
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("fails a resume of a gone session so the thread moves to a new one", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeApi();
      fake.queueReply("getSession", Effect.succeed({ id: "cloud-session-old", archived: true }));
      const harness = yield* makeHarness(fake);
      const stored = yield* storedThread("cloud-session-old");
      const exit = yield* Effect.exit(harness.runtime.resumeThread({ providerThread: stored }));
      assert.isTrue(Exit.isFailure(exit));
      const replacement = yield* harness.runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: selection(),
        runtimePolicy,
        existingProviderThread: { ...stored, nativeThreadRef: null },
      });
      assert.strictEqual(replacement.id, stored.id);
      assert.strictEqual(replacement.nativeThreadRef?.nativeId, "cloud-session-1");
      yield* fake.awaitStream;
      yield* harness.runtime.startTurn(yield* turnInput(replacement));
      const notice = yield* harness.takeEvent(
        "turn_item.updated",
        (next) => next.turnItem.type === "system_notice",
      );
      assert.include(
        notice.turnItem.type === "system_notice" ? notice.turnItem.message : "",
        "previous Claude Cloud session is gone",
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});
