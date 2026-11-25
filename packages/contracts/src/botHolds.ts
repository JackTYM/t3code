import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId } from "./baseSchemas.ts";

/**
 * A consequential call a Bot made in a turn that email influenced, held for the user. The Bot's
 * turn went on without it; allowing wakes the Bot to make the call again.
 */
export const BotHeldAction = Schema.Struct({
  id: Schema.String,
  tool: Schema.String,
  /** One line from the tool and what it names, never the Bot's own words. */
  summary: Schema.String,
  /** The call's arguments as JSON, cut short. These are what the Bot, and so a stranger, asked for. */
  input: Schema.String,
  heldAt: IsoDateTime,
});
export type BotHeldAction = typeof BotHeldAction.Type;

export const BotHoldListInput = Schema.Struct({ threadId: ThreadId });
export type BotHoldListInput = typeof BotHoldListInput.Type;

export const BotHoldListResult = Schema.Struct({ held: Schema.Array(BotHeldAction) });
export type BotHoldListResult = typeof BotHoldListResult.Type;

export const BotHoldDecisionInput = Schema.Struct({ threadId: ThreadId, id: Schema.String });
export type BotHoldDecisionInput = typeof BotHoldDecisionInput.Type;

export class BotHoldError extends Schema.TaggedError<BotHoldError>()("BotHoldError", {
  threadId: ThreadId,
  reason: Schema.Literals(["not_a_bot", "not_found"]),
}) {
  override get message(): string {
    return this.reason === "not_a_bot"
      ? `Thread ${this.threadId} is not a Bot.`
      : "That action is no longer held: it was decided, or the server restarted.";
  }
}
