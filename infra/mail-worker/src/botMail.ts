import type { BotMailMessage } from "@t3tools/contracts";
import PostalMime from "postal-mime";
import type { Address } from "postal-mime";

import { readCloudflareAuth } from "./authResults.ts";
import { isBulkMail } from "./bulk.ts";
import { htmlToText } from "./htmlToText.ts";
import { chooseMailbox } from "./mailbox.ts";

// These mirror the private limits in packages/contracts/src/botMail.ts; botMail.test.ts decodes
// the output with the contract schema, so drift fails there. Lists are bounded too, which the
// contract does not do, so one hostile message cannot make a huge request.
const BODY_MAX_CHARS = 200_000;
const SUBJECT_MAX_CHARS = 1_000;
const ADDRESS_MAX_CHARS = 320;
const MESSAGE_ID_MAX_CHARS = 998;
const ATTACHMENT_NAME_MAX_CHARS = 255;
const LIST_MAX_ITEMS = 100;

/** Truncates to `max` UTF-16 units without leaving half of a surrogate pair at the end. */
function cap(value: string, max: number): string {
  if (value.length <= max) return value;
  const end = /[\ud800-\udbff]/.test(value.charAt(max - 1)) ? max - 1 : max;
  return value.slice(0, end);
}

function addressesOf(list: Address[] | undefined): string[] {
  return (list ?? [])
    .flatMap((entry) => (entry.group ? entry.group : [entry]))
    .map((entry) => entry.address.toLowerCase())
    .filter(Boolean)
    .slice(0, LIST_MAX_ITEMS)
    .map((address) => cap(address, ADDRESS_MAX_CHARS));
}

async function fallbackMessageId(raw: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
  return `no-message-id-${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Turns one raw RFC 822 message into a BotMailMessage. Never throws on malformed mail: missing or
 * junk fields become empty, truncated, or defaulted values. Attachment bytes are dropped here;
 * only their names leave the Worker.
 */
export async function toBotMail(input: {
  raw: Uint8Array<ArrayBuffer>;
  envelopeTo: string;
  mailboxes: string;
  now: Date;
}): Promise<BotMailMessage> {
  const email = await PostalMime.parse(input.raw);

  const sentAtDate = new Date(email.date ?? Number.NaN);
  const from = email.from;
  const fromAddress = from ? (from.group ? from.group[0]?.address : from.address) : undefined;
  const messageId = email.messageId?.trim().replace(/^<|>$/g, "");

  return {
    // Without a Message-ID the store could not dedupe, so a retried delivery would double up.
    // Hashing the bytes gives the same id for the same message.
    messageId: cap(messageId || (await fallbackMessageId(input.raw)), MESSAGE_ID_MAX_CHARS),
    mailbox: cap(
      chooseMailbox({
        headers: email.headers,
        allowlist: input.mailboxes,
        envelopeTo: input.envelopeTo,
      }),
      ADDRESS_MAX_CHARS,
    ),
    from: cap((fromAddress ?? "").toLowerCase(), ADDRESS_MAX_CHARS),
    to: addressesOf(email.to),
    subject: cap(email.subject ?? "", SUBJECT_MAX_CHARS),
    sentAt: (Number.isNaN(sentAtDate.getTime()) ? input.now : sentAtDate).toISOString(),
    bodyText: cap(email.text?.trim() ? email.text : htmlToText(email.html ?? ""), BODY_MAX_CHARS),
    attachmentNames: email.attachments
      .slice(0, LIST_MAX_ITEMS)
      .map((attachment) =>
        cap(attachment.filename ?? `(unnamed ${attachment.mimeType})`, ATTACHMENT_NAME_MAX_CHARS),
      ),
    auth: readCloudflareAuth(email.headers),
    origin: "forward",
    bulk: isBulkMail(email.headers, (fromAddress ?? "").toLowerCase()),
  };
}
