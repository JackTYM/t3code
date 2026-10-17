/**
 * Drives a Claude Code cloud session (claude.ai/code) over its private HTTP/SSE
 * API. The agent runs in Anthropic's sandbox, never in the thread's cwd.
 *
 * Worker messages are Claude SDK message JSON, so tool, result, and usage
 * mapping reuses the pure helpers of the local Claude adapter.
 *
 * @module ClaudeCloudAdapterV2
 */
import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  type ModelSelection,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2TurnItem,
  ProviderDriverKind,
  type ProviderInstanceId,
  type RepositoryIdentity,
} from "@t3tools/contracts";
import {
  ClaudeCloudApiError,
  ClaudeCloudSignInError,
  type ClaudeCloudApi,
  type ClaudeCloudError,
  type CloudFrame,
  type CloudRepoSource,
} from "@t3tools/provider-claude-cloud/server";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  makeProviderFailure,
  makeProviderFailureTurnItem,
} from "@t3tools/provider-core/server/failure";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import type * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { normalizeClaudeTurnTokenUsage } from "../../provider/ClaudeTurnTokenUsage.ts";
import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  resolveClaudeCatalogApiModelId,
  resolveClaudeCatalogEffort,
  resolveClaudeModelSlug,
} from "../../provider/ClaudeModelCatalog.ts";
import {
  buildAssistantArtifacts,
  buildClaudeToolTurnItem,
  claudeNativeToolInputFromUnknown,
  claudeProviderTurnTokenUsage,
  claudeToolResultEntriesFromMessage,
  classifyClaudeNativeTool,
  isClaudeToolResultError,
  NO_CLAUDE_NATIVE_TOOL_OUTPUT,
  providerFailureFromResult,
  terminalStatusFromResult,
  type ClaudeNativeToolInput,
  type ClaudeNativeToolOutput,
  type ClaudeToolClassification,
} from "./ClaudeAdapterV2.ts";

export const CLAUDE_CLOUD_PROVIDER = ProviderDriverKind.make("claudeCloud");
const DEFAULT_TITLE = "T3 Code";
/** Recent events inspected when re-attaching to tell whether a turn is mid-flight. */
const RESUME_EVENT_WINDOW = 50;
/**
 * Effort levels the cloud accepts. The catalog also lists Claude Code modes
 * (`ultracode`, `ultrathink`) that are not API effort levels.
 */
const CLOUD_EFFORT_LEVELS: ReadonlySet<string> = new Set(["low", "medium", "high", "xhigh", "max"]);
/** Back-off between reconnects of a dropped stream; running out fails the active turn. */
const DEFAULT_RECONNECT_DELAYS: ReadonlyArray<Duration.Input> = [
  "1 second",
  "2 seconds",
  "4 seconds",
  "8 seconds",
  "16 seconds",
  "30 seconds",
  "30 seconds",
  "30 seconds",
];
const SESSION_GONE_NOTICE = "The previous Claude Cloud session is gone. Started a new one.";
const REPO_FALLBACK_NOTICE =
  "Claude Cloud could not access this repository, so the session has no repo attached.";

export const ClaudeCloudProviderCapabilitiesV2 = {
  // The cloud sandbox is the boundary: the agent runs there with full access.
  runtimePolicy: { enforcement: "native" },
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: false,
    canRollbackThread: false,
    canForkThread: false,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: false,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    // The worker publishes whole messages, not token deltas.
    streamsAssistantText: false,
    streamsReasoning: false,
    streamsToolOutput: false,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: true,
    supportsMcpTools: false,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: false,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: false,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: false,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: false,
    emitsTodoList: false,
    emitsProposedPlan: false,
    supportsStructuredQuestions: false,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: false,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: false,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: true,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: true,
    supportsDeltaHandoff: true,
    supportsFullThreadHandoff: true,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    // The agent never touches the local tree, so a checkpoint there would
    // describe changes it did not make.
    appCanCheckpointFilesystem: false,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
    providerCanReadConversationSnapshot: false,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "none",
    nativeItemIds: "strong",
    nativeRequestIds: "none",
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface ClaudeCloudAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly api: ClaudeCloudApi;
  /** Fallback when a thread's runtime policy has no cwd; the session record needs one. */
  readonly defaultCwd: string;
  /** The repo to attach to a new cloud session, or null to run without one. */
  readonly resolveRepoSource: (cwd: string | null) => Effect.Effect<CloudRepoSource | null>;
  readonly reconnectDelays?: ReadonlyArray<Duration.Input>;
}

/**
 * The GitHub repo to attach, from a project's remote identity. Other hosts are
 * not offered: the cloud clones through the Claude GitHub app.
 */
export const githubRepoSourceFromIdentity = (
  identity: Pick<RepositoryIdentity, "provider" | "owner" | "name"> | null,
): CloudRepoSource | null =>
  identity?.provider === "github" && identity.owner && identity.name
    ? { url: `https://github.com/${identity.owner}/${identity.name}` }
    : null;

