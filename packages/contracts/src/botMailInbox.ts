import * as Schema from "effect/Schema";

import { EnvironmentId, IsoDateTime, ThreadId } from "./baseSchemas.ts";
import { BotMailOrigin } from "./botMail.ts";

/** The Bot's mail store keeps an email this long unless the user sets another. */
export const BOT_MAIL_DEFAULT_RETENTION_DAYS = 90;
const BOT_MAIL_MAX_RETENTION_DAYS = 3650;
/** One wake at most per window, however much mail arrives in it. */
export const BOT_MAIL_DEFAULT_DIGEST_WINDOW_MINUTES = 5;
const BOT_MAIL_MAX_DIGEST_WINDOW_MINUTES = 24 * 60;
const BOT_MAIL_MAX_MAILBOXES = 50;
export const BOT_MAIL_MAX_SEARCH_RESULTS = 50;

const MailboxAddress = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(320));

export const BotMailBackfillStatus = Schema.Struct({
  /**
   * `waiting`: the laptop did not answer, so the pull stops where it is and a later pull picks up.
   * That is not a failure.
   */
  state: Schema.Literals(["running", "waiting", "failed", "done"]),
  environmentId: EnvironmentId,
  sinceDays: Schema.Int,
  /** Emails kept by this pull so far; ones already stored are not counted again. */
  stored: Schema.Int,
  startedAt: IsoDateTime,
  updatedAt: IsoDateTime,
  /** Why it is waiting or failed; safe to show. */
  reason: Schema.optional(Schema.String),
});
export type BotMailBackfillStatus = typeof BotMailBackfillStatus.Type;

export const BotMailStatusInput = Schema.Struct({ threadId: ThreadId });
export type BotMailStatusInput = typeof BotMailStatusInput.Type;

export const BotMailStatus = Schema.Struct({
  /** The user's own addresses mail may be kept for. Empty keeps nothing. */
  mailboxes: Schema.Array(MailboxAddress),
  retentionDays: Schema.Int,
  digestWindowMinutes: Schema.Int,
  counts: Schema.Array(
    Schema.Struct({ mailbox: MailboxAddress, origin: BotMailOrigin, count: Schema.Int }),
  ),
  /** Emails forgotten: only that they were is kept. */
  forgotten: Schema.Int,
  lastReceivedAt: Schema.optional(IsoDateTime),
  backfill: Schema.optional(BotMailBackfillStatus),
});
export type BotMailStatus = typeof BotMailStatus.Type;

/** Omitted `retentionDays` and `digestWindowMinutes` keep what the Bot has. */
export const BotMailSetMailboxesInput = Schema.Struct({
  threadId: ThreadId,
  mailboxes: Schema.Array(MailboxAddress).check(Schema.isMaxLength(BOT_MAIL_MAX_MAILBOXES)),
  retentionDays: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: BOT_MAIL_MAX_RETENTION_DAYS })),
  ),
  digestWindowMinutes: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: BOT_MAIL_MAX_DIGEST_WINDOW_MINUTES })),
  ),
});
export type BotMailSetMailboxesInput = typeof BotMailSetMailboxesInput.Type;

export const BotMailForgetInput = Schema.Struct({
  threadId: ThreadId,
  /** The store's own number for the email, not its Message-ID. */
  id: Schema.Int,
});
export type BotMailForgetInput = typeof BotMailForgetInput.Type;

/** Pulls mail the Mac Mail app on a linked environment already holds, into the Bot's store. */
export const BotMailBackfillRequest = Schema.Struct({
  threadId: ThreadId,
  environmentId: EnvironmentId,
  sinceDays: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 90 })),
});
export type BotMailBackfillRequest = typeof BotMailBackfillRequest.Type;

export class BotMailError extends Schema.TaggedError<BotMailError>()("BotMailError", {
  threadId: ThreadId,
  reason: Schema.Literals(["not_a_bot", "not_found", "invalid", "io"]),
  /** Why a request is invalid; safe to show. */
  detail: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "not_a_bot":
        return `Thread ${this.threadId} is not a Bot.`;
      case "not_found":
        return "There is no such email in this Bot's mail store.";
      case "invalid":
        return this.detail ?? "That request is not valid.";
      case "io":
        return `Failed to read or save the mail for thread ${this.threadId}.`;
    }
  }
}
