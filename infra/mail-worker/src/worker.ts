import { toBotMail } from "./botMail.ts";
import { deliverToBox } from "./deliver.ts";
import { isGmailForwardingConfirmation, readGmailConfirmation } from "./gmailConfirmation.ts";

interface Env {
  /** Where the box ingests mail, e.g. `https://box.example.com/mail/ingest`. */
  BOX_URL: string;
  /** Shared with the box; signs each request body. */
  WEBHOOK_SECRET: string;
  /** Comma-separated addresses the user receives mail at. */
  MAILBOXES?: string;
}

// Logs carry the Message-ID and the outcome, never addresses, subjects or bodies. The ID is
// sender text, so it is capped and JSON-encoded rather than interpolated.
function log(event: string, fields: Record<string, string | number | undefined>): void {
  console.log(JSON.stringify({ event, ...fields }));
}

export default {
  // Mail is never rejected or bounced from here: a failure is logged and the message dropped.
  // The sender-facing copy still sits in the user's own Gmail or iCloud account.
  async email(message, env) {
    let mail;
    try {
      const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
      mail = await toBotMail({
        raw,
        envelopeTo: message.to,
        mailboxes: env.MAILBOXES ?? "",
        now: new Date(),
      });
    } catch (error) {
      log("mail.parse_failed", { error: error instanceof Error ? error.name : "unknown" });
      return;
    }
    const messageId = mail.messageId.slice(0, 200);

    // A forged confirmation fails DMARC at Cloudflare, so one that does is treated as ordinary mail.
    if (mail.auth.dmarc !== "fail" && isGmailForwardingConfirmation(mail.from, mail.subject)) {
      log("gmail.forwarding_confirmation", { messageId, ...readGmailConfirmation(mail.bodyText) });
      return;
    }

    if (!env.BOX_URL || !env.WEBHOOK_SECRET) {
      log("mail.not_configured", { messageId });
      return;
    }

    const result = await deliverToBox({
      url: env.BOX_URL,
      secret: env.WEBHOOK_SECRET,
      payload: mail,
    });
    log(result.ok ? "mail.delivered" : "mail.dropped", {
      messageId,
      status: result.status,
      attempts: result.attempts,
    });
  },
} satisfies ExportedHandler<Env>;
