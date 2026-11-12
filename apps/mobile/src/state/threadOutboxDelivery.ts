import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import * as Dialog from "../components/ui/Dialog";
import {
  type EnvironmentProject,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  type AtomCommand,
  type AtomCommandResult,
  runAtomCommand,
} from "@t3tools/client-runtime/state/runtime";
import { threadFamilyRead, type ThreadFamilyRead } from "@t3tools/client-runtime/state/threads";
import { deriveThreadTitleSeed } from "@t3tools/client-runtime/operations";
import {
  AuthOrchestrationOperateScope,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  managedRuntimeModeDenial,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type EnvironmentId,
} from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";

import { createDebugLogger } from "../lib/debugLog";
import { scopedThreadKey } from "../lib/scopedEntities";
import { buildProjectThreadStartTurnInput } from "../lib/projectThreadStartTurn";
import { serializeComposerMessageForServer, uploadedComposerContext } from "../lib/composerContext";
import { prepareTurnAttachments, type PreparedTurnAttachments } from "../lib/attachmentUpload";
import { randomHex } from "../lib/uuid";
import {
  describeUnavailableModelSelection,
  isModelSelectionUnavailable,
} from "../lib/modelOptions";
import {
  retainAcknowledgedThreadMessage,
  forgetAcknowledgedThreadMessage,
} from "./acknowledged-thread-messages";
import { appAtomRegistry } from "./atom-registry";
import { restoredNewTaskDraftKey } from "./new-task-draft-key";
import {
  clearPendingThreadCreationOutcome,
  pendingThreadCreationOutcomesAtom,
  recordPendingThreadCreationOutcome,
} from "./pending-thread-creation";
import { environmentProjects } from "./projects";
import { environmentServerConfigsAtom, serverEnvironment } from "./server";
import { gitEnvironment } from "./git";
import { environmentSession, readEnvironmentScope, sessionHasScope } from "./session";
import {
  confirmThreadOutboxMessageQueued,
  threadOutboxManager,
  threadOutboxRevision,
  updateThreadOutboxMessage,
} from "./thread-outbox";
import { removeThreadOutboxMessage } from "./thread-outbox-removal";
import {
  isQueuedThreadCreationSendable,
  resolveThreadOutboxDeliveryAction,
  resolveThreadOutboxDispatchStep,
  resolveThreadOutboxFailureAction,
  resolveQueuedThreadSettings,
  shouldRetryThreadOutboxDelivery,
  threadOutboxRetryDelayMs,
  type QueuedThreadCreation,
  type QueuedThreadMessage,
  type ThreadOutboxCommandStage,
  type ThreadOutboxFailureAction,
} from "./thread-outbox-model";
import { environmentThreadShells, threadEnvironment, threadFamilies } from "./threads";
import {
  appendComposerDraftAttachments,
  composerDraftsAtom,
  flushComposerDrafts,
  type ComposerDraft,
  getComposerDraftSnapshot,
  mergeComposerDraftContent,
  replaceComposerDraftAttachments,
  removeDeliveredCloudQueuedMessage,
  undoComposerDraftMerge,
  updateComposerDraftSettings,
  waitForComposerDraftsLoaded,
} from "./use-composer-drafts";
import {
  dispatchingQueuedMessageIdsAtom,
  editingQueuedMessageIdsAtom,
  queuedMessageWaitReasonsAtom,
  retryingQueuedMessageIdsAtom,
  threadOutboxLogAtom,
  threadOutboxShellStatusesAtom,
} from "./use-thread-outbox";
import { clearThreadComposerError, setThreadComposerError } from "./thread-composer-error";
import { workspaceConnections } from "./workspace";

const threadOutboxDebug = createDebugLogger("thread-outbox");

function isRpcClientDecodeDefect(error: unknown): boolean {
  if (
    typeof error !== "object" ||
    error === null ||
    !("_tag" in error) ||
    error._tag !== "RpcClientError"
  ) {
    return false;
  }
  const reason: unknown = (error as { readonly reason?: unknown }).reason;
  return (
    typeof reason === "object" &&
    reason !== null &&
    "_tag" in reason &&
    reason._tag === "RpcClientDefect"
  );
}

function isOrdinaryThreadOutboxTransportFailure(error: unknown): boolean {
  return shouldRetryThreadOutboxDelivery(error) && !isRpcClientDecodeDefect(error);
}

function logThreadOutboxDeliveryFailure(input: {
  readonly stage: ThreadOutboxCommandStage;
  readonly error: unknown;
  readonly interrupted: boolean;
  readonly context: Record<string, unknown>;
}): ThreadOutboxFailureAction {
  const action = resolveThreadOutboxFailureAction({
    stage: input.stage,
    error: input.error,
    interrupted: input.interrupted,
  });
  const details = { ...input.context, stage: input.stage, action };
  const ordinaryTransportRetry =
    action === "retry" &&
    !isRpcClientDecodeDefect(input.error) &&
    (input.interrupted ||
      input.stage !== "settings-sync" ||
      shouldRetryThreadOutboxDelivery(input.error));
  if (ordinaryTransportRetry) {
    threadOutboxDebug.log("queued message delivery failed", details);
  } else {
    console.warn("[thread-outbox] queued message delivery failed", details);
  }
  return action;
}

// A message whose HTTP upload stalled sends its images inline on the next try, which skips the upload endpoint.
const inlineImageFallbacks = new Set<MessageId>();

function logThreadOutboxUploadFailure(queuedMessage: QueuedThreadMessage, error: unknown): void {
  lastDeliveryFailures.set(queuedMessage.messageId, `upload failed: ${describeFailure(error)}`);
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "AttachmentUploadStalledError"
  ) {
    inlineImageFallbacks.add(queuedMessage.messageId);
    logThreadOutbox(
      queuedMessage.messageId,
      "upload stalled; sending images inline on the next try",
    );
  }
  const context = {
    environmentId: queuedMessage.environmentId,
    threadId: queuedMessage.threadId,
    messageId: queuedMessage.messageId,
  };
  if (isOrdinaryThreadOutboxTransportFailure(error)) {
    threadOutboxDebug.log("attachment upload failed; retrying", { ...context, error });
  } else {
    console.warn("[thread-outbox] failed to upload attachments", { ...context, error });
  }
}

function setQueuedMessageRetrying(queuedMessageId: MessageId, retrying: boolean): void {
  const { [queuedMessageId]: current, ...others } = appAtomRegistry.get(
    retryingQueuedMessageIdsAtom,
  );
  if ((current === true) === retrying) return;
  appAtomRegistry.set(
    retryingQueuedMessageIdsAtom,
    retrying ? { ...others, [queuedMessageId]: true } : others,
  );
}

const THREAD_OUTBOX_LOG_LIMIT = 300;

function logThreadOutbox(messageId: MessageId, line: string): void {
  threadOutboxDebug.log(line, { messageId });
  const next = [...appAtomRegistry.get(threadOutboxLogAtom), { at: Date.now(), messageId, line }];
  appAtomRegistry.set(
    threadOutboxLogAtom,
    next.length > THREAD_OUTBOX_LOG_LIMIT ? next.slice(-THREAD_OUTBOX_LOG_LIMIT) : next,
  );
}

// A queued message is never just "Pending": whatever holds it back, or whatever step it is on,
// is written here and shown on the message and in the send log.
function setQueuedMessageStatus(queuedMessageId: MessageId, status: string | null): void {
  const { [queuedMessageId]: current, ...others } = appAtomRegistry.get(
    queuedMessageWaitReasonsAtom,
  );
  if ((current ?? null) === status) return;
  if (status !== null) logThreadOutbox(queuedMessageId, status);
  appAtomRegistry.set(
    queuedMessageWaitReasonsAtom,
    status === null ? others : { ...others, [queuedMessageId]: status },
  );
}

