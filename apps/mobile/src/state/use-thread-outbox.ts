import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentShellStatus } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, MessageId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "./atom-registry";
import { environmentShell } from "./shell";
import { threadOutboxManager } from "./thread-outbox";

export const threadOutboxShellStatusesAtom = Atom.make(
  (get): ReadonlyMap<EnvironmentId, EnvironmentShellStatus> => {
    const statuses = new Map<EnvironmentId, EnvironmentShellStatus>();
    for (const queue of Object.values(get(threadOutboxManager.queuedMessagesByThreadKeyAtom))) {
      const environmentId = queue[0]?.environmentId;
      if (environmentId !== undefined && !statuses.has(environmentId)) {
        statuses.set(environmentId, get(environmentShell.stateValueAtom(environmentId)).status);
      }
    }
    return statuses;
  },
).pipe(Atom.withLabel("mobile:thread-outbox:shell-statuses"));

/** Do not deliver tasks still open in an editor or whose latest edits failed to save; their queued payloads are stale. */
export const editingQueuedMessageIdsAtom = Atom.make<Readonly<Record<MessageId, true>>>({}).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:thread-outbox:editing-message-ids"),
);

/** Messages with a delivery in flight. Each thread sends one at a time, but threads send in parallel. */
export const dispatchingQueuedMessageIdsAtom = Atom.make<
  Readonly<Partial<Record<MessageId, true>>>
>({}).pipe(Atom.keepAlive, Atom.withLabel("mobile:thread-outbox:dispatching-message-ids"));

/** Messages waiting out a retry backoff, which can repeat for as long as the failure lasts. */
export const retryingQueuedMessageIdsAtom = Atom.make<Readonly<Partial<Record<MessageId, true>>>>(
  {},
).pipe(Atom.keepAlive, Atom.withLabel("mobile:thread-outbox:retrying-message-ids"));

/** What a queued message is doing or waiting for, in words. Every queued message has one. */
export const queuedMessageWaitReasonsAtom = Atom.make<Readonly<Partial<Record<MessageId, string>>>>(
  {},
).pipe(Atom.keepAlive, Atom.withLabel("mobile:thread-outbox:wait-reasons"));

export interface ThreadOutboxLogEntry {
  readonly at: number;
  readonly messageId: MessageId;
  readonly line: string;
}

/** The most recent status changes and failures across all queued messages, newest last. */
export const threadOutboxLogAtom = Atom.make<ReadonlyArray<ThreadOutboxLogEntry>>([]).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:thread-outbox:log"),
);

export function useQueuedMessageWaitReason(messageId: MessageId): string | undefined {
  return useAtomValue(queuedMessageWaitReasonsAtom)[messageId];
}

export function holdEditingQueuedMessage(messageId: MessageId): void {
  const current = appAtomRegistry.get(editingQueuedMessageIdsAtom);
  if (current[messageId]) {
    return;
  }
  appAtomRegistry.set(editingQueuedMessageIdsAtom, { ...current, [messageId]: true });
}

export function releaseEditingQueuedMessage(messageId: MessageId): void {
  const current = appAtomRegistry.get(editingQueuedMessageIdsAtom);
  if (!current[messageId]) {
    return;
  }
  const next = { ...current };
  delete next[messageId];
  appAtomRegistry.set(editingQueuedMessageIdsAtom, next);
}

export function useThreadOutboxMessages() {
  return useAtomValue(threadOutboxManager.queuedMessagesByThreadKeyAtom);
}

export const queuedThreadKeysAtom = Atom.make((get): ReadonlySet<string> => {
  const keys = new Set<string>();
  for (const [threadKey, queue] of Object.entries(
    get(threadOutboxManager.queuedMessagesByThreadKeyAtom),
  )) {
    if (queue.some((message) => message.creation === undefined)) {
      keys.add(threadKey);
    }
  }
  return keys;
}).pipe(Atom.keepAlive, Atom.withLabel("mobile:thread-outbox:queued-thread-keys"));

export function useQueuedThreadKeys(): ReadonlySet<string> {
  return useAtomValue(queuedThreadKeysAtom);
}
