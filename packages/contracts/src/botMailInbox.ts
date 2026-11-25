import * as Schema from "effect/Schema";

import { EnvironmentId, IsoDateTime, ScheduledTaskId, ThreadId } from "./baseSchemas.ts";
import { BotMailOrigin } from "./botMail.ts";

/** The Bot's mail store keeps an email this long unless the user sets another. */
export const BOT_MAIL_DEFAULT_RETENTION_DAYS = 90;
export const BOT_MAIL_MAX_RETENTION_DAYS = 3650;
/** One wake at most per window, however much mail arrives in it. */
export const BOT_MAIL_DEFAULT_DIGEST_WINDOW_MINUTES = 5;
export const BOT_MAIL_MAX_DIGEST_WINDOW_MINUTES = 24 * 60;
export const BOT_MAIL_MAX_MAILBOXES = 50;
export const BOT_MAIL_MAX_SEARCH_RESULTS = 50;
export const BOT_MAIL_MAX_DROPPED_MAILBOXES = 10;

const MailboxAddress = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(320));

/**
 * The Mac Mail reader names an account it cannot work out an address for `<8 hex>@` this domain.
 * It is a placeholder, not the user's mailbox: the box keeps nothing for one unless the user
 * allows that exact address.
 */
const BOT_MAIL_UNKNOWN_ACCOUNT_DOMAIN = "mail-app.invalid";
export const isUnknownAccountMailbox = (mailbox: string) =>
  mailbox.toLowerCase().endsWith(`@${BOT_MAIL_UNKNOWN_ACCOUNT_DOMAIN}`);

/** Mail the last pull dropped because it came from an account of this placeholder mailbox. */
const BotMailUnknownAccount = Schema.Struct({ mailbox: MailboxAddress, seen: Schema.Int });

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
  /** Placeholder accounts this pull saw mail from and dropped, so the user can allow one. */
  unknownAccounts: Schema.optional(Schema.Array(BotMailUnknownAccount)),
});
export type BotMailBackfillStatus = typeof BotMailBackfillStatus.Type;

/**
 * The webhook that carries forwarded mail to the Bot. Its URL and secret are never in a status,
 * which any reader can fetch; only creating or rotating shows them.
 */
const BotMailHookState = Schema.Struct({
  taskId: ScheduledTaskId,
  enabled: Schema.Boolean,
  /** Whether deliveries are checked against a signing secret. A hook without one trusts its URL alone. */
  signed: Schema.Boolean,
  lastDeliveryAt: Schema.optional(IsoDateTime),
  /** How the last delivery ended, such as `accepted` or `rejected_signature`. */
  lastOutcome: Schema.optional(Schema.String),
});

/**
 * Mail dropped because its mailbox is not on the allowlist. Only the count and a few recent
 * mailbox names are kept: no subjects, senders or bodies.
 */
export const BotMailDropped = Schema.Struct({
  count: Schema.Int,
  /** Newest first, distinct, at most `BOT_MAIL_MAX_DROPPED_MAILBOXES`. */
  mailboxes: Schema.Array(Schema.Struct({ mailbox: MailboxAddress, count: Schema.Int })),
});

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
  /** How many stored emails are bulk. Absent from a server that does not count them. */
  bulk: Schema.optional(Schema.Int),
  /** Absent when nothing has been dropped since the user last cleared it. */
  dropped: Schema.optional(BotMailDropped),
  lastReceivedAt: Schema.optional(IsoDateTime),
  backfill: Schema.optional(BotMailBackfillStatus),
  /** Accounts the Mac Mail reader could not name, with how much mail of theirs was dropped. */
  unknownAccounts: Schema.optional(
    Schema.Array(Schema.Struct({ ...BotMailUnknownAccount.fields, label: Schema.String })),
  ),
  /** Absent until a hook exists for this Bot. */
  hook: Schema.optional(BotMailHookState),
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

/** For `botMail.createHook` and `botMail.rotateHook`. */
export const BotMailHookInput = Schema.Struct({ threadId: ThreadId });
export type BotMailHookInput = typeof BotMailHookInput.Type;

export const BotMailHookSetup = Schema.Struct({
  taskId: ScheduledTaskId,
  /** Where the Worker posts. Null when this environment has no public address (T3 Connect off). */
  url: Schema.NullOr(Schema.String),
  /** The same route relative to this server, for an address of the user's own. */
  path: Schema.String,
  /** The Worker signs the raw body with HMAC-SHA256 into this header, as `prefix` + lowercase hex. */
  signatureHeader: Schema.String,
  signaturePrefix: Schema.String,
  /**
   * The signing secret, shown once: on creating the hook, or on rotating it. A second create for
   * the same Bot returns the hook without it.
   */
  secret: Schema.optional(Schema.String),
  created: Schema.Boolean,
});
export type BotMailHookSetup = typeof BotMailHookSetup.Type;

/** Forgets the dropped-mail count and names. Adding a mailbox to the list clears just its own. */
export const BotMailClearDroppedInput = Schema.Struct({ threadId: ThreadId });
export type BotMailClearDroppedInput = typeof BotMailClearDroppedInput.Type;

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
