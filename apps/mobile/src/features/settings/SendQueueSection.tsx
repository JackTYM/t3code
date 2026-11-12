import { useAtomValue } from "@effect/atom-react";
import { useMemo } from "react";
import { View } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow as SettingsActionRow } from "../../components/ui/ListActionRow";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { discardQueuedMessage, retryQueuedMessageNow } from "../../state/threadOutboxDelivery";
import type { QueuedThreadMessage } from "../../state/thread-outbox-model";
import {
  type ThreadOutboxLogEntry,
  queuedMessageWaitReasonsAtom,
  threadOutboxLogAtom,
  useThreadOutboxMessages,
} from "../../state/use-thread-outbox";
import { SettingsSection } from "./components/SettingsSection";

function describeQueuedAt(createdAt: string): string {
  const date = new Date(createdAt);
  return Number.isNaN(date.getTime())
    ? ""
    : `queued ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

function describeMessage(message: QueuedThreadMessage): string {
  const text = message.text.trim().replace(/\s+/g, " ");
  if (text.length > 0) return text.length > 60 ? `${text.slice(0, 57)}...` : text;
  return message.attachments.length > 0
    ? `${message.attachments.length} attachment${message.attachments.length === 1 ? "" : "s"}`
    : "Empty message";
}

function formatSendLog(
  log: ReadonlyArray<ThreadOutboxLogEntry>,
  messages: ReadonlyArray<QueuedThreadMessage>,
): string {
  const lines = log.map(
    (entry) => `${new Date(entry.at).toISOString()} ${entry.messageId.slice(0, 8)} ${entry.line}`,
  );
  const queued = messages.map(
    (message) =>
      `queued ${message.messageId.slice(0, 8)} thread ${message.threadId.slice(0, 8)} created ${message.createdAt} attachments ${message.attachments.length}`,
  );
  return [...queued, ...lines].join("\n");
}

/** Every message the phone has not delivered yet, why it is waiting, and how to unstick it. */
export function SendQueueSection() {
  const queues = useThreadOutboxMessages();
  const statuses = useAtomValue(queuedMessageWaitReasonsAtom);
  const log = useAtomValue(threadOutboxLogAtom);
  const messages = useMemo(
    () =>
      Object.values(queues)
        .flat()
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    [queues],
  );

  const openMessage = (message: QueuedThreadMessage) => {
    Dialog.alert(
      describeMessage(message),
      statuses[message.messageId] ?? "Queued",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Retry now", onPress: () => retryQueuedMessageNow(message.messageId) },
        {
          text: "Discard",
          style: "destructive",
          onPress: () => void discardQueuedMessage(message),
        },
      ],
      { cancelable: true },
    );
  };

  const confirmDiscardAll = () => {
    Dialog.confirm({
      title: "Discard all queued messages?",
      message: `This throws away ${messages.length} message${messages.length === 1 ? "" : "s"} that have not been delivered, including their attachments. Delivered messages and threads are not affected.`,
      confirmText: "Discard All",
      destructive: true,
      onConfirm: () => {
        for (const message of messages) void discardQueuedMessage(message);
      },
    });
  };

  return (
    <SettingsSection title="Send queue">
      {messages.length === 0 ? (
        <SettingsActionRow
          icon="checkmark.circle"
          label="Nothing waiting to send"
          description="Messages you send while offline or while the server is busy wait here."
          onPress={() => {}}
        />
      ) : (
        messages.map((message, index) => (
          <View
            key={message.messageId}
            className={index === 0 ? undefined : "border-t border-border"}
          >
            <SettingsActionRow
              icon="tray.and.arrow.up"
              label={describeMessage(message)}
              description={`${statuses[message.messageId] ?? "queued"} · ${describeQueuedAt(message.createdAt)}`}
              onPress={() => openMessage(message)}
            />
          </View>
        ))
      )}
      {messages.length > 0 ? (
        <View className="border-t border-border">
          <SettingsActionRow
            icon="trash"
            label={`Discard all ${messages.length} queued`}
            tone="danger"
            onPress={confirmDiscardAll}
          />
        </View>
      ) : null}
      <View className="border-t border-border">
        <SettingsActionRow
          icon="doc.on.doc"
          label="Copy send log"
          description={`${log.length} recent events, for diagnosing a stuck message`}
          onPress={() => copyTextWithHaptic(formatSendLog(log, messages))}
        />
      </View>
    </SettingsSection>
  );
}
