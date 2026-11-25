import {
  BOT_FILE_MAX_CHARS,
  BOT_WATCHER_EXPECT_MAX_CHARS,
  BOT_WATCHER_MIN_INTERVAL_SECONDS,
  BOT_WATCHER_SOURCE_MAX_BYTES,
  BotWatch,
  BotWatcherName,
  BotWatcherRunsOn,
  BotWatcherRuntime,
  BotWatcherStatus,
  OrchestratorMcpFailure,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as BotService from "../../../bots/BotService.ts";
import * as WatcherService from "../../../bots/WatcherService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

/** Listed only to Bot threads (Home among them); tool search never offers them to others. */
export const BOT_TOOL_PREFIX = "t3_bot_";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    BotService.BotService,
    WatcherService.WatcherService,
  ],
};
const Saved = Schema.Struct({ saved: Schema.Boolean });
const Watches = Schema.Struct({ watches: Schema.Array(BotWatch) });
const WatchTargetInput = Schema.Struct({
  threadId: Schema.optional(ThreadId),
  workflowRunId: Schema.optional(
    TrimmedNonEmptyString.annotate({ description: "Instead of `threadId`." }),
  ),
});

const MemoryRead = Tool.make("t3_bot_memory_read", {
  ...shared,
  description:
    "Read your memory: notes.md (your working notes), preferences.md (what the user wants you to keep doing), tasks.md (your task list), and the threads and workflow runs you watch beyond your crew.",
  // No `parameters`: an explicit Schema.Struct({}) advertises `anyOf: [object, array]`,
  // which MCP clients reject. The default EmptyParams advertises `type: "object"`.
  success: Schema.Struct({
    notes: Schema.String,
    preferences: Schema.String,
    tasks: Schema.String,
    watches: Schema.Array(BotWatch),
  }),
})
  .annotate(Tool.Title, "Read Bot memory")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromNonBots);

const NotesWrite = Tool.make("t3_bot_notes_write", {
  ...shared,
  description:
    "Replace your notes.md: ongoing efforts, which crew thread owns what, decisions. Keep it short and current; the user can read it.",
  parameters: Schema.Struct({
    contents: Schema.String.check(Schema.isMaxLength(BOT_FILE_MAX_CHARS)).annotate({
      description: "The whole new Markdown file.",
    }),
  }),
  success: Saved,
})
  .annotate(Tool.Title, "Write Bot notes")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromNonBots);

const TasksWrite = Tool.make("t3_bot_tasks_write", {
  ...shared,
  description:
    "Replace your tasks.md, the task list the user sees, in the line format your Bot instructions give. Read it first with t3_bot_memory_read: the user may have marked tasks done.",
  parameters: Schema.Struct({
    contents: Schema.String.check(Schema.isMaxLength(BOT_FILE_MAX_CHARS)).annotate({
      description: "The whole new Markdown file.",
    }),
  }),
  success: Saved,
})
  .annotate(Tool.Title, "Write Bot tasks")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromNonBots);

const PreferencesAppend = Tool.make("t3_bot_preferences_append", {
  ...shared,
  description: "Add one lasting user preference to your preferences.md.",
  parameters: Schema.Struct({
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_000)).annotate({
      description: "One line, in the user's terms.",
    }),
  }),
  success: Saved,
})
  .annotate(Tool.Title, "Add a Bot preference")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromNonBots);

const WatchAdd = Tool.make("t3_bot_watch_add", {
  ...shared,
  description:
    "Wake you when a thread outside your crew, or a workflow run, here finishes or needs input. Ends when it settles. Your crew is always watched.",
  parameters: WatchTargetInput,
  success: Watches,
})
  .annotate(Tool.Title, "Watch a thread or workflow run")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromNonBots);

const WatchRemove = Tool.make("t3_bot_watch_remove", {
  ...shared,
  description: "Stop watching a thread or workflow run.",
  parameters: WatchTargetInput,
  success: Watches,
})
  .annotate(Tool.Title, "Stop watching")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromNonBots);

// There is deliberately no tool to approve a watcher or to run one once: both are the user's, so
// a Bot that read a hostile message cannot put code to work by calling them.
const WatcherPropose = Tool.make("t3_bot_watcher_propose", {
  ...shared,
  description:
    "Propose a watcher: a script that polls for free and wakes you only when it trips. It does NOT run until the user has read its source, run it once, and approved that exact version; proposing a changed version stops the approved one until the user approves again. You cannot approve or dry-run it yourself. Runs on an interval, with no stdin, a minimal environment, and a short timeout. Healthy is exit 0 and, when `expect` is set, stdout matching it; anything else trips and wakes you with the output. Refused in a turn that began with a wake or any message the user did not type.",
  parameters: Schema.Struct({
    name: BotWatcherName.annotate({
      description:
        "Letters, digits, - and _. Proposing an existing name replaces its pending version.",
    }),
    runtime: BotWatcherRuntime.annotate({
      description: "`node` runs the source with Node.js, `sh` with sh.",
    }),
    source: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(BOT_WATCHER_SOURCE_MAX_BYTES),
    ).annotate({ description: "The whole script, up to 64 KB. It only looks: no side effects." }),
    intervalSeconds: Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(BOT_WATCHER_MIN_INTERVAL_SECONDS),
    ).annotate({ description: "Seconds between runs, at least 60." }),
    expect: Schema.optional(
      Schema.String.check(Schema.isMaxLength(BOT_WATCHER_EXPECT_MAX_CHARS)).annotate({
        description:
          "A regular expression a healthy run's stdout must match. Say what a healthy output looks like; leave it out when exit 0 alone means healthy.",
      }),
    ),
    runsOn: Schema.optional(
      BotWatcherRunsOn.annotate({
        description:
          "`local` (default) or a linked environment's id. A request: the user chooses where it runs when approving.",
      }),
    ),
  }),
  success: Schema.Struct({
    hash: Schema.String,
    pending: Schema.Boolean.annotate({
      description: "True while it waits for the user. False when it is the approved version again.",
    }),
  }),
})
  .annotate(Tool.Title, "Propose a watcher")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromNonBots);

const WatcherRemove = Tool.make("t3_bot_watcher_remove", {
  ...shared,
  description:
    "Delete one of your watchers, whatever version it is on. Refused in a turn that began with a wake or any message the user did not type.",
  parameters: Schema.Struct({ name: BotWatcherName }),
  success: Schema.Struct({ removed: Schema.Boolean }),
})
  .annotate(Tool.Title, "Remove a watcher")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromNonBots);

const WatcherList = Tool.make("t3_bot_watcher_list", {
  ...shared,
  description:
    "List your watchers and where each stands, with the source of the version shown so you can re-read what you wrote. `needs_approval` means the newest version waits for the user and nothing of the watcher runs.",
  success: Schema.Struct({
    watchers: Schema.Array(
      Schema.Struct({
        name: BotWatcherName,
        status: BotWatcherStatus,
        hash: Schema.String,
        runtime: Schema.optional(BotWatcherRuntime),
        /** The pending version while there is one, else the approved one. */
        source: Schema.optional(Schema.String),
        intervalSeconds: Schema.optional(Schema.Int),
        expect: Schema.optional(Schema.String),
        runsOn: BotWatcherRunsOn,
      }),
    ),
  }),
})
  .annotate(Tool.Title, "List watchers")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromNonBots);

export const BotToolkit = Toolkit.make(
  MemoryRead,
  NotesWrite,
  TasksWrite,
  PreferencesAppend,
  WatchAdd,
  WatchRemove,
  WatcherPropose,
  WatcherRemove,
  WatcherList,
);
