import { resolveAssistantReplyEditing } from "@t3tools/client-runtime/state/thread-workflows";
import {
  ORCHESTRATION_V2_REPLY_EDIT_MAX_TEXT_LENGTH,
  type EnvironmentId,
  type MessageId,
  type OrchestrationV2ProjectedTurnItem,
  type ThreadId,
} from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { useState } from "react";
import {
  type ColorValue,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";

export interface ThreadReplyEditing {
  /** The thread's provider can rewrite its own history and this client may operate the thread. */
  readonly supported: boolean;
  readonly threadBusy: boolean;
}

export function AssistantReplyEditControls(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly replyEditing: ThreadReplyEditing | null;
  readonly iconColor: ColorValue;
  /** Replies inside a turn have no action row; they only show versions once edited. */
  readonly allowStartEditing: boolean;
}) {
  const [editorOpen, setEditorOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const selectVersion = useAtomCommand(
    orchestrationEnvironment.selectAssistantMessageVersion,
    "switch reply version",
  );
  const item = props.projectedItem.item;
  // Rows inherited from a parent thread are that thread's history, not this one's.
  const ownRow = props.projectedItem.sourceThreadId === props.threadId;
  if (item.type !== "assistant_message") return null;
  const editing = resolveAssistantReplyEditing({
    item,
    providerSupportsReplyEditing: ownRow ? props.replyEditing?.supported : false,
    threadBusy: (props.replyEditing?.threadBusy ?? true) || switching,
  });
  const versions = editing.versions;
  const canStartEditing = editing.canEdit && props.allowStartEditing;
  if (!canStartEditing && versions === null) return null;
  const select = (version: number) => {
    setSwitching(true);
    void Haptics.selectionAsync();
    void selectVersion({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, messageId: item.messageId, version },
    }).finally(() => setSwitching(false));
  };

  return (
    <View className="flex-row items-center">
      {versions !== null ? (
        <>
          <Text className="me-1 font-t3-medium text-xs text-foreground-secondary">Edited</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Previous version"
            disabled={!editing.canEdit || versions.selected <= 1}
            onPress={() => select(versions.selected - 1)}
            className="h-7 w-7 items-center justify-center disabled:opacity-40"
          >
            <SymbolView name="chevron.left" size={12} tintColor={props.iconColor} />
          </Pressable>
          <Text
            accessibilityLabel={`Version ${versions.selected} of ${versions.count}`}
            className="font-t3-medium text-xs tabular-nums text-foreground-secondary"
          >
            {versions.selected}/{versions.count}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Next version"
            disabled={!editing.canEdit || versions.selected >= versions.count}
            onPress={() => select(versions.selected + 1)}
            className="h-7 w-7 items-center justify-center disabled:opacity-40"
          >
            <SymbolView name="chevron.right" size={12} tintColor={props.iconColor} />
          </Pressable>
        </>
      ) : null}
      {canStartEditing ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Edit reply"
          onPress={() => setEditorOpen(true)}
          className="h-7 w-7 items-center justify-center"
        >
          <SymbolView name="pencil" size={13} tintColor={props.iconColor} />
        </Pressable>
      ) : null}
      {editorOpen ? (
        <AssistantReplyEditSheet
          environmentId={props.environmentId}
          threadId={props.threadId}
          messageId={item.messageId}
          initialText={item.text}
          onClose={() => setEditorOpen(false)}
        />
      ) : null}
    </View>
  );
}

function AssistantReplyEditSheet(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly initialText: string;
  readonly onClose: () => void;
}) {
  const [text, setText] = useState(props.initialText);
  const [saving, setSaving] = useState(false);
  const editReply = useAtomCommand(orchestrationEnvironment.editAssistantMessage, "edit reply");
  const canSave = !saving && text.trim().length > 0 && text !== props.initialText;
  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    const result = await editReply({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, messageId: props.messageId, text },
    });
    setSaving(false);
    if (result._tag === "Success") props.onClose();
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={props.onClose}>
      <KeyboardAvoidingView
        className="flex-1 items-center justify-center bg-backdrop px-4"
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          className="max-h-[85%] w-full max-w-xl grow-0 rounded-3xl bg-screen"
          keyboardShouldPersistTaps="handled"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ padding: 20, gap: 14 }}
        >
          <Text accessibilityRole="header" className="text-xl font-t3-semibold">
            Edit reply
          </Text>
          <TextInput
            accessibilityLabel="Edited reply"
            maxLength={ORCHESTRATION_V2_REPLY_EDIT_MAX_TEXT_LENGTH}
            className="min-h-40 rounded-xl bg-subtle px-3 py-2 text-base text-foreground"
            multiline
            textAlignVertical="top"
            autoFocus
            editable={!saving}
            value={text}
            onChangeText={setText}
          />
          <Text className="text-sm text-foreground-secondary">
            The agent will treat this as what it said. Its next turn re-reads the conversation, so
            that turn misses the prompt cache once. The original stays available as version 1.
            Nothing it already did outside the conversation is undone.
          </Text>
          <View className="flex-row justify-end gap-3">
            <Pressable
              accessibilityRole="button"
              className="min-h-12 justify-center px-3"
              disabled={saving}
              onPress={props.onClose}
            >
              <Text>Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: !canSave }}
              className="min-h-12 justify-center rounded-xl bg-subtle px-3 disabled:opacity-40"
              disabled={!canSave}
              onPress={() => void save()}
            >
              <Text className="text-foreground">{saving ? "Saving…" : "Save edit"}</Text>
            </Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}
