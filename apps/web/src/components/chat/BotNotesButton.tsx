import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  selectEnvironmentQueryData,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import type { BotFileKind, BotFilesReadResult, ScopedThreadRef } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { BotIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState, type FormEvent } from "react";

import { useLiveRefresh } from "~/hooks/useLiveRefresh";
import { useThreadGroupingActions } from "~/hooks/useThreadGroupingActions";
import { m } from "~/i18n/messages";
import { botFilesEnvironment } from "~/state/botFiles";
import { useQuietThreadShell } from "~/state/entities";
import {
  useEnvironmentQuery,
  useEnvironmentQueryRefresh,
  useEnvironmentQuerySelector,
} from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Label } from "../ui/label";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { BotMailView } from "./BotMailView";
import { BotTasksView } from "./BotTasksView";
import { BotWatchersView } from "./BotWatchersView";
import { botWatchersNeedingYou } from "./BotWatchersView.logic";

// tasks.md is edited as a list in the Tasks view, not as text.
const FILES: ReadonlyArray<Exclude<BotFileKind, "tasks">> = ["notes", "preferences"];

function BotFilesForm(props: {
  threadRef: ScopedThreadRef;
  files: BotFilesReadResult;
  canWrite: boolean;
}) {
  const gt = useGT();
  const write = useAtomCommand(botFilesEnvironment.write, { reportFailure: false });
  const [saving, setSaving] = useState(false);
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setSaving(true);
    for (const file of FILES) {
      const contents = String(form.get(file) ?? "");
      if (contents === props.files[file]) continue;
      const result = await write({
        environmentId: props.threadRef.environmentId,
        input: { threadId: props.threadRef.threadId, file, contents },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        toastManager.add({
          type: "error",
          title: gt("Failed to save Bot notes"),
          description:
            thrownErrorMessage(squashAtomCommandFailure(result), m) ?? gt("An error occurred."),
        });
        break;
      }
    }
    setSaving(false);
  };
  return (
    <form className="flex flex-col gap-3" onSubmit={save}>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="bot-notes">
          <T>Notes</T>
        </Label>
        <Textarea
          id="bot-notes"
          name="notes"
          rows={8}
          size="sm"
          defaultValue={props.files.notes}
          disabled={!props.canWrite}
          placeholder={gt("What the Bot keeps track of between turns.")}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="bot-preferences">
          <T>Preferences</T>
        </Label>
        <Textarea
          id="bot-preferences"
          name="preferences"
          rows={4}
          size="sm"
          defaultValue={props.files.preferences}
          disabled={!props.canWrite}
          placeholder={gt("How you like the Bot to work.")}
        />
      </div>
      <Button type="submit" size="sm" disabled={!props.canWrite || saving} className="self-end">
        <T>Save</T>
      </Button>
    </form>
  );
}