/** The API model id and the effort the cloud accepts for a selection. */
export function resolveClaudeCloudModel(selection: ModelSelection): {
  readonly model: string;
  readonly effort: string | undefined;
} {
  const slug = resolveClaudeModelSlug(BUNDLED_CLAUDE_MODEL_CATALOG, selection.model);
  const effort = resolveClaudeCatalogEffort(
    BUNDLED_CLAUDE_MODEL_CATALOG,
    slug,
    getModelSelectionStringOptionValue(selection, "effort"),
  );
  return {
    model: resolveClaudeCatalogApiModelId(BUNDLED_CLAUDE_MODEL_CATALOG, {
      ...selection,
      model: slug,
    }),
    effort: effort !== undefined && CLOUD_EFFORT_LEVELS.has(effort) ? effort : undefined,
  };
}

interface ToolState {
  readonly toolName: string;
  readonly classification: ClaudeToolClassification;
  readonly toolInput: ClaudeNativeToolInput;
  readonly startedAt: DateTime.Utc;
}

/** One sent message and the turn the worker's output belongs to, in send order. */
interface CloudTurn {
  readonly kind: "turn";
  readonly eventId: string;
  readonly input: ProviderAdapter.ProviderAdapterV2TurnInput;
  readonly providerTurn: OrchestrationV2ProviderTurn;
  readonly ordinals: Map<string, number>;
  nextOrdinal: number;
  readonly tools: Map<string, ToolState>;
  interruptRequested: boolean;
  settled: boolean;
}

/**
 * A turn the cloud was still running when T3 re-attached after a restart. Its
 * output is not ours to attribute, and its result must not complete the next
 * turn, so it holds the head of the queue until that result arrives.
 */
interface OrphanTurn {
  readonly kind: "orphan";
}

type QueuedTurn = CloudTurn | OrphanTurn;

interface Attachment {
  readonly sessionId: string;
  readonly queue: Array<QueuedTurn>;
  /** Highest sequence number handled; reconnects and re-attaches replay at or below it. */
  lastSeq: number;
  /** The API model the cloud session runs, so a selection change sends `set_model`. */
  model: string | undefined;
  active: boolean;
  /** Completed when the attachment ends, closing its event stream. */
  readonly stopped: Deferred.Deferred<void>;
}

const endAttachment = (current: Attachment) => {
  current.active = false;
  Deferred.doneUnsafe(current.stopped, Effect.void);
};

const isSignInError = Schema.is(ClaudeCloudSignInError);
const isApiError = Schema.is(ClaudeCloudApiError);
const isResumeThreadError = Schema.is(ProviderAdapter.ProviderAdapterResumeThreadError);

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const nativeRef = (nativeId: string, strength: "strong" | "weak" = "strong") => ({
  driver: CLAUDE_CLOUD_PROVIDER,
  nativeId,
  strength,
});

const isGone = (error: ClaudeCloudError) => isApiError(error) && error.kind === "notFound";

/** User-facing failure for a cloud call, with credential problems marked as such. */
export function claudeCloudFailure(error: ClaudeCloudError): OrchestrationV2ProviderFailure {
  if (isSignInError(error)) {
    return makeProviderFailure({ class: "permission_error", message: error.message, code: "auth" });
  }
  switch (error.kind) {
    case "auth":
      return makeProviderFailure({
        class: "permission_error",
        message: "Claude rejected your login. Run `claude` and sign in again.",
        code: "auth",
      });
    case "rateLimit":
      return makeProviderFailure({
        class: "usage_limit",
        message: "Claude Cloud rate limit reached. Try again later.",
        code: "rate_limit",
        retryable: true,
      });
    case "notFound":
      return makeProviderFailure({ class: "provider_error", message: error.message });
    case "transport":
      return makeProviderFailure({ class: "transport_error", message: error.message });
  }
}

