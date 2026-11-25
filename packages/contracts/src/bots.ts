import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/**
 * A Bot is a coordinator thread: it keeps notes, leads the crew grouped under it, and is woken
 * when its crew or what it watches reaches a milestone. Home is the Bot for a whole environment.
 * Set when the thread is created; a thread never changes role mid-conversation.
 */
export const ThreadBotConfig = Schema.Struct({
  enabled: Schema.Literal(true),
  /** Crew threads surface only when they need input; their other updates stay quiet. */
  muteChildren: Schema.Boolean,
});
export type ThreadBotConfig = typeof ThreadBotConfig.Type;

export const BotFileKind = Schema.Literals(["notes", "preferences", "tasks"]);
export type BotFileKind = typeof BotFileKind.Type;

export const BOT_FILE_MAX_CHARS = 64_000;

export const BotFilesReadInput = Schema.Struct({ threadId: ThreadId });
export type BotFilesReadInput = typeof BotFilesReadInput.Type;

export const BotFilesReadResult = Schema.Struct({
  notes: Schema.String,
  preferences: Schema.String,
});
export type BotFilesReadResult = typeof BotFilesReadResult.Type;

/**
 * `waiting` is blocked on the user or on something outside the Bot's control; the task's note says
 * which.
 */
export const BotTaskStatus = Schema.Literals(["open", "in_progress", "waiting", "done"]);
export type BotTaskStatus = typeof BotTaskStatus.Type;

export const BotTask = Schema.Struct({
  kind: Schema.Literal("task"),
  id: TrimmedNonEmptyString,
  title: Schema.String,
  status: BotTaskStatus,
  /** Free text: a due date, or what a waiting task waits on. */
  note: Schema.optionalKey(Schema.String),
  /** Threads working on the task, in this environment. */
  threadIds: Schema.Array(ThreadId),
  /** Nesting level, 0 for a top-level task. */
  depth: NonNegativeInt,
});
export type BotTask = typeof BotTask.Type;

/** A line of tasks.md that is not a task, kept so the file is shown as written. */
export const BotTaskRawLine = Schema.Struct({ kind: Schema.Literal("raw"), text: Schema.String });
export type BotTaskRawLine = typeof BotTaskRawLine.Type;

export const BotTasksReadInput = Schema.Struct({ threadId: ThreadId });
export type BotTasksReadInput = typeof BotTasksReadInput.Type;

/** tasks.md in file order; a task's subtasks are the entries after it with a greater `depth`. */
export const BotTasksReadResult = Schema.Struct({
  entries: Schema.Array(Schema.Union([BotTask, BotTaskRawLine])),
});
export type BotTasksReadResult = typeof BotTasksReadResult.Type;

export const BotTaskSetStatusInput = Schema.Struct({
  threadId: ThreadId,
  taskId: TrimmedNonEmptyString,
  status: BotTaskStatus,
});
export type BotTaskSetStatusInput = typeof BotTaskSetStatusInput.Type;

export const BotFileWriteInput = Schema.Struct({
  threadId: ThreadId,
  file: BotFileKind,
  contents: Schema.String.check(Schema.isMaxLength(BOT_FILE_MAX_CHARS)),
});
export type BotFileWriteInput = typeof BotFileWriteInput.Type;

/** Starts a new Bot seeded with a handoff of `threadId`, which becomes its first crew member. */
export const BotStartInput = Schema.Struct({ threadId: ThreadId });
export type BotStartInput = typeof BotStartInput.Type;

export const BotStartResult = Schema.Struct({ threadId: ThreadId });
export type BotStartResult = typeof BotStartResult.Type;

/** `launched`: a workflow run the Bot started. `manual`: asked for. */
export const BotWatchReason = Schema.Literals(["launched", "manual"]);
export type BotWatchReason = typeof BotWatchReason.Type;

const BotWatchFields = {
  /** Absent means this environment. */
  environmentId: Schema.optionalKey(EnvironmentId),
  reason: BotWatchReason,
  addedAt: IsoDateTime,
};

export const BotThreadWatch = Schema.Struct({ threadId: ThreadId, ...BotWatchFields });
export const BotWorkflowRunWatch = Schema.Struct({
  workflowRunId: TrimmedNonEmptyString,
  ...BotWatchFields,
});

/**
 * A thread or workflow run outside a Bot's crew whose milestones wake it until it settles.
 * Crew threads need no watch: they always wake their Bot.
 */
export const BotWatch = Schema.Union([BotThreadWatch, BotWorkflowRunWatch]);
export type BotWatch = typeof BotWatch.Type;

export const BotWatchTarget = Schema.Union([
  Schema.Struct({ threadId: ThreadId }),
  Schema.Struct({ workflowRunId: TrimmedNonEmptyString }),
]);
export type BotWatchTarget = typeof BotWatchTarget.Type;

export const botWatchKey = (target: BotWatchTarget): string =>
  "threadId" in target ? `thread:${target.threadId}` : `workflow:${target.workflowRunId}`;

export class BotError extends Schema.TaggedError<BotError>()("BotError", {
  threadId: ThreadId,
  reason: Schema.Literals([
    "not_a_bot",
    "too_large",
    "io",
    "cannot_start",
    "launch_failed",
    "task_not_found",
  ]),
  /** Why a Bot cannot start from the thread; safe to show. */
  detail: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "not_a_bot":
        return `Thread ${this.threadId} is not a Bot.`;
      case "too_large":
        return `A Bot file holds at most ${BOT_FILE_MAX_CHARS} characters.`;
      case "io":
        return `Failed to read or save the Bot files for thread ${this.threadId}.`;
      case "cannot_start":
        return this.detail ?? `A Bot cannot start from thread ${this.threadId}.`;
      case "launch_failed":
        return `The Bot for thread ${this.threadId} could not be started.`;
      case "task_not_found":
        return `The Bot for thread ${this.threadId} no longer lists that task.`;
    }
  }
}
