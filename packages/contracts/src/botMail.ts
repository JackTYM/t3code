import * as Schema from "effect/Schema";

import { IsoDateTime } from "./baseSchemas.ts";

/**
 * One email as the Bot's mail store keeps it. Every field is untrusted text from the sender,
 * apart from `auth`, which records what the receiving mail server said, not what the sender
 * claims. Forwarded mail and the Mac Mail backfill both produce this shape.
 */
const BOT_MAIL_BODY_MAX_CHARS = 200_000;
const BOT_MAIL_SUBJECT_MAX_CHARS = 1_000;
const BOT_MAIL_ADDRESS_MAX_CHARS = 320;

/**
 * The receiving server's verdict for one mechanism. `none` means no verdict was found, which
 * is not the same as `fail`.
 */
export const BotMailAuthVerdict = Schema.Literals(["pass", "fail", "none"]);
export type BotMailAuthVerdict = typeof BotMailAuthVerdict.Type;

export const BotMailAuth = Schema.Struct({
  dkim: BotMailAuthVerdict,
  spf: BotMailAuthVerdict,
  /** DMARC passes when DKIM or SPF passes and matches the From domain. */
  dmarc: BotMailAuthVerdict,
  /** Who produced the verdicts. They are only as good as that server's `Authentication-Results`. */
  source: Schema.Literals(["cloudflare", "mail-app"]),
});
export type BotMailAuth = typeof BotMailAuth.Type;

/** `forward` arrived through the routing address; `backfill` was read from the Mac Mail app. */
export const BotMailOrigin = Schema.Literals(["forward", "backfill"]);
export type BotMailOrigin = typeof BotMailOrigin.Type;

export const BotMailMessage = Schema.Struct({
  /** The `Message-ID` header without angle brackets. The store dedupes on it per mailbox. */
  messageId: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(998)),
  /**
   * The user's own address this email was sent to, lower-cased. It names the mailbox, such as a
   * Gmail or iCloud account, and is how mail from several accounts stays apart.
   */
  mailbox: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(BOT_MAIL_ADDRESS_MAX_CHARS)),
  from: Schema.String.check(Schema.isMaxLength(BOT_MAIL_ADDRESS_MAX_CHARS)),
  to: Schema.Array(Schema.String.check(Schema.isMaxLength(BOT_MAIL_ADDRESS_MAX_CHARS))),
  subject: Schema.String.check(Schema.isMaxLength(BOT_MAIL_SUBJECT_MAX_CHARS)),
  /** When the sender's server dated it. Not trusted for ordering beyond display. */
  sentAt: IsoDateTime,
  /** Plain text. A sender that only sent HTML is converted to text before it gets here. */
  bodyText: Schema.String.check(Schema.isMaxLength(BOT_MAIL_BODY_MAX_CHARS)),
  /** Names only. Attachment bytes are not stored. */
  attachmentNames: Schema.Array(Schema.String.check(Schema.isMaxLength(255))),
  auth: BotMailAuth,
  origin: BotMailOrigin,
  /**
   * Marketing or automated mail, judged from the sender's own headers (`List-Unsubscribe`,
   * `List-Id`, `Precedence`, `Auto-Submitted`) and obvious no-reply sender names. It is stored and
   * searchable but never wakes the Bot. Absent on mail stored before this existed: not bulk.
   */
  bulk: Schema.optional(Schema.Boolean),
});
export type BotMailMessage = typeof BotMailMessage.Type;

export const BotMailBackfillInput = Schema.Struct({
  sinceDays: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 90 })),
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
});

export const BotMailBackfillPage = Schema.Struct({
  messages: Schema.Array(BotMailMessage),
  nextCursor: Schema.optional(Schema.String),
  accounts: Schema.Array(Schema.String),
});
