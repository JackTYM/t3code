import {
  CommandId,
  isProviderNativeSubagentThread,
  ORCHESTRATION_V2_REPLY_EDIT_MAX_VERSIONS,
  type OrchestrationV2AssistantMessageEdits,
  type OrchestrationV2EditAssistantMessageInput,
  OrchestrationV2ReplyEditError,
  type OrchestrationV2ReplyEditFailureReason,
  type OrchestrationV2SelectAssistantMessageVersionInput,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

type AssistantItem = Extract<OrchestrationV2TurnItem, { readonly type: "assistant_message" }>;

type ReplyEditPlan =
  | { readonly _tag: "Unchanged" }
  | { readonly _tag: "Refused"; readonly reason: OrchestrationV2ReplyEditFailureReason }
  | {
      readonly _tag: "Apply";
      readonly expectedText: string;
      readonly text: string;
      readonly edits: OrchestrationV2AssistantMessageEdits;
    };

/**
 * Pure: the next version history. Version 1 stays the agent's original reply, and choosing text
 * that is already a version selects it instead of adding a duplicate.
 */
export function planReplyEdit(
  item: Pick<AssistantItem, "text" | "edits">,
  request:
    | { readonly type: "edit"; readonly text: string }
    | { readonly type: "select"; readonly version: number },
): ReplyEditPlan {
  const versions = item.edits?.versions ?? [item.text];
  const selected = item.edits?.selected ?? 1;
  if (request.type === "select") {
    const text = item.edits === undefined ? undefined : versions[request.version - 1];
    if (text === undefined) return { _tag: "Refused", reason: "unknown-version" };
    if (request.version === selected) return { _tag: "Unchanged" };
    return {
      _tag: "Apply",
      expectedText: item.text,
      text,
      edits: { selected: request.version, versions },
    };
  }
  if (request.text.trim().length === 0) return { _tag: "Refused", reason: "empty-text" };
  if (request.text === item.text) return { _tag: "Unchanged" };
  const existing = versions.indexOf(request.text);
  if (existing !== -1) {
    return {
      _tag: "Apply",
      expectedText: item.text,
      text: request.text,
      edits: { selected: existing + 1, versions },
    };
  }
  if (versions.length >= ORCHESTRATION_V2_REPLY_EDIT_MAX_VERSIONS) {
    return { _tag: "Refused", reason: "version-limit" };
  }
  const next = [...versions, request.text];
  return {
    _tag: "Apply",
    expectedText: item.text,
    text: request.text,
    edits: { selected: next.length, versions: next },
  };
}

const ACTIVE_RUN_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);

export class ReplyEditService extends Context.Service<
  ReplyEditService,
  {
    readonly edit: (
      input: OrchestrationV2EditAssistantMessageInput,
    ) => Effect.Effect<void, OrchestrationV2ReplyEditError>;
    readonly selectVersion: (
      input: OrchestrationV2SelectAssistantMessageVersionInput,
    ) => Effect.Effect<void, OrchestrationV2ReplyEditError>;
  }
