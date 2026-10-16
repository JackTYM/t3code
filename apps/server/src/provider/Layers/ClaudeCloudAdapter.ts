/**
 * ClaudeCloudAdapter - drives a Claude Code cloud session (claude.ai/code)
 * over its private HTTP/SSE API and maps it to canonical runtime events.
 *
 * The agent runs in Anthropic's sandbox, not in the thread's cwd. Worker
 * messages are Claude SDK message JSON, so the mapping reuses the pure helpers
 * exported by ClaudeAdapter instead of reimplementing them.
 *
 * @module ClaudeCloudAdapter
 */
import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  EventId,
  type ProviderInstanceId,
  ProviderDriverKind,
  type RepositoryIdentity,
  ProviderItemId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  RuntimeItemId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import {
  type ClaudeCloudApi,
  type ClaudeCloudError,
  type CloudFrame,
  type CloudRepoSource,
} from "../claudeCloudApi.ts";
import { BUNDLED_CLAUDE_MODEL_CATALOG } from "../ClaudeModelCatalog.ts";
import {
  resolveClaudeCatalogApiModelId,
  resolveClaudeCatalogEffort,
  resolveClaudeModelSlug,
} from "../ClaudeModelCatalog.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import {
  classifyToolItemType,
  normalizeClaudeTurnTokenUsage,
  resultOutcome,
  summarizeToolRequest,
  titleForTool,
  toolResultBlocksFromUserMessage,
  toolResultStreamKind,
} from "./ClaudeAdapter.ts";

const PROVIDER = ProviderDriverKind.make("claudeCloud");
const DEFAULT_TITLE = "T3 Code";
/** Recent events inspected when re-attaching to tell whether a turn is mid-flight. */
const RESUME_EVENT_WINDOW = 50;
const SIGN_IN_HINT = "Claude login expired. Run `claude` to sign in.";
/**
 * Effort levels the cloud accepts. The catalog also lists Claude Code modes
 * (`ultracode`, `ultrathink`) that are not API effort levels.
 */
const CLOUD_EFFORT_LEVELS: ReadonlySet<string> = new Set(["low", "medium", "high", "xhigh", "max"]);
/** Back-off between reconnects of a dropped stream; running out fails the session. */
const DEFAULT_RECONNECT_DELAYS: ReadonlyArray<Duration.Duration> = [
  Duration.seconds(1),
  Duration.seconds(2),
  Duration.seconds(4),
  Duration.seconds(8),
  Duration.seconds(16),
  Duration.seconds(30),
  Duration.seconds(30),
  Duration.seconds(30),
];

export type ClaudeCloudAdapterShape = ProviderAdapterShape<ProviderAdapterError>;

export interface ClaudeCloudAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  /** The repo to attach to a new cloud session, or null to run without one. */
  readonly resolveRepoSource: (cwd: string | undefined) => Effect.Effect<CloudRepoSource | null>;
  readonly reconnectDelays?: ReadonlyArray<Duration.Duration>;
}

const CloudCursor = Schema.Struct({ version: Schema.Literal(1), sessionId: Schema.String });
const decodeCloudCursor = Schema.decodeUnknownOption(CloudCursor);

/**
 * The GitHub repo to attach, from a project's remote identity. Other hosts
 * are not offered: the cloud clones through the Claude GitHub app.
 */
export const githubRepoSourceFromIdentity = (
  identity: Pick<RepositoryIdentity, "provider" | "owner" | "name"> | null,
): CloudRepoSource | null =>
  identity?.provider === "github" && identity.owner && identity.name
    ? { url: `https://github.com/${identity.owner}/${identity.name}` }
    : null;

export const makeClaudeCloudCursor = (sessionId: string) => ({ version: 1 as const, sessionId });

/** The cloud session id a stored resume cursor points at, if it is one of ours. */
export const readClaudeCloudSessionId = (cursor: unknown): string | null =>
  Option.match(decodeCloudCursor(cursor), {
    onNone: () => null,
    onSome: (decoded) => (decoded.sessionId.length > 0 ? decoded.sessionId : null),
  });

