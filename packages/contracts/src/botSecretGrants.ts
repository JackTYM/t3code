import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId } from "./baseSchemas.ts";
import { SecretReference } from "./secretReference.ts";

/**
 * A secret grant is the user's decision to let one Bot's scripts use one secret, for requests to
 * the listed hosts only. The Bot sees that a grant exists, never its value.
 */
export const BotSecretGrantName = Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9_]{0,63}$/u));
export type BotSecretGrantName = typeof BotSecretGrantName.Type;

export const BotSecretGrantHost = Schema.String.check(
  Schema.isPattern(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/u),
  Schema.isMaxLength(253),
);
export type BotSecretGrantHost = typeof BotSecretGrantHost.Type;

export const BOT_SECRET_GRANT_MAX_HOSTS = 8;
export const BOT_SECRET_GRANTS_MAX_PER_BOT = 24;
/** Shorter than this, hiding a value in text would rewrite words that are not it. Counted after trimming. */
export const BOT_SECRET_GRANT_MIN_VALUE_LENGTH = 8;

/** What the list shows. It never carries a value, and a reference's text is not shown to a Bot. */
export const BotSecretGrant = Schema.Struct({
  name: BotSecretGrantName,
  hosts: Schema.Array(BotSecretGrantHost).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(BOT_SECRET_GRANT_MAX_HOSTS),
  ),
  source: Schema.Literals(["stored", "reference"]),
  /** The last time the value was read for a run, or absent. */
  lastUsedAt: Schema.optional(IsoDateTime),
});
export type BotSecretGrant = typeof BotSecretGrant.Type;

export const BotSecretGrantListInput = Schema.Struct({ threadId: ThreadId });
export type BotSecretGrantListInput = typeof BotSecretGrantListInput.Type;

export const BotSecretGrantListResult = Schema.Struct({
  grants: Schema.Array(BotSecretGrant),
  /**
   * `unverified`: the saved grants failed their signature check when the server started, so every
   * grant was dropped until the user gives it again. The stored values were not touched.
   * `unreadable`: the saved grants or their secrets could not be read, so none is in effect and
   * none can be changed until they can; the next call tries again.
   */
  approvals: Schema.Literals(["ok", "unverified", "unreadable"]),
});
export type BotSecretGrantListResult = typeof BotSecretGrantListResult.Type;

export const BotSecretGrantSetInput = Schema.Struct({
  threadId: ThreadId,
  name: BotSecretGrantName,
  hosts: BotSecretGrant.fields.hosts,
  value: Schema.Union([
    Schema.Struct({
      type: Schema.Literal("stored"),
      secret: Schema.RedactedFromValue(Schema.String),
    }),
    Schema.Struct({ type: Schema.Literal("reference"), reference: SecretReference }),
  ]),
});
export type BotSecretGrantSetInput = typeof BotSecretGrantSetInput.Type;

export const BotSecretGrantRemoveInput = Schema.Struct({
  threadId: ThreadId,
  name: BotSecretGrantName,
});
export type BotSecretGrantRemoveInput = typeof BotSecretGrantRemoveInput.Type;

export class BotSecretGrantError extends Schema.TaggedError<BotSecretGrantError>()(
  "BotSecretGrantError",
  {
    threadId: ThreadId,
    /** The grant it concerns. */
    grant: Schema.optional(Schema.String),
    reason: Schema.Literals([
      "not_a_bot",
      "invalid",
      "too_short",
      "limit",
      "not_found",
      "unreadable",
      "io",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not_a_bot":
        return `Thread ${this.threadId} is not a Bot.`;
      case "invalid":
        return "A secret grant needs a value that is not empty.";
      case "too_short":
        return `A secret grant needs a value of at least ${BOT_SECRET_GRANT_MIN_VALUE_LENGTH} characters.`;
      case "limit":
        return `A Bot can hold at most ${BOT_SECRET_GRANTS_MAX_PER_BOT} secret grants. Remove one first.`;
      case "not_found":
        return `There is no secret grant named ${this.grant ?? ""}.`;
      case "unreadable":
        return "The saved secret grants could not be read, so they cannot be changed now. Try again in a moment.";
      case "io":
        return `Failed to read or save the secret grants for thread ${this.threadId}.`;
    }
  }
}
