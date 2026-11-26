import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { EnvironmentId, IsoDateTime, ThreadId } from "./baseSchemas.ts";
import {
  BOT_SECRET_GRANT_MAX_HOSTS,
  BotSecretGrantHost,
  BotSecretGrantName,
} from "./botSecretGrants.ts";

/**
 * A watcher is a script a Bot proposes and a reviewer model approves, version by version. It polls
 * for free and wakes the Bot only when it trips.
 */
export const BOT_WATCHER_SOURCE_MAX_BYTES = 64 * 1024;
export const BOT_WATCHER_MIN_INTERVAL_SECONDS = 60;
export const BOT_WATCHER_EXPECT_MAX_CHARS = 500;
/** Granted secrets one watcher version may declare. */
export const BOT_WATCHER_MAX_SECRETS = 4;

export const BotWatcherName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u),
);
export type BotWatcherName = typeof BotWatcherName.Type;

export const BotWatcherRuntime = Schema.Literals(["node", "sh"]);
export type BotWatcherRuntime = typeof BotWatcherRuntime.Type;

/** `health`: a trip is a failure (the original behavior). `events`: output on exit 0 is news, delivered once. */
export const BotWatcherMode = Schema.Literals(["health", "events"]);
export type BotWatcherMode = typeof BotWatcherMode.Type;

export const BOT_WATCHER_PURPOSE_MAX_CHARS = 300;

/** `local` is the environment that holds the watcher; anything else names a linked environment. */
export const BotWatcherRunsOn = Schema.Union([Schema.Literal("local"), EnvironmentId]);
export type BotWatcherRunsOn = typeof BotWatcherRunsOn.Type;

/**
 * `needs_approval`: no version is approved yet, so nothing runs; the reviewer has not finished with
 * the first one. A revision beside an approved one does not set it. `paused`: the user stopped it,
 * approval kept. `waiting`: its environment did not answer, which counts as no failure.
 */
export const BotWatcherStatus = Schema.Literals([
  "needs_approval",
  "invalid",
  "paused",
  "waiting",
  "healthy",
  "tripped",
]);
export type BotWatcherStatus = typeof BotWatcherStatus.Type;

export const BotWatcherRun = Schema.Struct({
  /** The version that ran. */
  hash: Schema.String,
  /** Where it ran. Absent means `local`. Approval wants a dry run where the watcher will run. */
  runsOn: Schema.optional(BotWatcherRunsOn),
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

/** One verdict of the reviewer model on one version, kept after the version is gone. */
export const BotWatcherReview = Schema.Struct({
  hash: Schema.String,
  at: IsoDateTime,
  verdict: Schema.Literals(["approve", "reject"]),
  /** The reviewer's own words, or why it could not run; at most 300 characters. */
  reason: Schema.String,
  /** The model that judged it, or `server` when the server ruled without asking one. */
  model: Schema.String,
  /**
   * `model`: the reviewer gave this verdict. `error`: the server made it up because the review or
   * the first run could not finish, which says nothing about the script and is never reused.
   * Entries saved before this field existed read as `error`, so none of them is reused.
   */
  source: Schema.Literals(["model", "error"]).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("error" as const)),
  ),
});
export type BotWatcherReview = typeof BotWatcherReview.Type;

