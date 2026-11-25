import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type BotTask,
  type BotTaskStatus,
  type EnvironmentId,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { m } from "~/i18n/messages";
import { botFilesEnvironment } from "~/state/botFiles";
import { useThreadShell } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import {
  botTaskCounts,
  visibleBotTaskRows,
  type BotTaskFilter,
  type BotTaskRow,
} from "./BotTasksView.logic";

const STATUS_BADGE = {
  open: "outline",
  in_progress: "info",
  waiting: "warning",
  done: "success",
} as const satisfies Record<BotTaskStatus, "outline" | "info" | "warning" | "success">;

function StatusBadge(props: { status: BotTaskStatus }) {
  return (
    <Badge variant={STATUS_BADGE[props.status]}>
      {props.status === "open" ? (
        <T>open</T>
      ) : props.status === "in_progress" ? (
        <T>in progress</T>
      ) : props.status === "waiting" ? (
        <T>waiting</T>
      ) : (
        <T>done</T>
      )}
    </Badge>
  );
}

function ThreadChip(props: { environmentId: EnvironmentId; threadId: ThreadId }) {
  const ref = scopeThreadRef(props.environmentId, props.threadId);
  const shell = useThreadShell(ref);
  return (
    <Button
      variant="outline"
      size="micro"
      render={<Link to="/$environmentId/$threadId" params={buildThreadRouteParams(ref)} />}
    >
      <span className="max-w-40 truncate">{shell?.title ?? props.threadId}</span>
    </Button>
  );
}

function TaskRow(props: {
  row: BotTaskRow;
  task: BotTask;
  environmentId: EnvironmentId;
  canWrite: boolean;
  pending: boolean;
  onToggleCollapsed: () => void;
  onSetDone: (done: boolean) => void;
}) {
  const gt = useGT();
  const { task } = props;
  return (
    <li
      className={props.row.context ? "opacity-60" : undefined}
      style={{ paddingInlineStart: `${task.depth * 1.25}rem` }}
    >
      <div className="flex items-start gap-1.5 py-1.5">
        {props.row.hasChildren ? (
          <Button
            variant="ghost-muted"
            size="icon-micro"
            aria-label={props.row.collapsed ? gt("Show subtasks") : gt("Hide subtasks")}
            aria-expanded={!props.row.collapsed}
            onClick={props.onToggleCollapsed}
          >
            <ChevronRightIcon aria-hidden className={props.row.collapsed ? "" : "rotate-90"} />
          </Button>
        ) : (
          <span className="size-5 shrink-0" aria-hidden />
        )}
        <Checkbox
          className="mt-0.5"
          checked={task.status === "done"}
          disabled={!props.canWrite || props.pending}
          aria-label={task.status === "done" ? gt("Reopen task") : gt("Mark task done")}
          onCheckedChange={(checked) => props.onSetDone(checked === true)}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={task.status === "done" ? "text-muted-foreground" : "font-medium"}>
              {task.title}
            </span>
            <StatusBadge status={task.status} />
            {props.row.collapsed ? (
              <span className="text-muted-foreground text-xs">{gt("subtasks hidden")}</span>
            ) : null}
            {task.note === undefined ? null : (
              <span className="text-muted-foreground text-xs">{task.note}</span>
            )}
          </div>
          {task.threadIds.length === 0 ? null : (
            <div className="flex flex-wrap gap-1">
              {task.threadIds.map((threadId) => (
                <ThreadChip
                  key={threadId}
                  environmentId={props.environmentId}
                  threadId={threadId}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

/** What the Bot is tracking, from its tasks.md. The user can tick a task done or reopen it. */
export function BotTasksView(props: { threadRef: ScopedThreadRef }) {
  const gt = useGT();
  const canWrite = useAtomValue(
    botFilesEnvironment.setTaskStatus.permissionAtom(props.threadRef.environmentId),
  );
  const tasks = useEnvironmentQuery(
    botFilesEnvironment.tasks({
      environmentId: props.threadRef.environmentId,
      input: { threadId: props.threadRef.threadId },
    }),
  );
  const setStatus = useAtomCommand(botFilesEnvironment.setTaskStatus, { reportFailure: false });
  const [filter, setFilter] = useState<BotTaskFilter>("all");
  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(new Set());
  const [pendingId, setPendingId] = useState<string | null>(null);

  if (tasks.data === null) {
    return <p className="text-muted-foreground text-sm">{tasks.error ?? <T>Loading…</T>}</p>;
  }
  const { entries } = tasks.data;
  const rows = visibleBotTaskRows(entries, filter, collapsedIds);
  const counts = botTaskCounts(entries);

  const setDone = async (task: BotTask, done: boolean) => {
    setPendingId(task.id);
    const result = await setStatus({
      environmentId: props.threadRef.environmentId,
      input: {
        threadId: props.threadRef.threadId,
        taskId: task.id,
        status: done ? "done" : "open",
      },
    });
    setPendingId(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: gt("Failed to update the task"),
        description:
          thrownErrorMessage(squashAtomCommandFailure(result), m) ?? gt("An error occurred."),
      });
    }
  };
  const toggleCollapsed = (id: string) =>
    setCollapsedIds((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground text-xs">
          {gt("{total, plural, one {{total} task} other {{total} tasks}} · {open} open", counts)}
        </span>
        <Select
          value={filter}
          onValueChange={(value) => {
            if (value !== null) setFilter(value);
          }}
        >
          <SelectTrigger size="xs" variant="ghost" aria-label={gt("Filter tasks by status")}>
            <SelectValue>
              {(value: BotTaskFilter) =>
                value === "all"
                  ? gt("All")
                  : value === "open"
                    ? gt("Open")
                    : value === "in_progress"
                      ? gt("In progress")
                      : value === "waiting"
                        ? gt("Waiting")
                        : gt("Done")
              }
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem hideIndicator value="all">
              <T>All</T>
            </SelectItem>
            <SelectItem hideIndicator value="open">
              <T>Open</T>
            </SelectItem>
            <SelectItem hideIndicator value="in_progress">
              <T>In progress</T>
            </SelectItem>
            <SelectItem hideIndicator value="waiting">
              <T>Waiting</T>
            </SelectItem>
            <SelectItem hideIndicator value="done">
              <T>Done</T>
            </SelectItem>
          </SelectPopup>
        </Select>
      </div>
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {entries.length === 0 ? (
            <T>The Bot has no tasks yet.</T>
          ) : (
            <T>No tasks match this filter.</T>
          )}
        </p>
      ) : (
        <ScrollArea className="max-h-96">
          <ul className="flex flex-col divide-y text-sm">
            {rows.map((row) => {
              const { entry } = row;
              return entry.kind === "task" ? (
                <TaskRow
                  key={row.key}
                  row={row}
                  task={entry}
                  environmentId={props.threadRef.environmentId}
                  canWrite={canWrite}
                  pending={pendingId === entry.id}
                  onToggleCollapsed={() => toggleCollapsed(entry.id)}
                  onSetDone={(done) => void setDone(entry, done)}
                />
              ) : (
                <li key={row.key} className="py-1.5 text-muted-foreground text-xs">
                  {entry.text}
                </li>
              );
            })}
          </ul>
        </ScrollArea>
      )}
    </div>
  );
}