export const makeClaudeCloudAdapterV2 = Effect.fn("makeClaudeCloudAdapterV2")(function* (
  options: ClaudeCloudAdapterV2Options,
) {
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const api = options.api;
  const reconnectDelays = options.reconnectDelays ?? DEFAULT_RECONNECT_DELAYS;

  const protocolError = (detail: string, cause?: unknown) =>
    new ProviderAdapter.ProviderAdapterProtocolError({
      driver: CLAUDE_CLOUD_PROVIDER,
      detail,
      ...(cause === undefined ? {} : { cause }),
    });

  const controlRequest = (subtype: string, extra: Record<string, unknown> = {}) =>
    Effect.map(randomUuidV4, (requestId) => ({
      eventId: requestId,
      eventType: "control_request",
      payload: {
        type: "control_request",
        request_id: requestId,
        uuid: requestId,
        request: { subtype, ...extra },
      },
    }));

  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver: CLAUDE_CLOUD_PROVIDER,
    getCapabilities: () => Effect.succeed(ClaudeCloudProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed(turnScopedSelectionTransition()),
    // Thread deletion is the only caller: stop and idle keep the cloud session
    // resumable, so archiving there would lose work the user can still continue.
    releaseNativeThread: ({ nativeThreadId }) =>
      api.archive(nativeThreadId).pipe(
        // Already gone is as good as archived.
        Effect.catchIf(isGone, () => Effect.void),
        Effect.mapError((cause) =>
          protocolError("Could not archive the Claude Cloud session", cause),
        ),
      ),
    openSession: Effect.fn("ClaudeCloudAdapterV2.openSession")(function* (
      input: ProviderAdapter.ProviderAdapterV2OpenSessionInput,
    ) {
      if (input.runtimePolicy.interactionMode === "plan") {
        return yield* protocolError("Claude Cloud does not support Plan mode");
      }
      const scope = yield* Effect.scope;
      const now = yield* DateTime.now;
      let sessionEntity: OrchestrationV2ProviderSession = {
        id: input.providerSessionId,
        driver: CLAUDE_CLOUD_PROVIDER,
        providerInstanceId: options.instanceId,
        status: "ready",
        cwd: input.runtimePolicy.cwd ?? options.defaultCwd,
        model: input.modelSelection.model,
        capabilities: ClaudeCloudProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      const events = yield* Queue.unbounded<
        ProviderAdapter.ProviderAdapterV2Event,
        ProviderAdapter.ProviderAdapterV2Error | Cause.Done
      >();
      // Frames, sends, and interrupts all touch the turn queue; one permit keeps
      // a turn in the queue before the worker can answer it.
      const permit = yield* Semaphore.make(1);
      let thread: OrchestrationV2ProviderThread | null = null;
      let attachment: Attachment | null = null;
      /** A session whose re-attach failed for a reason other than being gone; retried on the next turn. */
      let pendingAttach: string | null = null;
      let previousSessionGone = false;
      const notices: Array<string> = [];

      const emit = (event: ProviderAdapter.ProviderAdapterV2Event) =>
        Queue.offer(events, event).pipe(Effect.asVoid);

      const updateSession = Effect.fnUntraced(function* (
        status: OrchestrationV2ProviderSession["status"],
        lastError: string | null = null,
      ) {
        sessionEntity = { ...sessionEntity, status, lastError, updatedAt: yield* DateTime.now };
        yield* emit({
          type: "provider_session.updated",
          driver: CLAUDE_CLOUD_PROVIDER,
          providerSession: sessionEntity,
        });
      });

      const updateThread = Effect.fnUntraced(function* (
        patch: Partial<OrchestrationV2ProviderThread>,
      ) {
        if (thread === null) return;
        thread = { ...thread, ...patch, updatedAt: yield* DateTime.now };
        yield* emit({
          type: "provider_thread.updated",
          driver: CLAUDE_CLOUD_PROVIDER,
          providerThread: thread,
        });
      });

      const itemOrdinal = (turn: CloudTurn, nativeItemId: string): number => {
        const existing = turn.ordinals.get(nativeItemId);
        if (existing !== undefined) return existing;
        const ordinal = turn.nextOrdinal++;
        turn.ordinals.set(nativeItemId, ordinal);
        return ordinal;
      };

      const itemIdentity = (
        turn: CloudTurn,
        nativeItemId: string,
        status: OrchestrationV2TurnItem["status"],
        startedAt: DateTime.Utc,
        updatedAt: DateTime.Utc,
      ) => ({
        id: idAllocator.derive.turnItemFromProviderItem({
          driver: CLAUDE_CLOUD_PROVIDER,
          nativeItemId,
        }),
        threadId: turn.input.threadId,
        runId: turn.input.runId,
        nodeId: idAllocator.derive.nodeFromProviderItem({
          driver: CLAUDE_CLOUD_PROVIDER,
          nativeItemId,
        }),
        providerThreadId: turn.input.providerThread.id,
        providerTurnId: turn.providerTurn.id,
        nativeItemRef: nativeRef(nativeItemId),
        parentItemId: null,
        ordinal: itemOrdinal(turn, nativeItemId),
        status,
        startedAt,
        completedAt: status === "running" ? null : updatedAt,
        updatedAt,
      });

      const itemNode = (
        turn: CloudTurn,
        nativeItemId: string,
        kind: OrchestrationV2ExecutionNode["kind"],
        status: OrchestrationV2ExecutionNode["status"],
        startedAt: DateTime.Utc,
        updatedAt: DateTime.Utc,
      ): OrchestrationV2ExecutionNode => ({
        id: idAllocator.derive.nodeFromProviderItem({
          driver: CLAUDE_CLOUD_PROVIDER,
          nativeItemId,
        }),
        threadId: turn.input.threadId,
        runId: turn.input.runId,
        parentNodeId: turn.input.rootNodeId,
        rootNodeId: turn.input.rootNodeId,
        kind,
        status,
        countsForRun: false,
        providerThreadId: turn.input.providerThread.id,
        providerTurnId: turn.providerTurn.id,
        nativeItemRef: nativeRef(nativeItemId),
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt,
        completedAt: status === "running" ? null : updatedAt,
      });

      const emitNotice = Effect.fnUntraced(function* (turn: CloudTurn, message: string) {
        const now = yield* DateTime.now;
        const nativeItemId = `${turn.providerTurn.id}:notice:${turn.nextOrdinal}`;
        yield* emit({
          type: "turn_item.updated",
          driver: CLAUDE_CLOUD_PROVIDER,
          turnItem: {
            ...itemIdentity(turn, nativeItemId, "completed", now, now),
            nodeId: turn.input.rootNodeId,
            nativeItemRef: null,
            title: null,
            type: "system_notice",
            message,
          },
        });
      });

      const emitTool = Effect.fnUntraced(function* (
        turn: CloudTurn,
        toolUseId: string,
        tool: ToolState,
        status: Extract<
          OrchestrationV2TurnItem["status"],
          "running" | "completed" | "failed" | "interrupted" | "cancelled"
        >,
        output: ClaudeNativeToolOutput,
      ) {
        const now = yield* DateTime.now;
        yield* emit({
          type: "node.updated",
          driver: CLAUDE_CLOUD_PROVIDER,
          node: itemNode(turn, toolUseId, "tool_call", status, tool.startedAt, now),
        });
        yield* emit({
          type: "turn_item.updated",
          driver: CLAUDE_CLOUD_PROVIDER,
          turnItem: buildClaudeToolTurnItem({
            identity: itemIdentity(turn, toolUseId, status, tool.startedAt, now),
            toolName: tool.toolName,
            classification: tool.classification,
            toolInput: tool.toolInput,
            output,
            presentation: undefined,
          }),
        });
      });

      const finishTurn = Effect.fnUntraced(function* (
        turn: CloudTurn,
        outcome: {
          readonly status: Extract<
            OrchestrationV2ProviderTurn["status"],
            "completed" | "interrupted" | "failed" | "cancelled"
          >;
          readonly failure: OrchestrationV2ProviderFailure | null;
          readonly result?: SDKResultMessage;
        },
      ) {
        if (turn.settled) return;
        turn.settled = true;
        if (attachment !== null) {
          const index = attachment.queue.indexOf(turn);
          if (index !== -1) attachment.queue.splice(index, 1);
        }
        const toolStatus =
          outcome.status === "completed"
            ? "completed"
            : outcome.status === "failed"
              ? "failed"
              : outcome.status;
        for (const [toolUseId, tool] of turn.tools) {
          yield* emitTool(turn, toolUseId, tool, toolStatus, NO_CLAUDE_NATIVE_TOOL_OUTPUT);
        }
        turn.tools.clear();
        const completedAt = yield* DateTime.now;
        const usage = outcome.result?.usage;
        yield* emit({
          type: "provider_turn.updated",
          driver: CLAUDE_CLOUD_PROVIDER,
          threadId: turn.input.threadId,
          providerTurn: {
            ...turn.providerTurn,
            status: outcome.status,
            completedAt,
            ...(usage === undefined
              ? {}
              : {
                  tokenUsage: claudeProviderTurnTokenUsage(
                    usage,
                    turn.input.modelSelection,
                    DateTime.formatIso(completedAt),
                  ),
                }),
            turnTokenUsage: normalizeClaudeTurnTokenUsage(outcome.result, false, outcome.status),
          },
        });
        yield* updateThread({ status: "idle" });
        yield* updateSession(
          outcome.failure === null ? "ready" : "error",
          outcome.failure?.message ?? null,
        );
        if (outcome.status === "failed") {
          const failure = outcome.failure ?? makeProviderFailure({ class: "provider_error" });
          const failureItemOrdinal = itemOrdinal(turn, `terminal-failure:${turn.providerTurn.id}`);
          yield* emit({
            type: "turn_item.updated",
            driver: CLAUDE_CLOUD_PROVIDER,
            turnItem: makeProviderFailureTurnItem({
              driver: CLAUDE_CLOUD_PROVIDER,
              threadId: turn.input.threadId,
              runId: turn.input.runId,
              nodeId: turn.input.rootNodeId,
              providerThreadId: turn.input.providerThread.id,
              providerTurnId: turn.providerTurn.id,
              itemOrdinal: failureItemOrdinal,
              failure,
              occurredAt: completedAt,
            }),
          });
          yield* emit({
            type: "turn.terminal",
            driver: CLAUDE_CLOUD_PROVIDER,
            providerThreadId: turn.input.providerThread.id,
            providerTurnId: turn.providerTurn.id,
            runOrdinal: turn.input.runOrdinal,
            failureItemOrdinal,
            status: "failed",
            failure,
            threadDisposition: "reusable",
          });
          return;
        }
        yield* emit({
          type: "turn.terminal",
          driver: CLAUDE_CLOUD_PROVIDER,
          providerThreadId: turn.input.providerThread.id,
          providerTurnId: turn.providerTurn.id,
          runOrdinal: turn.input.runOrdinal,
          status: outcome.status,
          failure: null,
          threadDisposition: "reusable",
        });
      });

      const failTurn = (turn: CloudTurn, failure: OrchestrationV2ProviderFailure) =>
        finishTurn(turn, { status: "failed", failure });

      /** Ends the stream for this session; later turns re-attach to it. */
      const loseAttachment = Effect.fnUntraced(function* (
        current: Attachment,
        failure: OrchestrationV2ProviderFailure,
        reattachLater: boolean,
      ) {
        if (!current.active) return;
        endAttachment(current);
        if (reattachLater) pendingAttach = current.sessionId;
        const turns = current.queue.splice(0, current.queue.length);
        for (const turn of turns) {
          if (turn.kind === "turn") yield* failTurn(turn, failure);
        }
      });

      const handleToolResults = Effect.fnUntraced(function* (turn: CloudTurn, message: SDKMessage) {
        for (const { toolResult, output } of claudeToolResultEntriesFromMessage(message)) {
          const toolUseId = toolResult.tool_use_id;
          const tool = turn.tools.get(toolUseId);
          if (tool === undefined) continue;
          turn.tools.delete(toolUseId);
          yield* emitTool(
            turn,
            toolUseId,
            tool,
            isClaudeToolResultError(toolResult) ? "failed" : "completed",
            output,
          );
        }
      });

      const handleAssistant = Effect.fnUntraced(function* (
        turn: CloudTurn,
        eventId: string,
        payload: Record<string, unknown>,
      ) {
        const content = asRecord(payload.message)?.content;
        if (!Array.isArray(content)) return;
        for (const [index, entry] of content.entries()) {
          const block = asRecord(entry);
          if (block === undefined) continue;
          const nativeItemId = `${eventId}:${index}`;
          const now = yield* DateTime.now;
          if (block.type === "text") {
            const text = asString(block.text);
            if (text === undefined) continue;
            const artifacts = buildAssistantArtifacts({
              driver: CLAUDE_CLOUD_PROVIDER,
              idAllocator,
              turnInput: turn.input,
              providerTurnId: turn.providerTurn.id,
              nativeItemId,
              text,
              ordinal: itemOrdinal(turn, nativeItemId),
              startedAt: now,
              completedAt: now,
            });
            yield* emit({
              type: "node.updated",
              driver: CLAUDE_CLOUD_PROVIDER,
              node: artifacts.node,
            });
            yield* emit({
              type: "message.updated",
              driver: CLAUDE_CLOUD_PROVIDER,
              message: artifacts.message,
            });
            yield* emit({
              type: "turn_item.updated",
              driver: CLAUDE_CLOUD_PROVIDER,
              turnItem: artifacts.turnItem,
            });
            continue;
          }
          if (block.type === "thinking") {
            const text = asString(block.thinking);
            if (text === undefined) continue;
            yield* emit({
              type: "node.updated",
              driver: CLAUDE_CLOUD_PROVIDER,
              node: itemNode(turn, nativeItemId, "reasoning", "completed", now, now),
            });
            yield* emit({
              type: "turn_item.updated",
              driver: CLAUDE_CLOUD_PROVIDER,
              turnItem: {
                ...itemIdentity(turn, nativeItemId, "completed", now, now),
                title: null,
                type: "reasoning",
                text,
                streaming: false,
              },
            });
            continue;
          }
          if (block.type !== "tool_use") continue;
          const toolUseId = asString(block.id);
          const toolName = asString(block.name);
          if (toolUseId === undefined || toolName === undefined || turn.tools.has(toolUseId)) {
            continue;
          }
          const tool: ToolState = {
            toolName,
            classification: classifyClaudeNativeTool(toolName),
            toolInput: claudeNativeToolInputFromUnknown(block.input ?? {}),
            startedAt: now,
          };
          turn.tools.set(toolUseId, tool);
          yield* emitTool(turn, toolUseId, tool, "running", NO_CLAUDE_NATIVE_TOOL_OUTPUT);
        }
        // Server-side tools (web search, code execution) answer in the same message.
        yield* handleToolResults(turn, payload as unknown as SDKMessage);
      });

      const handleResult = Effect.fnUntraced(function* (
        current: Attachment,
        payload: Record<string, unknown>,
      ) {
        const head = current.queue.shift();
        // A result with nothing queued is the sandbox settling, not a turn of ours.
        if (head === undefined || head.kind === "orphan") return;
        const result = payload as unknown as SDKResultMessage;
        // A cloud interrupt ends the turn with a plain error_during_execution
        // result, with none of the terminal_reason hints the local CLI adds.
        if (head.interruptRequested && result.subtype === "error_during_execution") {
          return yield* finishTurn(head, { status: "interrupted", failure: null, result });
        }
        const status = terminalStatusFromResult(result);
        const completedAt = yield* DateTime.now;
        const failure =
          status === "failed"
            ? (providerFailureFromResult(result, completedAt) ??
              makeProviderFailure({ class: "provider_error" }))
            : null;
        yield* finishTurn(head, { status, failure, result });
      });

      const handleWorkerEvent = Effect.fnUntraced(function* (
        current: Attachment,
        frame: Extract<CloudFrame, { _tag: "sessionEvent" }>,
      ) {
        const payload = asRecord(frame.payload);
        if (payload === undefined) return;
        const head = current.queue[0];
        const turn = head?.kind === "turn" ? head : undefined;
        // Subagent traffic carries the spawning tool's id. Phase 1 shows the
        // spawn and its result on the main agent only.
        const isSubagent = asString(payload.parent_tool_use_id) !== undefined;
        switch (frame.eventType) {
          case "assistant":
            if (turn !== undefined && !isSubagent) {
              yield* handleAssistant(turn, frame.eventId, payload);
            }
            return;
          case "user":
            if (turn !== undefined && !isSubagent) {
              yield* handleToolResults(turn, payload as unknown as SDKMessage);
            }
            return;
          case "result":
            return yield* handleResult(current, payload);
          case "control_request": {
            // Nothing in the cloud sandbox asked for permission while probing.
            // If that changes, say so rather than leave the turn silently stuck.
            if (asRecord(payload.request)?.subtype === "can_use_tool" && turn !== undefined) {
              yield* emitNotice(
                turn,
                "Claude Cloud asked for a tool permission, which this provider cannot answer yet.",
              );
            }
            return;
          }
          case "rate_limit_event": {
            if (asRecord(payload.rate_limit_info)?.status === "rejected" && turn !== undefined) {
              yield* emitNotice(turn, "Claude usage limit reached for this window.");
            }
            return;
          }
          default:
            return;
        }
      });

      const handleFrame = Effect.fnUntraced(function* (current: Attachment, frame: CloudFrame) {
        if (current !== attachment || !current.active) return;
        switch (frame._tag) {
          case "sessionEvent": {
            // Reconnects and re-attaches replay what was already handled.
            if (frame.sequenceNum <= current.lastSeq) return;
            current.lastSeq = frame.sequenceNum;
            // Our own messages echo back on the stream.
            if (frame.source === "client") return;
            return yield* handleWorkerEvent(current, frame);
          }
          case "deliveryUpdate": {
            if (!/FAIL|REJECT/i.test(frame.status)) return;
            const turn = current.queue.find(
              (candidate): candidate is CloudTurn =>
                candidate.kind === "turn" && candidate.eventId === frame.eventId,
            );
            if (turn !== undefined) {
              yield* failTurn(
                turn,
                makeProviderFailure({
                  class: "provider_error",
                  message: "Claude Cloud could not deliver the message.",
                }),
              );
            }
            return;
          }
          case "sessionUpdate": {
            if (frame.status !== "archived") return;
            return yield* loseAttachment(
              current,
              makeProviderFailure({
                class: "provider_error",
                message: "This Claude Cloud session was archived.",
              }),
              false,
            );
          }
        }
      });

      /** Streams until the attachment ends, reconnecting with back-off when it drops. */
      const superviseStream = (current: Attachment) =>
        Effect.gen(function* () {
          // Counts drops since the stream last delivered something.
          let failures = 0;
          while (current.active) {
            const exit = yield* Stream.runForEach(
              api.streamFrames(
                current.sessionId,
                current.lastSeq > 0 ? { lastEventId: current.lastSeq } : undefined,
              ),
              (frame) =>
                Effect.suspend(() => {
                  failures = 0;
                  return permit.withPermits(1)(handleFrame(current, frame));
                }),
            ).pipe(Effect.raceFirst(Deferred.await(current.stopped)), Effect.exit);
            if (!current.active) return;
            const error = Exit.isFailure(exit)
              ? Option.getOrUndefined(Exit.findErrorOption(exit))
              : undefined;
            if (error !== undefined && (isSignInError(error) || error.kind === "auth")) {
              return yield* permit.withPermits(1)(
                loseAttachment(current, claudeCloudFailure(error), true),
              );
            }
            const delay = reconnectDelays[failures];
            failures += 1;
            if (delay === undefined) {
              return yield* permit.withPermits(1)(
                loseAttachment(
                  current,
                  makeProviderFailure({
                    class: "transport_error",
                    message: "Lost connection to Claude Cloud.",
                  }),
                  true,
                ),
              );
            }
            yield* Effect.sleep(delay);
          }
        });

      const attach = Effect.fnUntraced(function* (
        sessionId: string,
        state: { readonly lastSeq: number; readonly orphan: boolean; readonly model?: string },
      ) {
        if (attachment !== null) endAttachment(attachment);
        const next: Attachment = {
          sessionId,
          queue: state.orphan ? [{ kind: "orphan" }] : [],
          lastSeq: state.lastSeq,
          model: state.model,
          active: true,
          stopped: Deferred.makeUnsafe<void>(),
        };
        attachment = next;
        pendingAttach = null;
        yield* Effect.forkIn(superviseStream(next), scope);
      });

      /**
       * Re-attaches to an existing cloud session without replaying its
       * history, and notices a turn the cloud is still running from before.
       */
      const reattach = Effect.fnUntraced(function* (sessionId: string) {
        const found = yield* api.getSession(sessionId).pipe(
          Effect.map((session) => !session.archived),
          Effect.catchIf(isGone, () => Effect.succeed(false)),
        );
        if (!found) return "gone" as const;
        const recent = yield* api.latestEvents(sessionId, RESUME_EVENT_WINDOW);
        const newestUser = recent.find((e) => e.eventType === "user" && e.source === "client");
        const newestResult = recent.find((e) => e.eventType === "result" && e.source === "worker");
        yield* attach(sessionId, {
          lastSeq: recent.reduce((max, event) => Math.max(max, event.sequenceNum), 0),
          orphan:
            newestUser !== undefined &&
            (newestResult === undefined || newestUser.sequenceNum > newestResult.sequenceNum),
        });
        return "attached" as const;
      });

      const createSession = Effect.fnUntraced(function* (input: {
        readonly title: string | undefined;
        readonly modelSelection: ModelSelection;
        readonly cwd: string | null;
      }) {
        const { model, effort } = resolveClaudeCloudModel(input.modelSelection);
        const repo = yield* options.resolveRepoSource(input.cwd);
        const create = (sources: ReadonlyArray<CloudRepoSource>) =>
          api.createSession({
            title: input.title?.trim() || DEFAULT_TITLE,
            sources,
            model,
            ...(effort === undefined ? {} : { effort }),
          });
        const created = yield* create(repo === null ? [] : [repo]).pipe(
          // The cloud refuses a repo its GitHub app cannot reach; run without one.
          Effect.catchIf(
            (error) => repo !== null && isApiError(error) && error.status === 400,
            () => {
              notices.push(REPO_FALLBACK_NOTICE);
              return create([]);
            },
          ),
        );
        yield* attach(created.id, { lastSeq: 0, orphan: false, model });
        return created.id;
      });

      const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
        instanceId: options.instanceId,
        driver: CLAUDE_CLOUD_PROVIDER,
        providerSessionId: input.providerSessionId,
        get providerSession() {
          return sessionEntity;
        },
        events: Stream.fromQueue(events),
        ensureThread: (threadInput) =>
          Effect.gen(function* () {
            const existing = threadInput.existingProviderThread;
            if (existing?.nativeThreadRef?.nativeId != null) {
              return yield* runtime.resumeThread({
                providerThread: existing,
                threadId: threadInput.threadId,
                modelSelection: threadInput.modelSelection,
                runtimePolicy: threadInput.runtimePolicy,
              });
            }
            const sessionId = yield* createSession({
              title: threadInput.title,
              modelSelection: threadInput.modelSelection,
              cwd: threadInput.runtimePolicy.cwd,
            });
            if (previousSessionGone) {
              notices.push(SESSION_GONE_NOTICE);
              previousSessionGone = false;
            }
            const createdAt = yield* DateTime.now;
            thread =
              existing !== undefined
                ? {
                    ...existing,
                    providerSessionId: input.providerSessionId,
                    nativeThreadRef: nativeRef(sessionId),
                    nativeConversationHeadRef: null,
                    status: "idle",
                    updatedAt: createdAt,
                  }
                : {
                    id: idAllocator.derive.providerThread({
                      driver: CLAUDE_CLOUD_PROVIDER,
                      nativeThreadId: sessionId,
                    }),
                    driver: CLAUDE_CLOUD_PROVIDER,
                    providerInstanceId: options.instanceId,
                    providerSessionId: input.providerSessionId,
                    appThreadId: threadInput.threadId,
                    ownerNodeId: null,
                    nativeThreadRef: nativeRef(sessionId),
                    nativeConversationHeadRef: null,
                    status: "idle",
                    firstRunOrdinal: null,
                    lastRunOrdinal: null,
                    handoffIds: [],
                    forkedFrom: null,
                    pendingBackgroundTasks: [],
                    createdAt,
                    updatedAt: createdAt,
                  };
            yield* emit({
              type: "provider_thread.updated",
              driver: CLAUDE_CLOUD_PROVIDER,
              providerThread: thread,
            });
            return thread;
          }).pipe(
            // The sign-in error itself is the cause, so the failed turn shows its fixed text.
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterEnsureThreadError({
                  driver: CLAUDE_CLOUD_PROVIDER,
                  threadId: threadInput.threadId,
                  cause: isResumeThreadError(cause) ? cause.cause : cause,
                }),
            ),
          ),
        resumeThread: (resumeInput) =>
          Effect.gen(function* () {
            const sessionId = resumeInput.providerThread.nativeThreadRef?.nativeId;
            if (sessionId == null) {
              return yield* protocolError("Provider thread has no Claude Cloud session id");
            }
            const adopt = Effect.fnUntraced(function* () {
              thread = {
                ...resumeInput.providerThread,
                providerSessionId: input.providerSessionId,
                updatedAt: yield* DateTime.now,
              };
              return thread;
            });
            if (attachment?.sessionId === sessionId && attachment.active) return yield* adopt();
            const reattached = yield* Effect.result(reattach(sessionId));
            if (reattached._tag === "Success" && reattached.success === "gone") {
              // Failing hands the thread to a fresh session with a summary of
              // this one, which keeps far more context than starting cold here.
              previousSessionGone = true;
              return yield* protocolError("The Claude Cloud session is gone");
            }
            // A credential or network problem must not abandon the session:
            // the next turn retries and reports the problem on the turn.
            if (reattached._tag === "Failure") pendingAttach = sessionId;
            return yield* adopt();
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterResumeThreadError({
                  driver: CLAUDE_CLOUD_PROVIDER,
                  providerSessionId: input.providerSessionId,
                  providerThreadId: resumeInput.providerThread.id,
                  cause,
                }),
            ),
          ),
        startTurn: (turnInput) =>
          Effect.gen(function* () {
            const startedAt = yield* DateTime.now;
            const syntheticNativeTurnId = `${turnInput.providerThread.id}:attempt:${turnInput.attemptId}`;
            const turn: CloudTurn = {
              kind: "turn",
              eventId: yield* randomUuidV4,
              input: turnInput,
              providerTurn: {
                id: idAllocator.derive.providerTurn({
                  driver: CLAUDE_CLOUD_PROVIDER,
                  nativeTurnId: syntheticNativeTurnId,
                }),
                providerThreadId: turnInput.providerThread.id,
                nodeId: turnInput.rootNodeId,
                runAttemptId: turnInput.attemptId,
                nativeTurnRef: nativeRef(syntheticNativeTurnId, "weak"),
                ordinal: turnInput.providerTurnOrdinal,
                status: "running",
                startedAt,
                completedAt: null,
              },
              ordinals: new Map(),
              nextOrdinal: turnInput.providerTurnOrdinal * 100 + 1,
              tools: new Map(),
              interruptRequested: false,
              settled: false,
            };
            thread ??= turnInput.providerThread;
            yield* emit({
              type: "provider_turn.updated",
              driver: CLAUDE_CLOUD_PROVIDER,
              threadId: turnInput.threadId,
              providerTurn: turn.providerTurn,
            });
            yield* updateThread({
              status: "active",
              firstRunOrdinal: thread.firstRunOrdinal ?? turnInput.runOrdinal,
              lastRunOrdinal: turnInput.runOrdinal,
            });
            yield* updateSession("running");

            if (turnInput.message.attachments.length > 0) {
              return yield* failTurn(
                turn,
                makeProviderFailure({
                  class: "validation_error",
                  message: "Claude Cloud does not support attachments yet.",
                }),
              );
            }

            const ready = yield* permit.withPermits(1)(
              Effect.gen(function* () {
                if (attachment === null || !attachment.active) {
                  const sessionId = pendingAttach ?? thread?.nativeThreadRef?.nativeId ?? null;
                  const outcome =
                    sessionId === null ? ("gone" as const) : yield* reattach(sessionId);
                  if (outcome === "gone") {
                    const created = yield* createSession({
                      title: turnInput.appThread.title,
                      modelSelection: turnInput.modelSelection,
                      cwd: turnInput.runtimePolicy.cwd,
                    });
                    notices.push(SESSION_GONE_NOTICE);
                    yield* updateThread({ nativeThreadRef: nativeRef(created) });
                  }
                }
                const current = attachment!;
                const { model } = resolveClaudeCloudModel(turnInput.modelSelection);
                if (current.model !== model) {
                  yield* api.sendEvents(current.sessionId, [
                    yield* controlRequest("set_model", { model }),
                  ]);
                  current.model = model;
                }
                for (const message of notices.splice(0, notices.length)) {
                  yield* emitNotice(turn, message);
                }
                current.queue.push(turn);
                yield* api
                  .sendEvents(current.sessionId, [
                    {
                      eventId: turn.eventId,
                      eventType: "user",
                      payload: {
                        type: "user",
                        uuid: turn.eventId,
                        session_id: current.sessionId,
                        parent_tool_use_id: null,
                        message: { role: "user", content: turnInput.message.text },
                      },
                    },
                  ])
                  .pipe(
                    Effect.tapError(() =>
                      Effect.sync(() => {
                        const index = current.queue.indexOf(turn);
                        if (index !== -1) current.queue.splice(index, 1);
                      }),
                    ),
                  );
              }).pipe(Effect.result),
            );
            if (ready._tag === "Failure") {
              yield* failTurn(turn, claudeCloudFailure(ready.failure));
            }
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterTurnStartError({
                  driver: CLAUDE_CLOUD_PROVIDER,
                  threadId: turnInput.threadId,
                  providerThreadId: turnInput.providerThread.id,
                  runId: turnInput.runId,
                  cause,
                }),
            ),
          ),
        steerTurn: (steerInput) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterSteerRunUnsupportedError({
              driver: CLAUDE_CLOUD_PROVIDER,
              providerThreadId: steerInput.providerThread.id,
            }),
          ),
        interruptTurn: (interruptInput) =>
          permit
            .withPermits(1)(
              Effect.gen(function* () {
                const current = attachment;
                const turn = current?.queue.find(
                  (candidate): candidate is CloudTurn =>
                    candidate.kind === "turn" &&
                    candidate.providerTurn.id === interruptInput.providerTurnId,
                );
                if (current === null || turn === undefined) {
                  return yield* protocolError(
                    `Claude Cloud turn ${interruptInput.providerTurnId} is not active`,
                  );
                }
                turn.interruptRequested = true;
                yield* api
                  .sendEvents(current.sessionId, [yield* controlRequest("interrupt")])
                  .pipe(
                    Effect.tapError(() => Effect.sync(() => (turn.interruptRequested = false))),
                  );
              }),
            )
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterInterruptError({
                    driver: CLAUDE_CLOUD_PROVIDER,
                    providerThreadId: interruptInput.providerThread.id,
                    providerTurnId: interruptInput.providerTurnId,
                    cause,
                  }),
              ),
            ),
        respondToRuntimeRequest: (requestInput) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
              driver: CLAUDE_CLOUD_PROVIDER,
              requestId: requestInput.requestId,
              cause: "Claude Cloud never asks for approval.",
            }),
          ),
        readThreadSnapshot: (snapshotInput) =>
          Effect.succeed({
            providerThread: thread ?? snapshotInput.providerThread,
            providerTurns: [],
            messages: [],
            runtimeRequests: [],
          }),
        rollbackThread: (rollbackInput) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterRollbackThreadError({
              driver: CLAUDE_CLOUD_PROVIDER,
              providerThreadId: rollbackInput.providerThread.id,
              cause: "Claude Cloud cannot roll back a conversation.",
            }),
          ),
        forkThread: (forkInput) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterForkThreadError({
              driver: CLAUDE_CLOUD_PROVIDER,
              providerThreadId: forkInput.sourceProviderThread.id,
              cause: "Claude Cloud cannot fork a conversation.",
            }),
          ),
      };
      // Closing only detaches: the idle reaper closes sessions too, and the
      // cloud session has to stay resumable.
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (attachment !== null) endAttachment(attachment);
        }),
      );
      return runtime;
    }),
  });
});