interface ToolInFlight {
  readonly itemId: string;
  readonly itemType: ReturnType<typeof classifyToolItemType>;
  readonly toolName: string;
  readonly title: string;
  readonly detail: string;
  readonly input: Record<string, unknown>;
}

/** One sent message and the turn the worker's output belongs to, in send order. */
interface PendingTurn {
  readonly turnId: TurnId;
  readonly eventId: string;
  /** Output of a turn started before a restart is not ours to attribute; swallow it. */
  readonly orphan: boolean;
  interruptRequested: boolean;
  readonly tools: Map<string, ToolInFlight>;
}

interface CloudSessionContext {
  readonly threadId: ThreadId;
  readonly cloudSessionId: string;
  readonly scope: Scope.Closeable;
  readonly queue: PendingTurn[];
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  session: ProviderSession;
  model: string | undefined;
  /** Highest worker/client sequence already handled; replays at or below it are skipped. */
  lastSeq: number;
  closed: boolean;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

export const makeClaudeCloudAdapter = Effect.fn("makeClaudeCloudAdapter")(function* (
  api: ClaudeCloudApi,
  options: ClaudeCloudAdapterOptions,
) {
  const crypto = yield* Crypto.Crypto;
  const reconnectDelays = options.reconnectDelays ?? DEFAULT_RECONNECT_DELAYS;
  const sessions = new Map<ThreadId, CloudSessionContext>();
  const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  // Identifier generation failing is not something a caller can act on.
  const randomUUID = crypto.randomUUIDv4.pipe(Effect.orDie);
  const offer = (event: ProviderRuntimeEvent) =>
    PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

  /** Fields every event carries. */
  const eventBase = (threadId: ThreadId) =>
    Effect.gen(function* () {
      return {
        eventId: EventId.make(yield* randomUUID),
        createdAt: yield* nowIso,
        provider: PROVIDER,
        providerInstanceId: options.instanceId,
        threadId,
      };
    });

  const requestError = (method: string, detail: string, cause?: unknown) =>
    new ProviderAdapterRequestError({
      provider: PROVIDER,
      method,
      detail,
      ...(cause === undefined ? {} : { cause }),
    });
  const mapCloudError = (method: string) => (error: ClaudeCloudError) =>
    requestError(method, error.message, error);

  const requireSession = (threadId: ThreadId) => {
    const ctx = sessions.get(threadId);
    return ctx === undefined || ctx.closed
      ? Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }))
      : Effect.succeed(ctx);
  };

  const setSession = (ctx: CloudSessionContext, patch: Partial<ProviderSession>) =>
    Effect.map(nowIso, (updatedAt) => {
      ctx.session = { ...ctx.session, ...patch, updatedAt };
    });

  const emitWarning = (ctx: CloudSessionContext, message: string) =>
    Effect.gen(function* () {
      yield* offer({
        type: "runtime.warning",
        ...(yield* eventBase(ctx.threadId)),
        payload: { message },
      });
    });

  // ── Turn lifecycle ─────────────────────────────────────────────────

  const completeTools = (
    ctx: CloudSessionContext,
    turn: PendingTurn,
    status: "completed" | "failed",
  ) =>
    Effect.gen(function* () {
      for (const tool of turn.tools.values()) {
        yield* offer({
          type: "item.completed",
          ...(yield* eventBase(ctx.threadId)),
          turnId: turn.turnId,
          itemId: RuntimeItemId.make(tool.itemId),
          payload: {
            itemType: tool.itemType,
            status,
            title: tool.title,
            ...(tool.detail ? { detail: tool.detail } : {}),
            data: { toolName: tool.toolName, input: tool.input },
          },
          providerRefs: { providerItemId: ProviderItemId.make(tool.itemId) },
        });
      }
      turn.tools.clear();
    });

  const finishTurn = (
    ctx: CloudSessionContext,
    turn: PendingTurn,
    completion: {
      readonly state: "completed" | "failed" | "interrupted" | "cancelled";
      readonly errorMessage?: string | undefined;
      readonly result?: SDKResultMessage | undefined;
    },
  ) =>
    Effect.gen(function* () {
      yield* completeTools(ctx, turn, completion.state === "completed" ? "completed" : "failed");
      ctx.turns.push({ id: turn.turnId, items: [] });
      const { result } = completion;
      yield* offer({
        type: "turn.completed",
        ...(yield* eventBase(ctx.threadId)),
        turnId: turn.turnId,
        payload: {
          state: completion.state,
          ...(result?.stop_reason !== undefined ? { stopReason: result.stop_reason } : {}),
          ...(result?.usage ? { usage: result.usage } : {}),
          ...(result?.modelUsage ? { modelUsage: result.modelUsage } : {}),
          ...(typeof result?.total_cost_usd === "number"
            ? { totalCostUsd: result.total_cost_usd }
            : {}),
          ...(completion.errorMessage ? { errorMessage: completion.errorMessage } : {}),
          tokenUsage: normalizeClaudeTurnTokenUsage(result, false, completion.state),
        },
      });
      if (ctx.queue.length === 0) {
        yield* setSession(ctx, {
          status: "ready",
          activeTurnId: undefined,
          ...(completion.state === "failed" && completion.errorMessage
            ? { lastError: completion.errorMessage }
            : {}),
        });
        yield* offer({
          type: "session.state.changed",
          ...(yield* eventBase(ctx.threadId)),
          payload: { state: "ready" },
        });
      }
    });

  const failActiveTurns = (ctx: CloudSessionContext, message: string) =>
    Effect.gen(function* () {
      const failed = ctx.queue.splice(0, ctx.queue.length);
      for (const turn of failed) {
        if (turn.orphan) continue;
        yield* finishTurn(ctx, turn, { state: "failed", errorMessage: message });
      }
    });

  const handleResult = (ctx: CloudSessionContext, payload: Record<string, unknown>) =>
    Effect.gen(function* () {
      const turn = ctx.queue.shift();
      // A result with nothing queued is the sandbox settling, not a turn of ours.
      if (turn === undefined || turn.orphan) return;
      const result = payload as unknown as SDKResultMessage;
      // A cloud interrupt ends the turn with a plain error_during_execution
      // result, with none of the terminal_reason hints the local CLI adds.
      const outcome =
        turn.interruptRequested && result.subtype === "error_during_execution"
          ? { status: "interrupted" as const, errorMessage: undefined }
          : resultOutcome(result);
      yield* finishTurn(ctx, turn, {
        state: outcome.status,
        errorMessage: outcome.errorMessage,
        result,
      });
    });

  // ── Frame mapping ──────────────────────────────────────────────────

  const handleAssistant = (
    ctx: CloudSessionContext,
    turn: PendingTurn,
    frame: Extract<CloudFrame, { _tag: "client_event" }>,
    payload: Record<string, unknown>,
  ) =>
    Effect.gen(function* () {
      const content = asRecord(payload.message)?.content;
      if (!Array.isArray(content)) return;
      for (const [index, entry] of content.entries()) {
        const block = asRecord(entry);
        if (block === undefined) continue;
        const itemId = `${frame.eventId}:${index}`;
        if (block.type === "text" || block.type === "thinking") {
          const text = asString(block.type === "text" ? block.text : block.thinking);
          if (text === undefined) continue;
          const reasoning = block.type === "thinking";
          yield* offer({
            type: "content.delta",
            ...(yield* eventBase(ctx.threadId)),
            turnId: turn.turnId,
            itemId: RuntimeItemId.make(itemId),
            payload: { streamKind: reasoning ? "reasoning_text" : "assistant_text", delta: text },
          });
          yield* offer({
            type: "item.completed",
            ...(yield* eventBase(ctx.threadId)),
            turnId: turn.turnId,
            itemId: RuntimeItemId.make(itemId),
            payload: {
              itemType: reasoning ? "reasoning" : "assistant_message",
              status: "completed",
              title: reasoning ? "Reasoning" : "Assistant message",
              detail: text,
            },
          });
          continue;
        }
        if (block.type !== "tool_use") continue;
        const toolId = asString(block.id);
        const toolName = asString(block.name);
        if (toolId === undefined || toolName === undefined || turn.tools.has(toolId)) continue;
        const input = asRecord(block.input) ?? {};
        const itemType = classifyToolItemType(toolName, input);
        const tool: ToolInFlight = {
          itemId: toolId,
          itemType,
          toolName,
          title: titleForTool(itemType),
          detail: summarizeToolRequest(toolName, input),
          input,
        };
        turn.tools.set(toolId, tool);
        yield* offer({
          type: "item.started",
          ...(yield* eventBase(ctx.threadId)),
          turnId: turn.turnId,
          itemId: RuntimeItemId.make(toolId),
          payload: {
            itemType,
            status: "inProgress",
            title: tool.title,
            ...(tool.detail ? { detail: tool.detail } : {}),
            data: { toolName, input },
          },
          providerRefs: { providerItemId: ProviderItemId.make(toolId) },
        });
      }
    });

  const handleToolResults = (
    ctx: CloudSessionContext,
    turn: PendingTurn,
    payload: Record<string, unknown>,
  ) =>
    Effect.gen(function* () {
      for (const toolResult of toolResultBlocksFromUserMessage(payload as unknown as SDKMessage)) {
        const tool = turn.tools.get(toolResult.toolUseId);
        if (tool === undefined) continue;
        turn.tools.delete(toolResult.toolUseId);
        const streamKind = toolResultStreamKind(tool.itemType);
        if (streamKind !== undefined && toolResult.text.length > 0) {
          yield* offer({
            type: "content.delta",
            ...(yield* eventBase(ctx.threadId)),
            turnId: turn.turnId,
            itemId: RuntimeItemId.make(tool.itemId),
            payload: { streamKind, delta: toolResult.text },
            providerRefs: { providerItemId: ProviderItemId.make(tool.itemId) },
          });
        }
        yield* offer({
          type: "item.completed",
          ...(yield* eventBase(ctx.threadId)),
          turnId: turn.turnId,
          itemId: RuntimeItemId.make(tool.itemId),
          payload: {
            itemType: tool.itemType,
            status: toolResult.isError ? "failed" : "completed",
            title: tool.title,
            ...(tool.detail ? { detail: tool.detail } : {}),
            data: { toolName: tool.toolName, input: tool.input },
          },
          providerRefs: { providerItemId: ProviderItemId.make(tool.itemId) },
        });
      }
    });

  const handleWorkerEvent = (
    ctx: CloudSessionContext,
    frame: Extract<CloudFrame, { _tag: "client_event" }>,
  ) =>
    Effect.gen(function* () {
      const payload = asRecord(frame.payload);
      if (payload === undefined) return;
      const turn = ctx.queue[0];
      // Subagent traffic carries the spawning tool's id. Phase 1 shows the
      // spawn and its result on the main agent only.
      const isSubagent = asString(payload.parent_tool_use_id) !== undefined;

      switch (frame.eventType) {
        case "system": {
          const model = asString(payload.model);
          if (payload.subtype === "init" && model !== undefined) ctx.model = model;
          return;
        }
        case "assistant":
          if (turn !== undefined && !turn.orphan && !isSubagent) {
            yield* handleAssistant(ctx, turn, frame, payload);
          }
          return;
        case "user":
          if (turn !== undefined && !turn.orphan && !isSubagent) {
            yield* handleToolResults(ctx, turn, payload);
          }
          return;
        case "result":
          yield* handleResult(ctx, payload);
          return;
        case "control_request": {
          // Nothing in the cloud sandbox asked for permission while probing.
          // If that changes, say so rather than hang the turn on an answer.
          const request = asRecord(payload.request);
          if (request?.subtype === "can_use_tool") {
            yield* emitWarning(
              ctx,
              "Claude Cloud asked for a tool permission, which this provider cannot answer yet.",
            );
          }
          return;
        }
        case "rate_limit_event": {
          const info = asRecord(payload.rate_limit_info);
          if (info?.status === "rejected") {
            yield* emitWarning(ctx, "Claude usage limit reached for this window.");
          }
          return;
        }
        default:
          return;
      }
    });

  const handleFrame = (ctx: CloudSessionContext, frame: CloudFrame) =>
    Effect.gen(function* () {
      switch (frame._tag) {
        case "client_event": {
          // Reconnects and re-attaches replay what we already handled.
          if (frame.sequenceNum <= ctx.lastSeq) return;
          ctx.lastSeq = frame.sequenceNum;
          // Our own messages echo back on the stream.
          if (frame.source === "client") return;
          yield* handleWorkerEvent(ctx, frame);
          return;
        }
        case "delivery_update": {
          if (!/FAIL|REJECT/i.test(frame.status)) return;
          const index = ctx.queue.findIndex((turn) => turn.eventId === frame.eventId);
          if (index === -1) return;
          const [turn] = ctx.queue.splice(index, 1);
          if (turn !== undefined && !turn.orphan) {
            yield* finishTurn(ctx, turn, {
              state: "failed",
              errorMessage: "Claude Cloud could not deliver the message.",
            });
          }
          return;
        }
        case "session_update": {
          if (asRecord(frame.data)?.status !== "archived") return;
          yield* failActiveTurns(ctx, "This Claude Cloud session was archived.");
          yield* closeSession(ctx, { exitKind: "graceful", recoverable: false });
          return;
        }
        case "ephemeral_event":
          return;
      }
    });

  // ── Stream supervision ─────────────────────────────────────────────

  const failConnection = (
    ctx: CloudSessionContext,
    message: string,
    errorClass: "transport_error" | "permission_error",
  ) =>
    Effect.gen(function* () {
      yield* offer({
        type: "runtime.error",
        ...(yield* eventBase(ctx.threadId)),
        payload: { message, class: errorClass },
      });
      yield* failActiveTurns(ctx, message);
      yield* setSession(ctx, { status: "error", activeTurnId: undefined, lastError: message });
      yield* offer({
        type: "session.state.changed",
        ...(yield* eventBase(ctx.threadId)),
        payload: { state: "error", reason: message },
      });
    });

  /** Streams until the session closes, reconnecting with back-off when it drops. */
  const superviseStream = (ctx: CloudSessionContext) =>
    Effect.gen(function* () {
      // Counts drops since the stream last delivered something.
      let failures = 0;
      while (!ctx.closed) {
        const exit = yield* Stream.runForEach(
          api.streamFrames(ctx.cloudSessionId, ctx.lastSeq > 0 ? { lastEventId: ctx.lastSeq } : {}),
          (frame) =>
            Effect.suspend(() => {
              failures = 0;
              return handleFrame(ctx, frame);
            }),
        ).pipe(Effect.exit);
        if (ctx.closed) return;
        const cause = Option.getOrUndefined(
          Exit.isFailure(exit) ? Exit.findErrorOption(exit) : Option.none(),
        );
        if (
          cause !== undefined &&
          (cause._tag === "ClaudeCloudCredentialsError" ||
            (cause._tag === "CloudApiError" && cause.kind === "auth"))
        ) {
          yield* failConnection(ctx, SIGN_IN_HINT, "permission_error");
          return;
        }
        const delay = reconnectDelays[failures];
        failures += 1;
        if (delay === undefined) {
          yield* failConnection(ctx, "Lost connection to Claude Cloud.", "transport_error");
          return;
        }
        yield* Effect.sleep(delay);
      }
    });

  // ── Session lifecycle ──────────────────────────────────────────────

  const closeSession = (
    ctx: CloudSessionContext,
    exit: { readonly exitKind: "graceful" | "error"; readonly recoverable?: boolean },
  ) =>
    Effect.gen(function* () {
      if (ctx.closed) return;
      ctx.closed = true;
      sessions.delete(ctx.threadId);
      yield* offer({
        type: "session.exited",
        ...(yield* eventBase(ctx.threadId)),
        payload: exit,
      });
      yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
    });

  const startSession: ClaudeCloudAdapterShape["startSession"] = Effect.fn(
    "ClaudeCloudAdapter.startSession",
  )(function* (input) {
    const existing = sessions.get(input.threadId);
    if (existing !== undefined) {
      yield* closeSession(existing, { exitKind: "graceful" });
    }
    const selection =
      input.modelSelection?.instanceId === options.instanceId ? input.modelSelection : undefined;
    const slug = selection
      ? resolveClaudeModelSlug(BUNDLED_CLAUDE_MODEL_CATALOG, selection.model)
      : undefined;
    const apiModel = selection
      ? resolveClaudeCatalogApiModelId(BUNDLED_CLAUDE_MODEL_CATALOG, {
          ...selection,
          model: slug ?? selection.model,
        })
      : undefined;
    const resolvedEffort = resolveClaudeCatalogEffort(
      BUNDLED_CLAUDE_MODEL_CATALOG,
      slug,
      getModelSelectionStringOptionValue(selection, "effort"),
    );
    const effort =
      resolvedEffort !== undefined && CLOUD_EFFORT_LEVELS.has(resolvedEffort)
        ? resolvedEffort
        : undefined;

    const warnings: string[] = [];
    const storedSessionId = readClaudeCloudSessionId(input.resumeCursor);
    let reattached = false;
    let cloudSessionId = storedSessionId;
    if (cloudSessionId !== null) {
      const found = yield* api.getSession(cloudSessionId).pipe(
        Effect.map((session) => !session.archived),
        Effect.catchIf(
          (error) => error._tag === "CloudApiError" && error.kind === "not_found",
          () => Effect.succeed(false),
        ),
        Effect.mapError(mapCloudError("startSession")),
      );
      if (found) {
        reattached = true;
      } else {
        warnings.push("The previous Claude Cloud session is gone. Started a new one.");
        cloudSessionId = null;
      }
    }

    if (cloudSessionId === null) {
      const repo = yield* options.resolveRepoSource(input.cwd);
      const create = (sources: ReadonlyArray<CloudRepoSource>) =>
        api.createSession({
          title: input.title ?? DEFAULT_TITLE,
          sources,
          ...(apiModel === undefined ? {} : { model: apiModel }),
          ...(effort === undefined ? {} : { effort }),
        });
      const created = yield* create(repo === null ? [] : [repo]).pipe(
        // The cloud refuses a repo its GitHub app cannot reach; run without one.
        Effect.catchIf(
          (error) => repo !== null && error._tag === "CloudApiError" && error.status === 400,
          () => {
            warnings.push(
              "Claude Cloud could not access this repository, so the session has no repo attached.",
            );
            return create([]);
          },
        ),
        Effect.mapError(mapCloudError("startSession")),
      );
      cloudSessionId = created.id;
    }

    // Re-attaching: skip history, and notice a turn the cloud is still running
    // from before a restart so its result cannot complete the next turn early.
    let lastSeq = 0;
    let orphanEventId: string | null = null;
    if (reattached) {
      const recent = yield* api
        .latestEvents(cloudSessionId, RESUME_EVENT_WINDOW)
        .pipe(Effect.mapError(mapCloudError("startSession")));
      lastSeq = recent.reduce((max, event) => Math.max(max, event.sequenceNum), 0);
      const newestUser = recent.find((e) => e.eventType === "user" && e.source === "client");
      const newestResult = recent.find((e) => e.eventType === "result" && e.source === "worker");
      if (
        newestUser !== undefined &&
        (newestResult === undefined || newestUser.sequenceNum > newestResult.sequenceNum)
      ) {
        orphanEventId = `orphan:${newestUser.sequenceNum}`;
      }
    }

    const createdAt = yield* nowIso;
    const scope = yield* Scope.make();
    const session: ProviderSession = {
      provider: PROVIDER,
      providerInstanceId: options.instanceId,
      status: "ready",
      runtimeMode: input.runtimeMode,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(slug ? { model: slug } : {}),
      threadId: input.threadId,
      resumeCursor: makeClaudeCloudCursor(cloudSessionId),
      createdAt,
      updatedAt: createdAt,
    };
    const ctx: CloudSessionContext = {
      threadId: input.threadId,
      cloudSessionId,
      scope,
      queue: [],
      turns: [],
      session,
      model: slug,
      lastSeq,
      closed: false,
    };
    if (orphanEventId !== null) {
      ctx.queue.push({
        turnId: TurnId.make(yield* randomUUID),
        eventId: orphanEventId,
        orphan: true,
        interruptRequested: false,
        tools: new Map(),
      });
    }
    sessions.set(input.threadId, ctx);
    yield* Effect.forkIn(superviseStream(ctx), scope);

    yield* offer({
      type: "session.started",
      ...(yield* eventBase(input.threadId)),
      payload: { resume: makeClaudeCloudCursor(cloudSessionId) },
    });
    yield* offer({
      type: "thread.started",
      ...(yield* eventBase(input.threadId)),
      payload: { providerThreadId: cloudSessionId },
    });
    yield* offer({
      type: "session.state.changed",
      ...(yield* eventBase(input.threadId)),
      payload: { state: "ready" },
    });
    for (const message of warnings) {
      yield* emitWarning(ctx, message);
    }
    return session;
  });

  const sendTurn: ClaudeCloudAdapterShape["sendTurn"] = Effect.fn("ClaudeCloudAdapter.sendTurn")(
    function* (input) {
      const ctx = yield* requireSession(input.threadId);
      if ((input.attachments?.length ?? 0) > 0) {
        return yield* requestError("sendTurn", "Claude Cloud does not support attachments yet.");
      }
      const text = input.input?.trim();
      if (!text) {
        return yield* requestError("sendTurn", "Claude Cloud needs a message to send.");
      }

      const selection =
        input.modelSelection?.instanceId === options.instanceId ? input.modelSelection : undefined;
      if (selection !== undefined) {
        const slug = resolveClaudeModelSlug(BUNDLED_CLAUDE_MODEL_CATALOG, selection.model);
        if (slug !== ctx.model) {
          const apiModel = resolveClaudeCatalogApiModelId(BUNDLED_CLAUDE_MODEL_CATALOG, {
            ...selection,
            model: slug,
          });
          const requestId = yield* randomUUID;
          yield* api
            .sendEvents(ctx.cloudSessionId, [
              {
                eventId: requestId,
                eventType: "control_request",
                payload: {
                  type: "control_request",
                  request_id: requestId,
                  uuid: requestId,
                  request: { subtype: "set_model", model: apiModel },
                },
              },
            ])
            .pipe(Effect.mapError(mapCloudError("sendTurn")));
          ctx.model = slug;
        }
      }

      const turn: PendingTurn = {
        turnId: TurnId.make(yield* randomUUID),
        eventId: yield* randomUUID,
        orphan: false,
        interruptRequested: false,
        tools: new Map(),
      };
      ctx.queue.push(turn);
      yield* setSession(ctx, { status: "running", activeTurnId: turn.turnId });
      yield* offer({
        type: "turn.started",
        ...(yield* eventBase(ctx.threadId)),
        turnId: turn.turnId,
        payload: { ...(ctx.model ? { model: ctx.model } : {}) },
      });

      yield* api
        .sendEvents(ctx.cloudSessionId, [
          {
            eventId: turn.eventId,
            eventType: "user",
            payload: {
              type: "user",
              uuid: turn.eventId,
              session_id: ctx.cloudSessionId,
              parent_tool_use_id: null,
              message: { role: "user", content: text },
            },
          },
        ])
        .pipe(
          Effect.tapError((error) =>
            Effect.gen(function* () {
              const index = ctx.queue.indexOf(turn);
              if (index !== -1) ctx.queue.splice(index, 1);
              yield* finishTurn(ctx, turn, { state: "failed", errorMessage: error.message });
            }),
          ),
          Effect.mapError(mapCloudError("sendTurn")),
        );

      return {
        threadId: input.threadId,
        turnId: turn.turnId,
        resumeCursor: makeClaudeCloudCursor(ctx.cloudSessionId),
      };
    },
  );

  const interruptTurn: ClaudeCloudAdapterShape["interruptTurn"] = Effect.fn(
    "ClaudeCloudAdapter.interruptTurn",
  )(function* (threadId) {
    const ctx = yield* requireSession(threadId);
    const turn = ctx.queue.find((candidate) => !candidate.orphan);
    if (turn === undefined) return;
    turn.interruptRequested = true;
    const requestId = yield* randomUUID;
    yield* api
      .sendEvents(ctx.cloudSessionId, [
        {
          eventId: requestId,
          eventType: "control_request",
          payload: {
            type: "control_request",
            request_id: requestId,
            uuid: requestId,
            request: { subtype: "interrupt" },
          },
        },
      ])
      .pipe(Effect.mapError(mapCloudError("interruptTurn")));
  });

  const unsupported = (method: string) =>
    Effect.fail(requestError(method, "Claude Cloud does not support this yet."));

  // Stopping only detaches: the cloud session must stay resumable, because the
  // idle reaper and auth changes stop sessions too. Archive is releaseThread.
  const stopSession: ClaudeCloudAdapterShape["stopSession"] = (threadId) =>
    Effect.suspend(() => {
      const ctx = sessions.get(threadId);
      return ctx === undefined ? Effect.void : closeSession(ctx, { exitKind: "graceful" });
    });

  const stopAll: ClaudeCloudAdapterShape["stopAll"] = () =>
    Effect.forEach([...sessions.values()], (ctx) => closeSession(ctx, { exitKind: "graceful" }), {
      discard: true,
    });
  yield* Effect.addFinalizer(() => stopAll().pipe(Effect.ignore));

  const releaseThread: NonNullable<ClaudeCloudAdapterShape["releaseThread"]> = (input) =>
    Effect.gen(function* () {
      const sessionId =
        sessions.get(input.threadId)?.cloudSessionId ??
        readClaudeCloudSessionId(input.resumeCursor);
      if (sessionId === null) return;
      yield* api.archive(sessionId).pipe(
        // Already gone is as good as archived.
        Effect.catchIf(
          (error) => error._tag === "CloudApiError" && error.kind === "not_found",
          () => Effect.void,
        ),
        Effect.mapError(mapCloudError("releaseThread")),
      );
    });

  const adapter: ClaudeCloudAdapterShape = {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "in-session",
      supportsConversationRollback: false,
      usesLocalWorkspace: false,
    },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest: () => unsupported("respondToRequest"),
    respondToUserInput: () => unsupported("respondToUserInput"),
    stopSession,
    listSessions: () => Effect.sync(() => [...sessions.values()].map((ctx) => ctx.session)),
    hasSession: (threadId) => Effect.sync(() => sessions.get(threadId)?.closed === false),
    readThread: (threadId) =>
      Effect.map(requireSession(threadId), (ctx) => ({
        threadId,
        turns: ctx.turns.map((turn) => ({ id: turn.id, items: turn.items })),
      })),
    rollbackThread: () => unsupported("rollbackThread"),
    releaseThread,
    stopAll,
    streamEvents: Stream.fromPubSub(runtimeEventPubSub),
  };
  return adapter;
});