/** A Bot's memory files and crew muting, reachable from its header; Home's too. */
export function BotNotesButton(props: { threadRef: ScopedThreadRef }) {
  const gt = useGT();
  // The quiet shell skips streaming ticks, so the badge does not re-render with every token.
  const thread = useQuietThreadShell(props.threadRef);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"notes" | "tasks" | "watchers" | "mail">("notes");
  const canWrite = useAtomValue(
    botFilesEnvironment.write.permissionAtom(props.threadRef.environmentId),
  );
  const { setMuteCrew } = useThreadGroupingActions();
  const files = useEnvironmentQuery(
    open && view === "notes"
      ? botFilesEnvironment.files({
          environmentId: props.threadRef.environmentId,
          input: { threadId: props.threadRef.threadId },
        })
      : null,
  );
  const botConfig = thread?.botConfig;

  // The list shares its atom with the Watchers tab, so mounting this fetches it once. The server
  // pushes no watcher changes, so it is refetched on window return, popover close and a settled
  // run, never on a timer.
  const watchersAtom =
    botConfig == null
      ? null
      : botFilesEnvironment.watchers({
          environmentId: props.threadRef.environmentId,
          input: { threadId: props.threadRef.threadId },
        });
  const watchersData = useEnvironmentQuerySelector(watchersAtom, selectEnvironmentQueryData);
  const { refresh: refreshWatchers, isPending: watchersPending } =
    useEnvironmentQueryRefresh(watchersAtom);
  const needYou = watchersData === null ? 0 : botWatchersNeedingYou(watchersData.watchers);
  // A refresh restarts a read in flight, so one already running stands for this one.
  const refreshWatchersIfIdle = () => {
    if (!watchersPending()) refreshWatchers();
  };
  useLiveRefresh(refreshWatchersIfIdle, {
    enabled: botConfig != null,
    key: `bot-watchers:${props.threadRef.environmentId}:${props.threadRef.threadId}`,
    intervalMs: null,
  });
  const runCompletedAt = thread?.latestRun?.completedAt ?? null;
  const seenRunCompletedAt = useRef(runCompletedAt);
  const onRunSettled = useEffectEvent(refreshWatchersIfIdle);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a Bot's run is when it proposes a watcher, and nothing else pushes that to the client
  useEffect(() => {
    if (seenRunCompletedAt.current === runCompletedAt) return;
    seenRunCompletedAt.current = runCompletedAt;
    if (runCompletedAt !== null) onRunSettled();
  }, [runCompletedAt]);

  if (botConfig == null) return null;
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) refreshWatchersIfIdle();
      }}
    >
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            aria-label={
              needYou === 0
                ? gt("Bot notes")
                : needYou === 1
                  ? gt("Bot notes, 1 watcher needs you")
                  : gt("Bot notes, {count} watchers need you", { count: needYou })
            }
          />
        }
      >
        <BotIcon aria-hidden />
        <T>Bot</T>
        {needYou === 0 ? null : (
          <Badge variant="warning" size="sm" aria-hidden>
            {needYou}
          </Badge>
        )}
      </PopoverTrigger>
      <PopoverPopup width={view === "watchers" || view === "mail" ? "xl" : "lg"} align="end">
        <div className="flex flex-col gap-3">
          <PopoverTitle>
            <T>Bot notes</T>
          </PopoverTitle>
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="bot-mute-crew">
              <T>Mute crew noise</T>
            </Label>
            <Switch
              id="bot-mute-crew"
              size="sm"
              checked={botConfig.muteChildren}
              disabled={!canWrite}
              onCheckedChange={(checked) => void setMuteCrew(props.threadRef, checked)}
            />
          </div>
          <ToggleGroup
            aria-label={gt("Bot view")}
            className="w-full *:flex-1"
            value={[view]}
            onValueChange={(next) => {
              const value = next[0];
              if (
                value === "notes" ||
                value === "tasks" ||
                value === "watchers" ||
                value === "mail"
              ) {
                setView(value);
              }
            }}
          >
            <Toggle value="notes">
              <T>Notes</T>
            </Toggle>
            <Toggle value="tasks">
              <T>Tasks</T>
            </Toggle>
            <Toggle value="watchers">
              <T>Watchers</T>
            </Toggle>
            <Toggle value="mail">
              <T>Mail</T>
            </Toggle>
          </ToggleGroup>
          {view === "tasks" ? (
            <BotTasksView threadRef={props.threadRef} />
          ) : view === "watchers" ? (
            <BotWatchersView threadRef={props.threadRef} />
          ) : view === "mail" ? (
            <BotMailView threadRef={props.threadRef} />
          ) : files.data === null ? (
            <p className="text-muted-foreground text-sm">{files.error ?? <T>Loading…</T>}</p>
          ) : (
            <BotFilesForm
              key={files.dataUpdatedAt}
              threadRef={props.threadRef}
              files={files.data}
              canWrite={canWrite}
            />
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