function describeFailure(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : typeof error === "object" && error !== null && "_tag" in error
          ? String(error._tag)
          : "unknown error";
  return message.length > 140 ? `${message.slice(0, 137)}...` : message;
}

// Each message gets its own clock and abort controller. A step that stops answering (an upload
// on a half-open socket, a request nobody replies to) must cost that message its slot, not the
// whole queue.
const DELIVERY_IDLE_LIMIT_MS = 5 * 60_000;
const DELIVERY_MAX_MS = 20 * 60_000;
const DELIVERY_WATCHDOG_INTERVAL_MS = 15_000;
const MAX_PARALLEL_DELIVERIES = 4;

interface DeliveryAttempt {
  readonly abort: AbortController;
  readonly startedAt: number;
  activityAt: number;
}

const deliveryAttempts = new Map<MessageId, DeliveryAttempt>();
const lastDeliveryFailures = new Map<MessageId, string>();

function touchDeliveryActivity(messageId: MessageId): void {
  const attempt = deliveryAttempts.get(messageId);
  if (attempt) attempt.activityAt = Date.now();
}

function beginDispatchingQueuedMessage(queuedMessageId: MessageId): void {
  const now = Date.now();
  deliveryAttempts.set(queuedMessageId, {
    abort: new AbortController(),
    startedAt: now,
    activityAt: now,
  });
  setQueuedMessageStatus(queuedMessageId, "starting to send");
  // An attempt in flight is sending, even while its retry count is kept.
  setQueuedMessageRetrying(queuedMessageId, false);
  appAtomRegistry.set(dispatchingQueuedMessageIdsAtom, {
    ...appAtomRegistry.get(dispatchingQueuedMessageIdsAtom),
    [queuedMessageId]: true,
  });
}

function finishDispatchingQueuedMessage(queuedMessageId: MessageId): void {
  deliveryAttempts.delete(queuedMessageId);
  const { [queuedMessageId]: _finished, ...others } = appAtomRegistry.get(
    dispatchingQueuedMessageIdsAtom,
  );
  appAtomRegistry.set(dispatchingQueuedMessageIdsAtom, others);
}

/** Throws away a queued message, cancelling an upload or send it still has in flight. */
export async function discardQueuedMessage(message: QueuedThreadMessage): Promise<boolean> {
  deliveryAttempts.get(message.messageId)?.abort.abort();
  const removed = await removeThreadOutboxMessage(message);
  if (removed) logThreadOutbox(message.messageId, "discarded by you");
  return removed;
}

function findThread(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  message: QueuedThreadMessage,
): EnvironmentThreadShell | undefined {
  return threads.find(
    (candidate) =>
      candidate.environmentId === message.environmentId && candidate.id === message.threadId,
  );
}

function findCreationProject(
  projects: ReadonlyArray<EnvironmentProject>,
  message: QueuedThreadMessage,
): EnvironmentProject | undefined {
  return projects.find(
    (candidate) =>
      candidate.environmentId === message.environmentId &&
      candidate.id === message.creation?.projectId,
  );
}

function settingsCommandId(message: QueuedThreadMessage, setting: string): CommandId {
  return CommandId.make(`${message.commandId}:${setting}`);
}

export async function prepareQueuedMessageAttachments(queuedMessage: QueuedThreadMessage): Promise<
  | {
      readonly status: "ready";
      readonly prepared: PreparedTurnAttachments;
      readonly persistedMessage: QueuedThreadMessage;
      readonly deliveryRevision: number;
    }
  | { readonly status: "abandoned" }
> {
  if (!(await confirmThreadOutboxMessageQueued(queuedMessage))) {
    return { status: "abandoned" };
  }
  if (!readEnvironmentScope(queuedMessage.environmentId, AuthOrchestrationOperateScope)) {
    return { status: "abandoned" };
  }
  const revision = threadOutboxRevision(queuedMessage.messageId);
  if (!isQueuedMessagePayloadCurrent(queuedMessage, revision)) {
    return { status: "abandoned" };
  }
  let persistedMessage = queuedMessage;
  let deliveryRevision = revision;
  const result = await prepareTurnAttachments({
    environmentId: queuedMessage.environmentId,
    attachments: queuedMessage.attachments,
    supportsImageUploads: !inlineImageFallbacks.has(queuedMessage.messageId),
    ...(deliveryAttempts.has(queuedMessage.messageId)
      ? { signal: deliveryAttempts.get(queuedMessage.messageId)!.abort.signal }
      : {}),
    onUploadProgress: (_attachmentId, progress) => {
      touchDeliveryActivity(queuedMessage.messageId);
      setQueuedMessageStatus(
        queuedMessage.messageId,
        `uploading attachments, ${Math.min(99, Math.floor(progress * 10) * 10)}%`,
      );
    },
    persistUploadedReferences: async (draftAttachments) => {
      if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId]) {
        return "abandon";
      }
      const updatedMessage = { ...queuedMessage, attachments: draftAttachments };
      if (!(await updateThreadOutboxMessage(updatedMessage, revision))) {
        return "abandon";
      }
      persistedMessage = updatedMessage;
      deliveryRevision = revision + 1;
      return "persisted";
    },
  });
  if (
    result.status === "abandoned" ||
    !isQueuedMessagePayloadCurrent(persistedMessage, deliveryRevision)
  ) {
    return { status: "abandoned" };
  }
  return { status: "ready", prepared: result, persistedMessage, deliveryRevision };
}

function isQueuedMessagePayloadCurrent(
  message: QueuedThreadMessage,
  expectedRevision: number,
): boolean {
  return (
    threadOutboxRevision(message.messageId) === expectedRevision &&
    Object.values(appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom))
      .flat()
      .some((candidate) => candidate === message)
  );
}

export async function completeQueuedMessageDelivery(
  queuedMessage: QueuedThreadMessage,
  deliveryRevision: number,
  sequence: number | undefined,
): Promise<"removed" | "edited" | "failed"> {
  clearThreadComposerError(
    scopedThreadKey(queuedMessage.environmentId, queuedMessage.threadId),
    queuedMessage.messageId,
  );
  try {
    await removeDeliveredCloudQueuedMessage(queuedMessage).catch((error) => {
      console.warn("[thread-outbox] could not update sign-out snapshot after delivery", {
        messageId: queuedMessage.messageId,
        error,
      });
    });
    // Editors can acquire entries during startTurn without bumping revisions; CAS alone would lose unsaved edits.
    if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId]) {
      return "edited";
    }
    retainAcknowledgedThreadMessage(
      sequence === undefined ? queuedMessage : { ...queuedMessage, sequence },
    );
    const removed = await removeThreadOutboxMessage(
      queuedMessage,
      deliveryRevision,
      () => !appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId],
    );
    if (!removed) {
      forgetAcknowledgedThreadMessage(queuedMessage);
      threadOutboxDebug.log("delivered message was edited before cleanup", {
        environmentId: queuedMessage.environmentId,
        threadId: queuedMessage.threadId,
        messageId: queuedMessage.messageId,
      });
      return "edited";
    }
    return "removed";
  } catch (error) {
    forgetAcknowledgedThreadMessage(queuedMessage);
    console.warn("[thread-outbox] failed to remove delivered queued message", {
      environmentId: queuedMessage.environmentId,
      threadId: queuedMessage.threadId,
      messageId: queuedMessage.messageId,
      error,
    });
    return "failed";
  }
}

