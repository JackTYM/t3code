import { resolveAssistantReplyEditing } from "@t3tools/client-runtime/state/thread-workflows";
import {
  ORCHESTRATION_V2_REPLY_EDIT_MAX_TEXT_LENGTH,
  type MessageId,
  type OrchestrationV2ProjectedTurnItem,
  type ThreadId,
} from "@t3tools/contracts";
import { ChevronLeftIcon, ChevronRightIcon, PencilIcon } from "lucide-react";
import { useState, type KeyboardEvent } from "react";

import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface AssistantReplyEditingControls {
  /** Rows inherited from a parent thread are that thread's history, not this one's. */
  readonly threadId: ThreadId;
  /** The thread's provider can rewrite its own history and this client may operate the thread. */
  readonly supported: boolean;
  readonly onEdit: (messageId: MessageId, text: string) => Promise<boolean>;
  readonly onSelectVersion: (messageId: MessageId, version: number) => Promise<void>;
}

export function AssistantReplyEditControls({
  item,
  controls,
  threadBusy,
  onStartEditing,
}: {
  readonly item: OrchestrationV2ProjectedTurnItem["item"];
  readonly controls: AssistantReplyEditingControls | null;
  readonly threadBusy: boolean;
  readonly onStartEditing: () => void;
}) {
  const [switching, setSwitching] = useState(false);
  if (item.type !== "assistant_message") return null;
  const editing = resolveAssistantReplyEditing({
    item,
    providerSupportsReplyEditing: controls?.supported,
    threadBusy: threadBusy || switching,
  });
  const versions = editing.versions;
  if (!editing.canEdit && versions === null) return null;
  const select = (version: number) => {
    if (controls === null) return;
    setSwitching(true);
    void controls.onSelectVersion(item.messageId, version).finally(() => setSwitching(false));
  };

  return (
    <div className="flex items-center gap-0.5">
      {versions !== null ? (
        <>
          <Tooltip>
            <TooltipTrigger
              render={<span className="me-1 text-muted-foreground text-xs" tabIndex={0} />}
            >
              Edited
            </TooltipTrigger>
            <TooltipPopup side="top">
              The agent reads the selected version as what it said. The original is kept.
            </TooltipPopup>
          </Tooltip>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            disabled={!editing.canEdit || versions.selected <= 1}
            onClick={() => select(versions.selected - 1)}
            aria-label="Previous version"
          >
            <ChevronLeftIcon className="size-3" />
          </Button>
          <span
            className="min-w-7 text-center text-muted-foreground text-xs tabular-nums"
            aria-label={`Version ${versions.selected} of ${versions.count}`}
          >
            {versions.selected}/{versions.count}
          </span>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            disabled={!editing.canEdit || versions.selected >= versions.count}
            onClick={() => select(versions.selected + 1)}
            aria-label="Next version"
          >
            <ChevronRightIcon className="size-3" />
          </Button>
        </>
      ) : null}
      {editing.canEdit ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={onStartEditing}
                aria-label="Edit reply"
              />
            }
          >
            <PencilIcon className="size-3" />
          </TooltipTrigger>
          <TooltipPopup side="top">Edit what the agent said</TooltipPopup>
        </Tooltip>
      ) : null}
    </div>
  );
}

export function AssistantReplyEditor({
  messageId,
  initialText,
  controls,
  onClose,
}: {
  readonly messageId: MessageId;
  readonly initialText: string;
  readonly controls: AssistantReplyEditingControls;
  readonly onClose: () => void;
}) {
  const [text, setText] = useState(initialText);
  const [saving, setSaving] = useState(false);
  const canSave = !saving && text.trim().length > 0 && text !== initialText;
  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    const saved = await controls.onEdit(messageId, text);
    setSaving(false);
    if (saved) onClose();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void save();
    }
  };

  return (
    <div className="flex flex-col gap-2 py-1">
      <Textarea
        aria-label="Edited reply"
        maxLength={ORCHESTRATION_V2_REPLY_EDIT_MAX_TEXT_LENGTH}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        disabled={saving}
        autoFocus
      />
      <p className="text-muted-foreground text-xs">
        The agent will treat this as what it said. Its next turn re-reads the conversation, so that
        turn misses the prompt cache once. The original stays available as version 1. Nothing it
        already did outside the conversation is undone.
      </p>
      <div className="flex items-center justify-end gap-2">
        <Button type="button" size="xs" variant="ghost" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button type="button" size="xs" onClick={() => void save()} disabled={!canSave}>
          {saving ? "Saving…" : "Save edit"}
        </Button>
      </div>
    </div>
  );
}
