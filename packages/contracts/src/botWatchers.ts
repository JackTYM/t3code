import * as Schema from "effect/Schema";

import { EnvironmentId, IsoDateTime, ThreadId } from "./baseSchemas.ts";

/**
 * A watcher is a script a Bot proposes and the user approves, version by version. It polls for
 * free and wakes the Bot only when it trips.
 */
export const BOT_WATCHER_SOURCE_MAX_BYTES = 64 * 1024;
export const BOT_WATCHER_MIN_INTERVAL_SECONDS = 60;
export const BOT_WATCHER_EXPECT_MAX_CHARS = 500;

export const BotWatcherName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u),
);
export type BotWatcherName = typeof BotWatcherName.Type;

export const BotWatcherRuntime = Schema.Literals(["node", "sh"]);
export type BotWatcherRuntime = typeof BotWatcherRuntime.Type;

/** `local` is the environment that holds the watcher; anything else names a linked environment. */
export const BotWatcherRunsOn = Schema.Union([Schema.Literal("local"), EnvironmentId]);
export type BotWatcherRunsOn = typeof BotWatcherRunsOn.Type;

/**
 * `needs_approval`: the newest version is not approved, so nothing of the watcher runs.
 * `elsewhere`: approved to run on another environment, which this server does not do yet.
 */
export const BotWatcherStatus = Schema.Literals([
  "needs_approval",
  "invalid",
  "elsewhere",
  "healthy",
  "tripped",
]);
export type BotWatcherStatus = typeof BotWatcherStatus.Type;

export const BotWatcherRun = Schema.Struct({
  /** The version that ran. */
  hash: Schema.String,
  ranAt: IsoDateTime,
  exit: Schema.String,
  stdout: Schema.String,
  stderr: Schema.String,
  healthy: Schema.Boolean,
});
export type BotWatcherRun = typeof BotWatcherRun.Type;

export const BotWatcherHistoryEntry = Schema.Struct({
  hash: Schema.String,
  proposedAt: IsoDateTime,
  approvedAt: Schema.optional(IsoDateTime),
  approvedBy: Schema.optional(Schema.String),
});
export type BotWatcherHistoryEntry = typeof BotWatcherHistoryEntry.Type;

export const BotWatcher = Schema.Struct({
  name: BotWatcherName,
  status: BotWatcherStatus,
  /** The version the fields below describe: the pending one while there is one, else the approved one. */
  hash: Schema.String,
  approvedHash: Schema.optional(Schema.String),
  pendingHash: Schema.optional(Schema.String),
  /** `runtime`, `source`, `intervalSeconds`, `expect` and `requestedRunsOn` are absent when that version's files are missing or changed on disk (`invalid`). */
  runtime: Schema.optional(BotWatcherRuntime),
  source: Schema.optional(Schema.String),
  intervalSeconds: Schema.optional(Schema.Int),
  expect: Schema.optional(Schema.String),
  /** Where the Bot asked it to run. The user's choice is `runsOn`. */
  requestedRunsOn: Schema.optional(BotWatcherRunsOn),
  runsOn: BotWatcherRunsOn,
  /** Unified diff from the approved version to the pending one, when there are both. */
  diff: Schema.optional(Schema.String),
  lastDryRun: Schema.optional(BotWatcherRun),
  lastRunAt: Schema.optional(Schema.Number),
  failingSince: Schema.optional(Schema.Number),
  nextWakeAt: Schema.optional(Schema.Number),
  history: Schema.Array(BotWatcherHistoryEntry),
});
export type BotWatcher = typeof BotWatcher.Type;

export const BotWatcherListInput = Schema.Struct({ threadId: ThreadId });
export type BotWatcherListInput = typeof BotWatcherListInput.Type;

export const BotWatcherListResult = Schema.Struct({ watchers: Schema.Array(BotWatcher) });
export type BotWatcherListResult = typeof BotWatcherListResult.Type;

/** Runs the pending version once. `hash` is the version the user saw, so a newer one is refused. */
export const BotWatcherDryRunInput = Schema.Struct({
  threadId: ThreadId,
  name: BotWatcherName,
  hash: Schema.String,
});
export type BotWatcherDryRunInput = typeof BotWatcherDryRunInput.Type;

/** Approves exactly `hash`, which must still be the pending version. */
export const BotWatcherApproveInput = Schema.Struct({
  threadId: ThreadId,
  name: BotWatcherName,
  hash: Schema.String,
  runsOn: BotWatcherRunsOn,
});
export type BotWatcherApproveInput = typeof BotWatcherApproveInput.Type;

/** Discards the pending version and resumes the approved one, if there is one. */
export const BotWatcherRejectInput = Schema.Struct({ threadId: ThreadId, name: BotWatcherName });
export type BotWatcherRejectInput = typeof BotWatcherRejectInput.Type;

export const BotWatcherSetRunsOnInput = Schema.Struct({
  threadId: ThreadId,
  name: BotWatcherName,
  runsOn: BotWatcherRunsOn,
});
export type BotWatcherSetRunsOnInput = typeof BotWatcherSetRunsOnInput.Type;

export class BotWatcherError extends Schema.TaggedError<BotWatcherError>()("BotWatcherError", {
  threadId: ThreadId,
  /** The watcher it concerns. */
  watcher: Schema.optional(Schema.String),
  reason: Schema.Literals([
    "not_a_bot",
    "started_by_wake",
    "invalid",
    "not_found",
    "no_pending",
    "stale_hash",
    "io",
  ]),
  /** Why a proposal is invalid; safe to show. */
  detail: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "not_a_bot":
        return `Thread ${this.threadId} is not a Bot.`;
      case "started_by_wake":
        return "This turn was started by an incoming message or event, not by the user typing, so it cannot create, change or remove watchers. Tell the user what you would watch and let them ask you in a turn they start.";
      case "invalid":
        return this.detail ?? "That watcher is not valid.";
      case "not_found":
        return `There is no watcher named ${this.watcher ?? ""}.`;
      case "no_pending":
        return `Watcher ${this.watcher ?? ""} has no version waiting for approval.`;
      case "stale_hash":
        return `Watcher ${this.watcher ?? ""} changed since that version was shown. Review the new version first.`;
      case "io":
        return `Failed to read or save the watchers for thread ${this.threadId}.`;
    }
  }
}