export async function removeAcknowledgedExistingThreadMessage(
  queuedMessage: QueuedThreadMessage,
  acknowledgedMessageIds: Set<MessageId>,
): Promise<boolean> {
  try {
    await removeDeliveredCloudQueuedMessage(queuedMessage).catch((error) => {
      console.warn("[thread-outbox] could not update sign-out snapshot after delivery", {
        messageId: queuedMessage.messageId,
        error,
      });
    });
    const removed = await removeThreadOutboxMessage(queuedMessage);
    if (removed) {
      acknowledgedMessageIds.delete(queuedMessage.messageId);
    }
    return removed;
  } catch (error) {
    console.warn("[thread-outbox] failed to remove acknowledged queued message", {
      environmentId: queuedMessage.environmentId,
      threadId: queuedMessage.threadId,
      messageId: queuedMessage.messageId,
      error,
    });
    return false;
  }
}

export async function recoverEditedCreationAfterDelivery(
  queuedMessage: QueuedThreadMessage,
): Promise<boolean> {
  const kept = Object.values(appAtomRegistry.get(threadOutboxManager.queuedMessagesByThreadKeyAtom))
    .flat()
    .find((candidate) => candidate.messageId === queuedMessage.messageId);
  if (!kept) {
    return true;
  }
  const keptRevision = threadOutboxRevision(kept.messageId);
  if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[kept.messageId]) {
    return true;
  }
  const draftKey = scopedThreadKey(kept.environmentId, kept.threadId);
  try {
    // Merge before removal to retain file ownership; allow overflow and let send guards require trimming.
    await mergeComposerDraftContent(draftKey, {
      text: kept.text,
      context: kept.context,
      attachments: [],
    });
    if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[kept.messageId]) {
      return true;
    }
    if (threadOutboxRevision(kept.messageId) !== keptRevision) {
      return false;
    }
    const existingAttachmentIds = new Set(
      getComposerDraftSnapshot(draftKey).attachments.map((attachment) => attachment.id),
    );
    appendComposerDraftAttachments(
      draftKey,
      kept.attachments.filter((attachment) => !existingAttachmentIds.has(attachment.id)),
      { allowOverflow: true },
    );
    updateComposerDraftSettings(draftKey, {
      ...(kept.modelSelection !== undefined ? { modelSelection: kept.modelSelection } : {}),
      ...(kept.runtimeMode !== undefined ? { runtimeMode: kept.runtimeMode } : {}),
      ...(kept.interactionMode !== undefined ? { interactionMode: kept.interactionMode } : {}),
    });
    // Flush before removal: append only schedules persistence, leaving the queue as the sole durable copy.
    await flushComposerDrafts();
  } catch (error) {
    console.warn("[thread-outbox] could not hand an edited pending task to the composer", error);
    return false;
  }
  if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[kept.messageId]) {
    return true;
  }
  try {
    return await removeThreadOutboxMessage(
      kept,
      keptRevision,
      () => !appAtomRegistry.get(editingQueuedMessageIdsAtom)[kept.messageId],
    );
  } catch (error) {
    console.warn("[thread-outbox] could not remove recovered pending task", error);
    return false;
  }
}

export async function restoreRejectedQueuedMessage(
  queuedMessage: QueuedThreadMessage,
  message: string,
): Promise<"restored" | "deferred" | "blocked" | "retry"> {
  const draftKey = recoveryDraftKey(queuedMessage);
  const threadKey = scopedThreadKey(queuedMessage.environmentId, queuedMessage.threadId);
  let rollback: { readonly snapshot: ComposerDraft; readonly merged: ComposerDraft } | null = null;
  try {
    if (
      appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId] ||
      !(await confirmThreadOutboxMessageQueued(queuedMessage)) ||
      appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId]
    ) {
      return "deferred";
    }
    const revision = threadOutboxRevision(queuedMessage.messageId);

    await waitForComposerDraftsLoaded();
    if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId]) {
      return "deferred";
    }
    const originalDraft = getComposerDraftSnapshot(draftKey);
    const existingAttachmentIds = new Set(
      originalDraft.attachments.map((attachment) => attachment.id),
    );
    const addedAttachmentCount = queuedMessage.attachments.filter(
      (attachment) => !existingAttachmentIds.has(attachment.id),
    ).length;
    if (existingAttachmentIds.size + addedAttachmentCount > PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      setThreadComposerError(
        threadKey,
        `Remove attachments from the draft before restoring this message. Messages can contain at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} attachments.`,
        queuedMessage.messageId,
      );
      return "blocked";
    }

    const withdrawError = () => clearThreadComposerError(threadKey, queuedMessage.messageId);
    if (!queuedMessage.creation) {
      setThreadComposerError(threadKey, message, queuedMessage.messageId);
    }
    let mergedDraft: ComposerDraft;
    try {
      stampRecoveryDraftProject(queuedMessage, draftKey);
      await mergeComposerDraftContent(draftKey, {
        text: queuedMessage.text,
        context: queuedMessage.context,
        attachments: queuedMessage.attachments,
      });
    } finally {
      // Capture rollback in finally because merge publishes even on persistence failure; undo must preserve concurrent edits.
      mergedDraft = getComposerDraftSnapshot(draftKey);
      rollback = { snapshot: originalDraft, merged: mergedDraft };
    }
    if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId]) {
      withdrawError();
      await undoComposerDraftMerge(draftKey, originalDraft, mergedDraft);
      return "deferred";
    }
    updateComposerDraftSettings(draftKey, {
      ...(queuedMessage.modelSelection ? { modelSelection: queuedMessage.modelSelection } : {}),
      ...(queuedMessage.runtimeMode ? { runtimeMode: queuedMessage.runtimeMode } : {}),
      ...(queuedMessage.interactionMode ? { interactionMode: queuedMessage.interactionMode } : {}),
      ...(queuedMessage.freshContext ? { freshContext: true } : {}),
      ...(queuedMessage.creation
        ? {
            workspaceSelection: {
              mode: queuedMessage.creation.workspaceMode,
              branch: queuedMessage.creation.branch,
              worktreePath: queuedMessage.creation.worktreePath,
              pullRequestReference: queuedMessage.creation.pullRequestReference,
              ...(queuedMessage.creation.startFromOrigin !== undefined
                ? { startFromOrigin: queuedMessage.creation.startFromOrigin }
                : {}),
            },
          }
        : {}),
    });
    const restoredDraft = getComposerDraftSnapshot(draftKey);
    rollback = { snapshot: originalDraft, merged: restoredDraft };
    await flushComposerDrafts();
    if (
      appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId] ||
      !(await confirmThreadOutboxMessageQueued(queuedMessage)) ||
      appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId]
    ) {
      withdrawError();
      await undoComposerDraftMerge(draftKey, originalDraft, restoredDraft);
      return "deferred";
    }
    if (
      !(await removeThreadOutboxMessage(
        queuedMessage,
        revision,
        () => !appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId],
      ))
    ) {
      withdrawError();
      await undoComposerDraftMerge(draftKey, originalDraft, restoredDraft);
      return "deferred";
    }
    // After queue removal, the draft owns content and must never roll back.
    rollback = null;
    if (queuedMessage.creation) {
      withdrawError();
      recordPendingThreadCreationOutcome({
        kind: "failed",
        message: queuedMessage,
        reason: message,
      });
    }
    return "restored";
  } catch (error) {
    if (rollback !== null) {
      await undoComposerDraftMerge(draftKey, rollback.snapshot, rollback.merged).catch(
        (undoError) => {
          console.warn("[thread-outbox] failed to persist a recovery rollback", undoError);
        },
      );
    }
    console.warn("[thread-outbox] failed to restore an undeliverable message", error);
    setThreadComposerError(
      threadKey,
      error instanceof Error ? error.message : "The unsent message could not be restored.",
      queuedMessage.messageId,
    );
    return "retry";
  }
}