>()("t3/orchestration-v2/ReplyEditService") {}

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const adapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const threadLock = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;

  const apply = (
    input: { readonly threadId: OrchestrationV2EditAssistantMessageInput["threadId"] } & Pick<
      OrchestrationV2EditAssistantMessageInput,
      "messageId"
    >,
    request: Parameters<typeof planReplyEdit>[1],
  ) =>
    Effect.gen(function* () {
      const refuse = (reason: OrchestrationV2ReplyEditFailureReason, cause?: unknown) =>
        new OrchestrationV2ReplyEditError({
          threadId: input.threadId,
          messageId: input.messageId,
          reason,
          ...(cause === undefined ? {} : { cause }),
        });

      const commandUuid = yield* crypto
        .randomUUIDv4()
        .pipe(Effect.mapError((cause) => refuse("write-failed", cause)));

      // Holding the thread lock keeps a new message from starting a turn, and so reopening the
      // session, between the idle check and the rewrite.
      const rewritten = yield* threadLock.withLock(
        input.threadId,
        Effect.gen(function* () {
          const records = yield* orchestrator
            .getThreadRecords(
              input.threadId,
              ["runs", "runtimeRequests", "providerThreads", "turnItems"],
              { turnItemTypes: ["assistant_message"], messageRoles: [] },
            )
            .pipe(Effect.mapError((cause) => refuse("not-editable", cause)));
          const thread = records.thread;
          if (
            thread.deletedAt !== null ||
            thread.archivedAt !== null ||
            isProviderNativeSubagentThread(thread)
          ) {
            return yield* refuse("not-editable");
          }
          const providerThread = records.providerThreads.find(
            (candidate) => candidate.id === thread.activeProviderThreadId,
          );
          if (
            records.runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status)) ||
            records.runtimeRequests.some((request) => request.status === "pending") ||
            (providerThread?.pendingBackgroundTasks?.length ?? 0) > 0
          ) {
            return yield* refuse("thread-busy");
          }
          const item = records.turnItems.find(
            (candidate): candidate is AssistantItem =>
              candidate.type === "assistant_message" && candidate.messageId === input.messageId,
          );
          if (item === undefined || item.status !== "completed" || item.streaming) {
            return yield* refuse("not-editable");
          }
          const nativeItemId = item.nativeItemRef?.nativeId ?? null;
          const nativeThreadId = providerThread?.nativeThreadRef?.nativeId ?? null;
          // Only the active provider thread is what the next turn resumes; a reply from an
          // earlier session, a fork or a handoff is not in that history.
          if (
            providerThread === undefined ||
            item.providerThreadId !== providerThread.id ||
            providerThread.appThreadId !== thread.id ||
            nativeItemId === null ||
            nativeThreadId === null
          ) {
            return yield* refuse("not-in-history");
          }
          const adapter = yield* adapters
            .get(providerThread.providerInstanceId)
            .pipe(Effect.mapError((cause) => refuse("unsupported", cause)));
          const editAssistantText = adapter.editAssistantText;
          if (editAssistantText === undefined) return yield* refuse("unsupported");

          const plan = planReplyEdit(item, request);
          if (plan._tag === "Unchanged") return undefined;
          if (plan._tag === "Refused") return yield* refuse(plan.reason);

          // A live provider process holds the conversation in memory and would neither see the
          // edit nor keep it: it appends its own copy on the next turn. Releasing it is what the
          // idle reaper does, so the next turn resumes from the edited history.
          const providerSessionId = providerThread.providerSessionId;
          if (providerSessionId !== null && (yield* sessions.isLive(providerSessionId))) {
            const capabilities = yield* adapter
              .getCapabilities()
              .pipe(Effect.mapError((cause) => refuse("unsupported", cause)));
            if (capabilities.sessions.supportsMultipleProviderThreadsPerSession) {
              return yield* refuse("unsupported");
            }
            yield* sessions
              .release({
                providerSessionId,
                reason: "manual_shutdown",
                detail: "Released to edit an assistant reply.",
              })
              .pipe(Effect.mapError((cause) => refuse("thread-busy", cause)));
            if (yield* sessions.isLive(providerSessionId)) return yield* refuse("thread-busy");
          }

          const editNative = (expectedText: string, text: string) =>
            editAssistantText({
              nativeThreadId,
              nativeItemId,
              expectedText,
              text,
              backupPath: path.join(
                serverConfig.stateDir,
                "reply-edit-backups",
                `${nativeThreadId}.jsonl`,
              ),
            }).pipe(Effect.mapError((error) => refuse(error.reason, error)));
          yield* editNative(plan.expectedText, plan.text);
          return { plan, revert: editNative(plan.text, plan.expectedText) };
        }),
      );
      if (rewritten === undefined) return;

      yield* orchestrator
        .dispatch({
          type: "assistant-message.edit.record",
          commandId: CommandId.make(`server:reply-edit:${input.messageId}:${commandUuid}`),
          threadId: input.threadId,
          messageId: input.messageId,
          expectedText: rewritten.plan.expectedText,
          edits: rewritten.plan.edits,
        })
        .pipe(
          Effect.catch((cause) =>
            // The agent's history already changed; put it back so the app and the agent agree.
            threadLock.withLock(input.threadId, rewritten.revert).pipe(
              Effect.catch((revertError) =>
                Effect.logError("Reply edit could not be reverted after a failed record", {
                  threadId: input.threadId,
                  messageId: input.messageId,
                  revertError,
                }),
              ),
              Effect.andThen(Effect.fail(refuse("write-failed", cause))),
            ),
          ),
        );
    });

  return ReplyEditService.of({
    edit: (input) => apply(input, { type: "edit", text: input.text }),
    selectVersion: (input) => apply(input, { type: "select", version: input.version }),
  });
});

export const layer = Layer.effect(ReplyEditService, make);