export const BotWatcher = Schema.Struct({
  name: BotWatcherName,
  status: BotWatcherStatus,
  /** The version the fields below describe: the pending one while there is one, else the approved one. */
  hash: Schema.String,
  approvedHash: Schema.optional(Schema.String),
  pendingHash: Schema.optional(Schema.String),
  /** `runtime`, `source`, `intervalSeconds`, `expect`, `mode`, `purpose`, `secrets`, `hosts` and `requestedRunsOn` are absent when that version's files are missing or changed on disk (`invalid`). */
  runtime: Schema.optional(BotWatcherRuntime),
  source: Schema.optional(Schema.String),
  intervalSeconds: Schema.optional(Schema.Int),
  expect: Schema.optional(Schema.String),
  /** Absent means `health`. */
  mode: Schema.optional(BotWatcherMode),
  purpose: Schema.optional(Schema.String),
  /** The granted secrets this version declares, sorted; each reaches the script as an environment variable of that name. */
  secrets: Schema.optional(
    Schema.Array(BotSecretGrantName).check(Schema.isMaxLength(BOT_WATCHER_MAX_SECRETS)),
  ),
  /** The hosts those secrets may be sent to, sorted. */
  hosts: Schema.optional(
    Schema.Array(BotSecretGrantHost).check(Schema.isMaxLength(BOT_SECRET_GRANT_MAX_HOSTS)),
  ),
  /** Where the Bot asked it to run. The user's choice is `runsOn`. */
  requestedRunsOn: Schema.optional(BotWatcherRunsOn),
  runsOn: BotWatcherRunsOn,
  /** The user paused it. Shown even while a newer version waits, when `status` says that instead. */
  paused: Schema.Boolean,
  /** Unified diff from the approved version to the pending one, when there are both. */
  diff: Schema.optional(Schema.String),
  lastDryRun: Schema.optional(BotWatcherRun),
  lastRunAt: Schema.optional(Schema.Number),
  /** While `status` is `waiting`: since when, and why the environment was not reached. */
  waiting: Schema.optional(Schema.Struct({ since: Schema.Number, reason: Schema.String })),
  failingSince: Schema.optional(Schema.Number),
  nextWakeAt: Schema.optional(Schema.Number),
  history: Schema.Array(BotWatcherHistoryEntry),
  /** The reviewer's verdicts, oldest first; the last 20. */
  reviews: Schema.Array(BotWatcherReview).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([] as ReadonlyArray<BotWatcherReview>)),
  ),
});
export type BotWatcher = typeof BotWatcher.Type;

export const BotWatcherListInput = Schema.Struct({ threadId: ThreadId });
export type BotWatcherListInput = typeof BotWatcherListInput.Type;

export const BotWatcherListResult = Schema.Struct({
  watchers: Schema.Array(BotWatcher),
  /**
   * `unverified`: the saved approvals failed their signature check when the server started, so
   * every watcher was dropped and nothing runs until the Bot proposes it again.
   */
  approvals: Schema.Literals(["ok", "unverified"]),
});
export type BotWatcherListResult = typeof BotWatcherListResult.Type;

/** Runs a version once, for the user to see. `hash` is the version the user saw, so a newer one is refused. */
export const BotWatcherDryRunInput = Schema.Struct({
  threadId: ThreadId,
  name: BotWatcherName,
  hash: Schema.String,
  /** Where to run it; `local` when absent. A linked environment runs it there, as a scheduled run would. */
  runsOn: Schema.optional(BotWatcherRunsOn),
});
export type BotWatcherDryRunInput = typeof BotWatcherDryRunInput.Type;

/** Pauses, resumes or removes a watcher; the user's, so none of them depends on the Bot's state. */
export const BotWatcherTargetInput = Schema.Struct({ threadId: ThreadId, name: BotWatcherName });
export type BotWatcherTargetInput = typeof BotWatcherTargetInput.Type;

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
    "dry_run_required",
    "unreachable",
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
        return "This turn was started by an incoming message or event, not by the user typing, so it cannot create or remove watchers. Tell the user what you would watch and let them ask you in a turn they start. A wake turn may still propose a revision of a watcher the user has already approved.";
      case "invalid":
        return this.detail ?? "That watcher is not valid.";
      case "not_found":
        return `There is no watcher named ${this.watcher ?? ""}.`;
      case "no_pending":
        return `Watcher ${this.watcher ?? ""} has no version under review.`;
      case "stale_hash":
        return `Watcher ${this.watcher ?? ""} changed since that version was shown. Review the new version first.`;
      case "dry_run_required":
        return `Run watcher ${this.watcher ?? ""} once, where it will run, first: the server makes a version live, or moves a watcher, only after a dry run has completed there.`;
      case "unreachable":
        return this.detail ?? "The environment did not answer.";
      case "io":
        return `Failed to read or save the watchers for thread ${this.threadId}.`;
    }
  }
}

/** What a linked environment reports back for one run of a watcher's script. */
export const BotWatcherRemoteRun = Schema.Struct({
  /** The exit code, or `timeout` or `spawn-error`: the same words a local run records. */
  exit: Schema.String,
  stdout: Schema.String,
  stderr: Schema.String,
});
export type BotWatcherRemoteRun = typeof BotWatcherRemoteRun.Type;

/** Why this environment would not run a script for a linked environment. */
export class BotWatcherPeerRunError extends Schema.TaggedError<BotWatcherPeerRunError>()(
  "BotWatcherPeerRunError",
  {
    reason: Schema.Literals(["hash_mismatch", "invalid"]),
    detail: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return this.reason === "hash_mismatch"
      ? "The script does not match the hash it was sent with, so it was not run."
      : (this.detail ?? "That script is not valid.");
  }
}