/** Derive keys from message ids so failed recovery retries reuse the same draft. */
function recoveryDraftKey(queuedMessage: QueuedThreadMessage): string {
  return queuedMessage.creation
    ? restoredNewTaskDraftKey(queuedMessage.messageId)
    : scopedThreadKey(queuedMessage.environmentId, queuedMessage.threadId);
}

function stampRecoveryDraftProject(queuedMessage: QueuedThreadMessage, draftKey: string): void {
  if (!queuedMessage.creation) {
    return;
  }
  updateComposerDraftSettings(draftKey, {
    project: {
      environmentId: queuedMessage.environmentId,
      projectId: queuedMessage.creation.projectId,
      createdAt: queuedMessage.createdAt,
    },
  });
}

async function preserveUploadedAttachmentsForEditor(
  originalMessage: QueuedThreadMessage,
  uploadedMessage: QueuedThreadMessage,
): Promise<void> {
  if (!originalMessage.creation) {
    return;
  }

  const draftKey = `pending-task:${originalMessage.messageId}`;
  const draft = getComposerDraftSnapshot(draftKey);
  const uploadedById = new Map(
    uploadedMessage.attachments.map((attachment) => [attachment.id, attachment] as const),
  );
  let changed = false;
  const nextAttachments = draft.attachments.map((attachment) => {
    const uploaded = uploadedById.get(attachment.id);
    if (
      !uploaded?.uploadedAttachmentId ||
      uploaded.uploadEnvironmentId !== originalMessage.environmentId ||
      (attachment.uploadedAttachmentId === uploaded.uploadedAttachmentId &&
        attachment.uploadEnvironmentId === uploaded.uploadEnvironmentId)
    ) {
      return attachment;
    }
    changed = true;
    return {
      ...attachment,
      uploadedAttachmentId: uploaded.uploadedAttachmentId,
      uploadEnvironmentId: uploaded.uploadEnvironmentId,
    };
  });
  if (changed) {
    replaceComposerDraftAttachments(draftKey, nextAttachments);
    await flushComposerDrafts();
  }
}

// Everything a drain pass decides from. Each queued environment's session is
// read here so a granted or revoked operate scope re-runs the drain.
const deliveryInputsAtom = Atom.make((get) => {
  const connectedEnvironments = get(workspaceConnections.environmentsAtom);
  const operableEnvironments = new Set<EnvironmentId>();
  for (const { environmentId } of connectedEnvironments) {
    if (
      sessionHasScope(
        get(environmentSession.sessionStateAtom(environmentId)),
        AuthOrchestrationOperateScope,
      )
    ) {
      operableEnvironments.add(environmentId);
    }
  }
  return {
    dispatchingQueuedMessageIds: get(dispatchingQueuedMessageIdsAtom),
    editingQueuedMessageIds: get(editingQueuedMessageIdsAtom),
    queuedMessagesByThreadKey: get(threadOutboxManager.queuedMessagesByThreadKeyAtom),
    shellStatuses: get(threadOutboxShellStatusesAtom),
    threads: get(environmentThreadShells.threadShellsAtom),
    projects: get(environmentProjects.projectsAtom),
    serverConfigs: get(environmentServerConfigsAtom),
    connectedEnvironments,
    operableEnvironments,
  };
}).pipe(Atom.withLabel("mobile:thread-outbox:delivery-inputs"));

// Read through the shell atom, not once: the shell often lands before the
// outcome is recorded, and that entry must still be collected when it does.
const settledCreationOutcomeKeysAtom = Atom.make((get): ReadonlyArray<string> => {
  const outcomes = get(pendingThreadCreationOutcomesAtom);
  const threads = get(environmentThreadShells.threadShellsAtom);
  return Object.entries(outcomes).flatMap(([threadKey, outcome]) =>
    outcome.kind === "delivered" &&
    threads.some(
      (thread) =>
        scopedThreadKey(thread.environmentId, thread.id) === threadKey &&
        (thread.latestRun !== null ||
          thread.runtime?.status === "failed" ||
          thread.runtime?.status === "cancelled" ||
          thread.runtime?.status === "interrupted"),
    )
      ? [threadKey]
      : [],
  );
}).pipe(Atom.withLabel("mobile:thread-outbox:settled-creation-outcomes"));

function deliveredSequence(
  result: AtomCommandResult<{ readonly sequence?: number }, unknown>,
): number | undefined {
  return AsyncResult.isSuccess(result) ? result.value.sequence : undefined;
}

const runDeliveryCommand = <W, A, E>(
  command: AtomCommand<W, A, E>,
  input: W,
): Promise<AtomCommandResult<A, E>> =>
  runAtomCommand(appAtomRegistry, command, input, { reportFailure: false });

function reportCommandFailure(
  queuedMessage: QueuedThreadMessage,
  commandResult: AtomCommandResult<unknown, unknown>,
  stage: ThreadOutboxCommandStage,
): { readonly action: "retry" | "restore"; readonly message: string } | null {
  if (!AsyncResult.isFailure(commandResult)) {
    return null;
  }
  const error = Cause.squash(commandResult.cause);
  lastDeliveryFailures.set(queuedMessage.messageId, describeFailure(error));
  const action = logThreadOutboxDeliveryFailure({
    stage,
    error,
    interrupted: Cause.hasInterruptsOnly(commandResult.cause),
    context: {
      environmentId: queuedMessage.environmentId,
      threadId: queuedMessage.threadId,
      messageId: queuedMessage.messageId,
      cause: commandResult.cause,
    },
  });
  return {
    action,
    message: error instanceof Error ? error.message : "The message could not be sent.",
  };
}

