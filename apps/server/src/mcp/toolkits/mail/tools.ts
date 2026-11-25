import {
  BotMailBackfillInput,
  BotMailBackfillPage,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as MailAppReader from "../../../mail/MailAppReader.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

// Listed only to a linked environment's session, and checked on every call: this reads the mail
// of the person at this Mac for the Bot on the environment that holds its mail store.
const MailBackfill = Tool.make("t3_mail_backfill", {
  description:
    "Read a page of inbound mail from the Mac Mail app on this machine for the linked environment that keeps the Bot's mail store. Newest first, from the last `sinceDays` days (1 to 90); pass the returned `nextCursor` back for the next page. Returns plain-text bodies, attachment names and the receiving server's authentication verdicts, and the account addresses Mail has.",
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [McpInvocationContext.McpInvocationContext, MailAppReader.MailAppReader],
  parameters: BotMailBackfillInput,
  success: BotMailBackfillPage,
})
  .annotate(Tool.Title, "Read Mail app mail for a linked environment")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromUnlinked);

export const MailPeerToolkit = Toolkit.make(MailBackfill);