interface ThreadOutboxRetry {
  readonly attempt: number;
  readonly notBefore: number;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * Delivers queued thread messages one at a time. A drain pass runs whenever its inputs
 * change (outbox, locks, shells, projects, configs, connections, scopes) and when a retry
 * backoff expires. Each thread has one in-flight delivery at a time (`dispatchingQueuedMessageIdsAtom`),
 * and clearing it re-runs the drain for that thread's next message.
 */
export function createThreadOutboxDelivery(): {
  readonly drain: () => void;
  readonly retryNow: (messageId: MessageId) => void;
  readonly dispose: () => void;
} {
  let disposed = false;
  const retries = new Map<MessageId, ThreadOutboxRetry>();
  // Existing-thread turns the server accepted but whose outbox removal has
  // not landed; the next pass retries only the removal, never the send.
  const acknowledgedExistingThreadMessageIds = new Set<MessageId>();
  // Targets the shell may have left out hold their thread family until they leave the queue, so
  // the row stays readable through dispatch.
  const familyMounts = new Map<MessageId, () => void>();
  const blockedRecoveries = new Map<
    MessageId,
    { readonly message: QueuedThreadMessage; readonly unsubscribe: () => void }
  >();

  const retryNotBefore = (messageId: MessageId): number => retries.get(messageId)?.notBefore ?? 0;

  const scheduleRetry = (messageId: MessageId, why?: string): void => {
    if (disposed) return;
    const previous = retries.get(messageId);
    if (previous !== undefined) clearTimeout(previous.timer);
    const attempt = (previous?.attempt ?? 0) + 1;
    const delayMs = threadOutboxRetryDelayMs(attempt);
    retries.set(messageId, {
      attempt,
      notBefore: Date.now() + delayMs,
      timer: setTimeout(drain, delayMs),
    });
    setQueuedMessageRetrying(messageId, true);
    const reason = why ?? lastDeliveryFailures.get(messageId);
    setQueuedMessageStatus(
      messageId,
      `retrying, attempt ${attempt + 1}${reason === undefined ? "" : ` (last try: ${reason})`}`,
    );
  };

  const clearRetry = (messageId: MessageId): void => {
    lastDeliveryFailures.delete(messageId);
    const retry = retries.get(messageId);
    if (retry === undefined) return;
    clearTimeout(retry.timer);
    retries.delete(messageId);
    setQueuedMessageRetrying(messageId, false);
  };

  // Gives up on the attempt in flight, frees its slot, and retries with the usual backoff. The
  // abandoned attempt may still finish later; its result is ignored (delivery is idempotent by
  // command id, so a late success cannot double-send).
  const abandoners = new Map<MessageId, (why: string) => void>();

  // A delivery that throws backs off like any failure. Releasing the slot
  // without a retry would re-run the drain straight into the same message.
  const settle = (messageId: MessageId, delivery: Promise<boolean>): void => {
    let abandoned = false;
    const abandon = (why: string): void => {
      if (abandoned) return;
      abandoned = true;
      clearInterval(watchdog);
      abandoners.delete(messageId);
      console.warn("[thread-outbox] abandoning a delivery", { messageId, why });
      deliveryAttempts.get(messageId)?.abort.abort();
      scheduleRetry(messageId, why);
      finishDispatchingQueuedMessage(messageId);
    };
    const watchdog = setInterval(() => {
      const attempt = deliveryAttempts.get(messageId);
      if (attempt === undefined) return;
      const now = Date.now();
      if (now - attempt.activityAt >= DELIVERY_IDLE_LIMIT_MS) {
        abandon("it stopped answering for 5 minutes");
      } else if (now - attempt.startedAt >= DELIVERY_MAX_MS) {
        abandon("it took longer than 20 minutes");
      }
    }, DELIVERY_WATCHDOG_INTERVAL_MS);
    abandoners.set(messageId, abandon);
    void delivery
      .then(
        (sent) => {
          if (abandoned) return;
          if (sent) clearRetry(messageId);
          else scheduleRetry(messageId);
        },
        (error: unknown) => {
          console.warn("[thread-outbox] queued message delivery threw", { messageId, error });
          lastDeliveryFailures.set(messageId, describeFailure(error));
          if (!abandoned) scheduleRetry(messageId);
        },
      )
      .finally(() => {
        clearInterval(watchdog);
        if (!abandoned) {
          abandoners.delete(messageId);
          finishDispatchingQueuedMessage(messageId);
        }
      });
  };

  /** Skips a message's retry backoff, restarting a send that is stuck mid-flight. */
  const retryNow = (messageId: MessageId): void => {
    logThreadOutbox(messageId, "retry requested by you");
    if (abandoners.has(messageId)) {
      abandoners.get(messageId)?.("you asked to retry");
    }
    const retry = retries.get(messageId);
    if (retry !== undefined) retries.set(messageId, { ...retry, notBefore: 0 });
    drain();
  };

  // An over-cap draft blocks recovery until the user changes its attachments;
  // parking on the draft avoids hammering the restore with backoff retries.
  const restoreQueuedMessage = async (
    queuedMessage: QueuedThreadMessage,
    message: string,
  ): Promise<boolean> => {
    const result = await restoreRejectedQueuedMessage(queuedMessage, message);
    if (result !== "blocked") {
      return result !== "retry";
    }
    if (disposed || blockedRecoveries.has(queuedMessage.messageId)) {
      return true;
    }
    const draftKey = recoveryDraftKey(queuedMessage);
    const editorDraftKey = queuedMessage.creation
      ? `pending-task:${queuedMessage.messageId}`
      : null;
    const currentDrafts = appAtomRegistry.get(composerDraftsAtom);
    const blockedAttachments = currentDrafts[draftKey]?.attachments;
    const editorAttachments =
      editorDraftKey === null ? undefined : currentDrafts[editorDraftKey]?.attachments;
    const unsubscribe = appAtomRegistry.subscribe(composerDraftsAtom, (drafts) => {
      if (
        drafts[draftKey]?.attachments === blockedAttachments &&
        (editorDraftKey === null || drafts[editorDraftKey]?.attachments === editorAttachments)
      ) {
        return;
      }
      const active = blockedRecoveries.get(queuedMessage.messageId);
      if (!active) {
        return;
      }
      blockedRecoveries.delete(queuedMessage.messageId);
      active.unsubscribe();
      drain();
    });
    blockedRecoveries.set(queuedMessage.messageId, { message: queuedMessage, unsubscribe });
    return true;
  };

  const sendQueuedMessage = async (
    queuedMessage: QueuedThreadMessage,
    thread: EnvironmentThreadShell,
  ): Promise<boolean> => {
    const hasAccess = () =>
      readEnvironmentScope(queuedMessage.environmentId, AuthOrchestrationOperateScope);
    if (!hasAccess()) return true;
    const serverConfig = appAtomRegistry.get(
      serverEnvironment.configValueAtom(queuedMessage.environmentId),
    );
    if (!serverConfig) return false;
    const settings = resolveQueuedThreadSettings(queuedMessage, thread, serverConfig.providers);
    if (isModelSelectionUnavailable(serverConfig, settings.modelSelection, thread.projectId)) {
      const { title, detail } = describeUnavailableModelSelection(
        serverConfig,
        settings.modelSelection,
        thread.projectId,
      );
      return restoreQueuedMessage(queuedMessage, `${title}. ${detail}`);
    }
    // The server would refuse this mode in settings sync, which retries forever; stop first.
    const runtimeModeDenial = managedRuntimeModeDenial(
      serverConfig.managedPolicy,
      settings.runtimeMode,
    );
    if (runtimeModeDenial !== undefined) {
      return restoreQueuedMessage(queuedMessage, runtimeModeDenial);
    }

    if (settings.runtimeMode !== thread.runtimeMode) {
      if (!hasAccess()) return true;
      setQueuedMessageStatus(queuedMessage.messageId, "syncing the thread's settings");
      const runtimeResult = await runDeliveryCommand(threadEnvironment.setRuntimeMode, {
        environmentId: queuedMessage.environmentId,
        input: {
          commandId: settingsCommandId(queuedMessage, "runtime-mode"),
          threadId: queuedMessage.threadId,
          runtimeMode: settings.runtimeMode,
          createdAt: queuedMessage.createdAt,
        },
      });
      if (AsyncResult.isFailure(runtimeResult)) {
        reportCommandFailure(queuedMessage, runtimeResult, "settings-sync");
        return false;
      }
    }

    if (settings.interactionMode !== thread.interactionMode) {
      if (!hasAccess()) return true;
      setQueuedMessageStatus(queuedMessage.messageId, "syncing the thread's settings");
      const interactionResult = await runDeliveryCommand(threadEnvironment.setInteractionMode, {
        environmentId: queuedMessage.environmentId,
        input: {
          commandId: settingsCommandId(queuedMessage, "interaction-mode"),
          threadId: queuedMessage.threadId,
          interactionMode: settings.interactionMode,
          createdAt: queuedMessage.createdAt,
        },
      });
      if (AsyncResult.isFailure(interactionResult)) {
        reportCommandFailure(queuedMessage, interactionResult, "settings-sync");
        return false;
      }
    }

    let prepared: PreparedTurnAttachments;
    let persistedMessage: QueuedThreadMessage;
    let deliveryRevision: number;
    if (!hasAccess()) return true;
    try {
      const preparedResult = await prepareQueuedMessageAttachments(queuedMessage);
      if (preparedResult.status === "abandoned") {
        return true;
      }
      prepared = preparedResult.prepared;
      persistedMessage = preparedResult.persistedMessage;
      deliveryRevision = preparedResult.deliveryRevision;
      if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId]) {
        await preserveUploadedAttachmentsForEditor(queuedMessage, preparedResult.persistedMessage);
        return true;
      }
    } catch (error) {
      if (!hasAccess()) return true;
      logThreadOutboxUploadFailure(queuedMessage, error);
      if (!shouldRetryThreadOutboxDelivery(error)) {
        return restoreQueuedMessage(
          queuedMessage,
          error instanceof Error ? error.message : "An attachment could not upload.",
        );
      }
      return false;
    }
    if (!isQueuedMessagePayloadCurrent(persistedMessage, deliveryRevision)) {
      return true;
    }
    const currentConfig = appAtomRegistry.get(
      serverEnvironment.configValueAtom(queuedMessage.environmentId),
    );
    if (!currentConfig) return false;
    if (isModelSelectionUnavailable(currentConfig, settings.modelSelection, thread.projectId)) {
      const { title, detail } = describeUnavailableModelSelection(
        currentConfig,
        settings.modelSelection,
        thread.projectId,
      );
      return restoreQueuedMessage(persistedMessage, `${title}. ${detail}`);
    }
    const sendSettings = resolveQueuedThreadSettings(
      queuedMessage,
      settings,
      currentConfig.providers,
    );
    if (queuedMessage.compactBeforeSend === true) {
      if (!hasAccess()) return true;
      // Queued, since steering a running turn with a compaction is rejected.
      setQueuedMessageStatus(queuedMessage.messageId, "compacting the thread first");
      const compactionResult = await runDeliveryCommand(threadEnvironment.startTurn, {
        environmentId: queuedMessage.environmentId,
        input: {
          commandId: settingsCommandId(queuedMessage, "compact"),
          creationSource: "mobile",
          threadId: queuedMessage.threadId,
          message: {
            messageId: MessageId.make(`${queuedMessage.messageId}:compact`),
            role: "user",
            text: "/compact",
            attachments: [],
            idleCompaction: "onReturn",
          },
          modelSelection: sendSettings.modelSelection,
          runtimeMode: sendSettings.runtimeMode,
          interactionMode: sendSettings.interactionMode,
          createdAt: queuedMessage.createdAt,
          dispatchMode: "queue",
          resendAfterSocketLoss: false,
        },
      });
      if (AsyncResult.isFailure(compactionResult) && !hasAccess()) return true;
      const compactionFailure = reportCommandFailure(queuedMessage, compactionResult, "start-turn");
      if (compactionFailure?.action === "retry") return false;
      if (compactionFailure?.action === "restore") {
        return restoreQueuedMessage(persistedMessage, compactionFailure.message);
      }
      if (!isQueuedMessagePayloadCurrent(persistedMessage, deliveryRevision)) return true;
    }
    if (!hasAccess()) return true;
    setQueuedMessageStatus(queuedMessage.messageId, "waiting for the server to accept the message");
    const deliveryResult = await runDeliveryCommand(threadEnvironment.startTurn, {
      environmentId: queuedMessage.environmentId,
      input: {
        commandId: queuedMessage.commandId,
        creationSource: "mobile",
        threadId: queuedMessage.threadId,
        message: {
          messageId: queuedMessage.messageId,
          role: "user",
          ...serializeComposerMessageForServer(
            queuedMessage.text,
            uploadedComposerContext(
              queuedMessage.context,
              queuedMessage.attachments,
              prepared.attachments,
            ),
          ),
          attachments: prepared.attachments,
        },
        modelSelection: sendSettings.modelSelection,
        titleSeed: deriveThreadTitleSeed({
          text: queuedMessage.text,
          attachments: queuedMessage.attachments,
        }),
        runtimeMode: sendSettings.runtimeMode,
        interactionMode: sendSettings.interactionMode,
        createdAt: queuedMessage.createdAt,
        dispatchMode: queuedMessage.dispatchMode ?? "start",
        ...(queuedMessage.freshContext ? { freshContext: true } : {}),
        resendAfterSocketLoss: false,
      },
    });
    if (AsyncResult.isFailure(deliveryResult) && !hasAccess()) return true;
    const failure = reportCommandFailure(queuedMessage, deliveryResult, "start-turn");
    if (failure?.action === "retry") {
      return false;
    }
    if (failure?.action === "restore") {
      return restoreQueuedMessage(persistedMessage, failure.message);
    }
    acknowledgedExistingThreadMessageIds.add(persistedMessage.messageId);
    const delivered =
      (await completeQueuedMessageDelivery(
        persistedMessage,
        deliveryRevision,
        deliveredSequence(deliveryResult),
      )) === "removed";
    if (delivered) {
      acknowledgedExistingThreadMessageIds.delete(persistedMessage.messageId);
    }
    return delivered;
  };

  const sendQueuedCreation = async (
    queuedMessage: QueuedThreadMessage,
    creation: QueuedThreadCreation,
    projectCwd: string,
  ): Promise<boolean> => {
    const hasAccess = () =>
      readEnvironmentScope(queuedMessage.environmentId, AuthOrchestrationOperateScope);
    if (!hasAccess()) return true;
    const modelSelection = queuedMessage.modelSelection;
    if (modelSelection === undefined) {
      return false;
    }
    const serverConfig = appAtomRegistry.get(
      serverEnvironment.configValueAtom(queuedMessage.environmentId),
    );
    if (!serverConfig) return false;
    const settings = resolveQueuedThreadSettings(
      queuedMessage,
      {
        modelSelection,
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      },
      serverConfig.providers,
    );
    if (isModelSelectionUnavailable(serverConfig, settings.modelSelection, creation.projectId)) {
      const { title, detail } = describeUnavailableModelSelection(
        serverConfig,
        settings.modelSelection,
        creation.projectId,
      );
      return restoreQueuedMessage(queuedMessage, `${title}. ${detail}`);
    }
    const runtimeModeDenial = managedRuntimeModeDenial(
      serverConfig.managedPolicy,
      settings.runtimeMode,
    );
    if (runtimeModeDenial !== undefined) {
      return restoreQueuedMessage(queuedMessage, runtimeModeDenial);
    }
    let prepared: PreparedTurnAttachments;
    let persistedMessage: QueuedThreadMessage;
    let deliveryRevision: number;
    try {
      const preparedResult = await prepareQueuedMessageAttachments(queuedMessage);
      if (preparedResult.status === "abandoned") {
        return true;
      }
      prepared = preparedResult.prepared;
      persistedMessage = preparedResult.persistedMessage;
      deliveryRevision = preparedResult.deliveryRevision;
      if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId]) {
        await preserveUploadedAttachmentsForEditor(queuedMessage, preparedResult.persistedMessage);
        return true;
      }
    } catch (error) {
      if (!hasAccess()) return true;
      logThreadOutboxUploadFailure(queuedMessage, error);
      if (!shouldRetryThreadOutboxDelivery(error)) {
        return restoreQueuedMessage(
          queuedMessage,
          error instanceof Error ? error.message : "An attachment could not upload.",
        );
      }
      return false;
    }
    if (!isQueuedMessagePayloadCurrent(persistedMessage, deliveryRevision)) {
      return true;
    }
    const currentConfig = appAtomRegistry.get(
      serverEnvironment.configValueAtom(queuedMessage.environmentId),
    );
    if (!currentConfig) return false;
    if (isModelSelectionUnavailable(currentConfig, settings.modelSelection, creation.projectId)) {
      const { title, detail } = describeUnavailableModelSelection(
        currentConfig,
        settings.modelSelection,
        creation.projectId,
      );
      return restoreQueuedMessage(persistedMessage, `${title}. ${detail}`);
    }
    const sendSettings = resolveQueuedThreadSettings(
      queuedMessage,
      settings,
      currentConfig.providers,
    );
    if (!hasAccess()) return true;
    let workspace = creation;
    if (creation.pullRequestReference) {
      setQueuedMessageStatus(queuedMessage.messageId, "checking out the pull request");
      const checkout = await runDeliveryCommand(gitEnvironment.preparePullRequestThread, {
        environmentId: queuedMessage.environmentId,
        input: { cwd: projectCwd, reference: creation.pullRequestReference, mode: "worktree" },
      });
      if (!isQueuedMessagePayloadCurrent(persistedMessage, deliveryRevision) || !hasAccess())
        return true;
      const failure = reportCommandFailure(queuedMessage, checkout, "start-turn");
      if (failure?.action === "retry") return false;
      if (failure?.action === "restore")
        return restoreQueuedMessage(persistedMessage, failure.message);
      if (!AsyncResult.isSuccess(checkout)) return false;
      if (!checkout.value.worktreePath || !checkout.value.isOnPullRequestHead) {
        const { shortLabel } = (
          sourceControlClients.findByChangeRequestUrl(creation.pullRequestReference) ??
          sourceControlClients.get(undefined)
        ).changeRequest;
        return restoreQueuedMessage(
          persistedMessage,
          `The ${shortLabel} worktree has local changes and could not update to the ${shortLabel} head. Resolve them before trying again.`,
        );
      }
      workspace = {
        ...creation,
        workspaceMode: "local",
        branch: checkout.value.branch,
        worktreePath: checkout.value.worktreePath,
        startFromOrigin: false,
      };
    }
    setQueuedMessageStatus(queuedMessage.messageId, "waiting for the server to accept the message");
    const deliveryResult = await runDeliveryCommand(threadEnvironment.startTurn, {
      environmentId: queuedMessage.environmentId,
      input: buildProjectThreadStartTurnInput({
        projectId: creation.projectId,
        projectCwd,
        threadId: queuedMessage.threadId,
        commandId: queuedMessage.commandId,
        messageId: queuedMessage.messageId,
        createdAt: queuedMessage.createdAt,
        titleText: queuedMessage.text,
        ...serializeComposerMessageForServer(
          queuedMessage.text.trim(),
          uploadedComposerContext(
            queuedMessage.context,
            queuedMessage.attachments,
            prepared.attachments,
          ),
        ),
        uploadedAttachments: prepared.attachments,
        modelSelection: sendSettings.modelSelection,
        runtimeMode: sendSettings.runtimeMode,
        interactionMode: sendSettings.interactionMode,
        workspaceMode: workspace.workspaceMode,
        branch: workspace.branch,
        worktreePath: workspace.worktreePath,
        startFromOrigin: workspace.startFromOrigin ?? false,
        worktreeBranchName: buildTemporaryWorktreeBranchName(randomHex),
      }),
    });
    if (AsyncResult.isFailure(deliveryResult) && !hasAccess()) return true;
    const failure = reportCommandFailure(queuedMessage, deliveryResult, "start-turn");
    if (failure?.action === "retry") {
      return false;
    }
    if (failure?.action === "restore") {
      return restoreQueuedMessage(persistedMessage, failure.message);
    }
    recordPendingThreadCreationOutcome({ kind: "delivered", message: persistedMessage });
    const outcome = await completeQueuedMessageDelivery(
      persistedMessage,
      deliveryRevision,
      deliveredSequence(deliveryResult),
    );
    if (outcome === "edited") {
      if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[queuedMessage.messageId]) {
        return true;
      }
      return recoverEditedCreationAfterDelivery(persistedMessage);
    }
    return outcome === "removed";
  };

  // A pass writes atoms the pass reads (family mounts, the dispatch slot), and the registry
  // notifies subscribers synchronously, so drain() can be called from inside a pass. That call
  // only asks for another pass; a nested pass would decide from inputs the outer one is still
  // acting on and could start a second delivery.
  let draining = false;
  let drainRequested = false;
  function drain(): void {
    if (disposed) return;
    if (draining) {
      drainRequested = true;
      return;
    }
    draining = true;
    try {
      do {
        if (disposed) return;
        drainRequested = false;
        drainPass();
      } while (drainRequested);
    } finally {
      draining = false;
    }
  }

  function drainPass(): void {
    const {
      dispatchingQueuedMessageIds,
      editingQueuedMessageIds,
      queuedMessagesByThreadKey,
      shellStatuses,
      threads,
      projects,
      serverConfigs,
      connectedEnvironments,
      operableEnvironments,
    } = appAtomRegistry.get(deliveryInputsAtom);
    const queuedMessageIds = new Set(
      Object.values(queuedMessagesByThreadKey)
        .flat()
        .map((message) => message.messageId),
    );
    for (const messageId of Object.keys(
      appAtomRegistry.get(queuedMessageWaitReasonsAtom),
    ) as Array<MessageId>) {
      if (!queuedMessageIds.has(messageId)) setQueuedMessageStatus(messageId, null);
    }
    let inFlight = Object.keys(dispatchingQueuedMessageIds).length;

    for (const messageId of acknowledgedExistingThreadMessageIds) {
      if (!queuedMessageIds.has(messageId)) {
        acknowledgedExistingThreadMessageIds.delete(messageId);
      }
    }
    for (const messageId of retries.keys()) {
      if (!queuedMessageIds.has(messageId)) clearRetry(messageId);
    }
    for (const [messageId, release] of familyMounts) {
      if (!queuedMessageIds.has(messageId)) {
        release();
        familyMounts.delete(messageId);
      }
    }

    for (const [threadKey, queuedMessages] of Object.entries(queuedMessagesByThreadKey)) {
      const nextQueuedMessage = queuedMessages[0];
      if (!nextQueuedMessage) {
        continue;
      }
      for (const later of queuedMessages.slice(1)) {
        setQueuedMessageStatus(later.messageId, "waiting for the earlier message in this thread");
      }
      const messageId = nextQueuedMessage.messageId;
      if (dispatchingQueuedMessageIds[messageId]) {
        continue;
      }
      if (inFlight >= MAX_PARALLEL_DELIVERIES) {
        setQueuedMessageStatus(messageId, "waiting for other messages to finish sending");
        continue;
      }
      if (
        nextQueuedMessage.creation === undefined &&
        acknowledgedExistingThreadMessageIds.has(messageId)
      ) {
        if (retryNotBefore(messageId) > Date.now()) {
          continue;
        }
        beginDispatchingQueuedMessage(messageId);
        settle(
          messageId,
          removeAcknowledgedExistingThreadMessage(
            nextQueuedMessage,
            acknowledgedExistingThreadMessageIds,
          ),
        );
        inFlight += 1;
        continue;
      }
      if (editingQueuedMessageIds[messageId]) {
        setQueuedMessageStatus(messageId, "open for editing");
        continue;
      }
      const blockedRecovery = blockedRecoveries.get(messageId);
      if (blockedRecovery) {
        if (blockedRecovery.message === nextQueuedMessage) {
          setQueuedMessageStatus(messageId, "waiting for you to remove attachments from the draft");
          continue;
        }
        blockedRecoveries.delete(messageId);
        blockedRecovery.unsubscribe();
      }
      if (retryNotBefore(messageId) > Date.now()) {
        if (appAtomRegistry.get(queuedMessageWaitReasonsAtom)[messageId] === undefined) {
          setQueuedMessageStatus(messageId, "the last send failed, retrying shortly");
        }
        continue;
      }

      let thread = findThread(threads, nextQueuedMessage);
      if (thread && scopedThreadKey(thread.environmentId, thread.id) !== threadKey) {
        continue;
      }

      const creation = nextQueuedMessage.creation;
      const environment = connectedEnvironments.find(
        (candidate) => candidate.environmentId === nextQueuedMessage.environmentId,
      );
      const shellStatus = shellStatuses.get(nextQueuedMessage.environmentId) ?? "empty";
      const serverConfig = serverConfigs.get(nextQueuedMessage.environmentId);
      let familyRead: ThreadFamilyRead | undefined;
      if (
        thread === undefined &&
        creation === undefined &&
        serverConfig?.shellThreadFamilies === true
      ) {
        // The family keeps the row readable through dispatch once it loads; the current shell
        // generation's read decides whether the thread is gone.
        if (!familyMounts.has(nextQueuedMessage.messageId)) {
          familyMounts.set(
            nextQueuedMessage.messageId,
            threadFamilies.mount(
              appAtomRegistry,
              nextQueuedMessage.environmentId,
              nextQueuedMessage.threadId,
            ),
          );
        }
        familyRead = threadFamilyRead(
          appAtomRegistry.get(
            threadFamilies.familyAtom(nextQueuedMessage.environmentId, nextQueuedMessage.threadId),
          ),
        );
        if (familyRead === "settled") {
          // The rows read at the start of this pass can lag the family that just settled;
          // decide from the merged rows as they are now.
          thread = findThread(
            appAtomRegistry.get(environmentThreadShells.threadShellsAtom),
            nextQueuedMessage,
          );
        } else if (familyRead === "failed") {
          threadFamilies.refresh(
            appAtomRegistry,
            nextQueuedMessage.environmentId,
            nextQueuedMessage.threadId,
          );
        }
      }
      const deliveryAction = resolveThreadOutboxDeliveryAction({
        isCreation: creation !== undefined,
        threadExists: thread !== undefined,
        shellStatus,
        environmentConnected: environment?.connectionState === "connected",
        ...(familyRead === undefined ? {} : { familyRead }),
      });
      if (
        deliveryAction === "wait" &&
        shellStatus === "live" &&
        familyRead !== undefined &&
        familyRead !== "settled"
      ) {
        // An empty family read changes no merged row, so nothing else would wake the drain.
        scheduleRetry(messageId);
        continue;
      }
      if (deliveryAction === "send" && !operableEnvironments.has(nextQueuedMessage.environmentId)) {
        setQueuedMessageStatus(messageId, "this session's send permission is not loaded");
        continue;
      }
      const dispatchStep = resolveThreadOutboxDispatchStep({
        deliveryAction,
        fileAttachments: nextQueuedMessage.attachments.filter(
          (attachment) => attachment.type === "file",
        ),
        serverConfig: serverConfig
          ? {
              maxFileUploadBytes:
                serverConfig.environment.capabilities.fileAttachments?.maxUploadBytes,
            }
          : null,
      });
      if (dispatchStep.step === "wait") {
        setQueuedMessageStatus(
          messageId,
          environment?.connectionState !== "connected"
            ? "the environment is not connected"
            : shellStatus !== "live"
              ? "the thread list is still syncing"
              : "the thread is not loaded yet",
        );
        continue;
      }
      if (dispatchStep.step === "retry") {
        setQueuedMessageStatus(messageId, "the server's settings have not loaded");
        scheduleRetry(messageId);
        continue;
      }
      if (dispatchStep.step === "restore") {
        const attachmentError = dispatchStep.reason;
        beginDispatchingQueuedMessage(messageId);
        settle(
          messageId,
          confirmThreadOutboxMessageQueued(nextQueuedMessage).then((queued) =>
            !queued || appAtomRegistry.get(editingQueuedMessageIdsAtom)[messageId]
              ? true
              : restoreQueuedMessage(nextQueuedMessage, attachmentError),
          ),
        );
        inFlight += 1;
        continue;
      }
      const creationProjectCwd =
        creation !== undefined
          ? (findCreationProject(projects, nextQueuedMessage)?.workspaceRoot ??
            creation.projectCwd ??
            null)
          : null;
      if (deliveryAction === "send" && creation !== undefined) {
        if (!isQueuedThreadCreationSendable(nextQueuedMessage)) {
          setQueuedMessageStatus(messageId, "the new task is missing details");
          continue;
        }
        if (creationProjectCwd === null && shellStatus !== "live") {
          setQueuedMessageStatus(messageId, "the project list is still syncing");
          continue;
        }
      }

      beginDispatchingQueuedMessage(messageId);
      const removeQueuedMessage = (warning: string) =>
        removeThreadOutboxMessage(nextQueuedMessage).then(
          () => true,
          (error) => {
            console.warn(warning, {
              environmentId: nextQueuedMessage.environmentId,
              threadId: nextQueuedMessage.threadId,
              messageId,
              error,
            });
            return false;
          },
        );
      // Confirm durability before sending; optimistic enqueue can still roll back on write failure.
      const delivery = confirmThreadOutboxMessageQueued(nextQueuedMessage).then((queued) => {
        if (!queued) {
          return true;
        }
        // Re-check editor ownership after confirmation; return true to defer without failure backoff.
        if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[messageId]) {
          return true;
        }
        if (deliveryAction === "send") {
          const liveThread = findThread(
            appAtomRegistry.get(environmentThreadShells.threadShellsAtom),
            nextQueuedMessage,
          );
          const liveDeliveryAction = resolveThreadOutboxDeliveryAction({
            isCreation: creation !== undefined,
            threadExists: liveThread !== undefined,
            shellStatus,
            environmentConnected: environment?.connectionState === "connected",
          });
          if (liveDeliveryAction !== "send") {
            return true;
          }
        }
        return deliveryAction === "remove"
          ? creation !== undefined
            ? // After restart, always recover delivered creations; lost in-memory state cannot distinguish edits from duplicate payloads.
              recoverEditedCreationAfterDelivery(nextQueuedMessage)
            : removeQueuedMessage("[thread-outbox] failed to remove message for a missing thread")
          : creation !== undefined
            ? creationProjectCwd !== null
              ? sendQueuedCreation(nextQueuedMessage, creation, creationProjectCwd)
              : removeQueuedMessage("[thread-outbox] dropped pending task for a missing project")
            : thread !== undefined
              ? sendQueuedMessage(nextQueuedMessage, thread)
              : Promise.resolve(false);
      });
      settle(messageId, delivery);
      inFlight += 1;
      continue;
    }
  }

  const stopDraining = appAtomRegistry.subscribe(deliveryInputsAtom, drain, { immediate: true });
  const stopCollectingOutcomes = appAtomRegistry.subscribe(
    settledCreationOutcomeKeysAtom,
    (threadKeys) => {
      for (const threadKey of threadKeys) clearPendingThreadCreationOutcome(threadKey);
    },
    { immediate: true },
  );

  return {
    drain,
    retryNow,
    dispose: () => {
      disposed = true;
      stopDraining();
      stopCollectingOutcomes();
      for (const retry of retries.values()) clearTimeout(retry.timer);
      retries.clear();
      appAtomRegistry.set(retryingQueuedMessageIdsAtom, {});
      for (const blocked of blockedRecoveries.values()) blocked.unsubscribe();
      blockedRecoveries.clear();
      for (const release of familyMounts.values()) release();
      familyMounts.clear();
    },
  };
}

function loadThreadOutbox(isActive: () => boolean): void {
  void threadOutboxManager.load().then((loaded) => {
    if (loaded || !isActive()) return;
    Dialog.alert(
      "Some queued messages could not be loaded",
      "Unreadable records and attachment files are still saved. Other messages can still be sent.",
      [
        { text: "Dismiss", style: "cancel" },
        { text: "Retry", onPress: () => loadThreadOutbox(isActive) },
      ],
    );
  });
}

let activeDelivery: ReturnType<typeof createThreadOutboxDelivery> | null = null;

/** Skips a queued message's backoff and restarts a send that is stuck in flight. */
export function retryQueuedMessageNow(messageId: MessageId): void {
  activeDelivery?.retryNow(messageId);
}

/** App-lifetime: loads the persisted outbox and delivers queued messages. */
export function installThreadOutboxDelivery(): () => void {
  let active = true;
  loadThreadOutbox(() => active);
  const delivery = createThreadOutboxDelivery();
  activeDelivery = delivery;
  return () => {
    active = false;
    if (activeDelivery === delivery) activeDelivery = null;
    delivery.dispose();
  };
}
