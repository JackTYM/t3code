import { BotMailMessage } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { toBotMail } from "./botMail.ts";
import { eml } from "./testFixtures.ts";
import * as fixtures from "./testFixtures.ts";

const NOW = new Date("2026-11-25T00:00:00.000Z");
const MAILBOXES = "me@gmail.com,me@icloud.com,me@example.org";
const decode = Schema.decodeUnknownSync(BotMailMessage);

async function convert(raw: Uint8Array<ArrayBuffer>, envelopeTo = "routing@mail.example.com") {
  const message = await toBotMail({ raw, envelopeTo, mailboxes: MAILBOXES, now: NOW });
  // Every output must satisfy the contract the box decodes it with.
  expect(decode(message)).toEqual(message);
  return message;
}

describe("toBotMail", () => {
  it("takes the plain part of a multipart/alternative message", async () => {
    const mail = await convert(fixtures.multipartAlternative);
    expect(mail).toMatchObject({
      messageId: "alt-1@example.net",
      from: "alice@example.net",
      to: ["me@example.org", "other@example.org"],
      subject: "Lunch plans",
      sentAt: "2026-11-03T10:15:00.000Z",
      mailbox: "me@example.org",
      origin: "forward",
      attachmentNames: [],
    });
    expect(mail.bodyText.trim()).toBe("Plain version of the lunch plans.");
  });

  it("converts HTML-only mail to text without scripts, styles, comments or remote content", async () => {
    const { bodyText } = await convert(fixtures.htmlOnly);
    expect(bodyText).toContain("Big news");
    expect(bodyText).toContain("Rock & roll <3");
    for (const marker of ["SCRIPT-MARKER", "COMMENT-MARKER", "color: red", "pixel.gif"]) {
      expect(bodyText).not.toContain(marker);
    }
  });

  it("decodes a base64 body", async () => {
    expect((await convert(fixtures.base64Body)).bodyText.trim()).toBe(
      "Hello from base64 body. Ünïcode ✓",
    );
  });

  it("decodes RFC 2047 subjects across charsets and encodings", async () => {
    expect((await convert(fixtures.rfc2047Subject)).subject).toBe("Café 😂 au lait été");
  });

  it("decodes quoted-printable in a non-UTF-8 charset", async () => {
    const mail = await convert(fixtures.latin1QuotedPrintable);
    expect(mail.bodyText.replace(/\s+/g, " ").trim()).toBe("Grüße aus München, softwrapped line.");
    expect(mail.subject).toBe("Grüße");
  });

  it("decodes a raw 8-bit body in a legacy charset", async () => {
    expect((await convert(fixtures.koi8rBody)).bodyText.trim()).toBe("Привет");
  });

  it("reads Cloudflare's verdicts, not the sender's forged ones", async () => {
    const mail = await convert(fixtures.forgedAuthBelowCloudflare);
    expect(mail.auth).toEqual({ spf: "fail", dkim: "none", dmarc: "fail", source: "cloudflare" });
  });

  it("trusts nothing when the topmost Authentication-Results is not Cloudflare's", async () => {
    const mail = await convert(fixtures.forgedAuthOnTop);
    expect(mail.auth).toEqual({ spf: "none", dkim: "none", dmarc: "none", source: "cloudflare" });
  });

  it("finds the original Gmail mailbox on mail forwarded to the routing address", async () => {
    const mail = await convert(fixtures.gmailForwarded);
    expect(mail.mailbox).toBe("me@gmail.com");
    expect(mail.auth).toEqual({ spf: "fail", dkim: "pass", dmarc: "pass", source: "cloudflare" });
    // The To header names a different Gmail spelling (dots and a tag) that is not on the allowlist.
    expect(mail.to).toEqual(["me.name+shop@gmail.com", "friend@example.org"]);
  });

  it("finds the iCloud mailbox from the To header", async () => {
    expect((await convert(fixtures.icloudForwarded)).mailbox).toBe("me@icloud.com");
  });

  it("keeps attachment names and never their bytes", async () => {
    const mail = await convert(fixtures.withAttachments);
    expect(mail.attachmentNames).toEqual(["invoice.pdf", "(unnamed application/octet-stream)"]);
    // The first attachment's decoded bytes spell this.
    expect(JSON.stringify(mail)).not.toContain("HEAVATTACHMENTBYTES");
  });

  it("caps an oversized body and subject at the contract's limits", async () => {
    const mail = await convert(fixtures.oversizedBody(500_000));
    expect(mail.bodyText).toHaveLength(200_000);
    expect(mail.subject).toHaveLength(1_000);
  });

  it("does not leave half a surrogate pair at a cut", async () => {
    const raw = new TextEncoder().encode(
      [
        "Message-ID: <s@x>",
        "From: a@b.example",
        "To: me@example.org",
        `Subject: ${"😀".repeat(600)}`,
        "",
        "x",
      ].join("\r\n"),
    );
    const { subject } = await convert(raw);
    expect(subject.length).toBeLessThanOrEqual(1_000);
    expect(/[\ud800-\udbff]$/.test(subject)).toBe(false);
  });

  it("never throws on junk and still satisfies the contract", async () => {
    const mail = await convert(fixtures.junk, "Routing@Mail.Example.com");
    expect(mail.mailbox).toBe("routing@mail.example.com");
    expect(mail.messageId.startsWith("no-message-id-")).toBe(true);
    expect(mail.sentAt).toBe(NOW.toISOString());
  });

  it("gives a missing Message-ID a stable id and a bad Date the current time", async () => {
    const first = await convert(fixtures.noMessageIdBadDate);
    const second = await convert(fixtures.noMessageIdBadDate);
    expect(first.messageId).toBe(second.messageId);
    expect(first.sentAt).toBe(NOW.toISOString());
  });

  it("marks newsletters bulk from their headers and leaves a person's mail alone", async () => {
    const newsletter = eml(
      "Message-ID: <n@shop.example>",
      "From: Shop <deals@shop.example>",
      "To: me@example.org",
      "Subject: 50% off",
      "List-Unsubscribe: <mailto:leave@shop.example>",
      "",
      "Buy things.",
    );
    expect((await convert(newsletter)).bulk).toBe(true);
    const noreply = eml(
      "Message-ID: <r@shop.example>",
      "From: Shop <No-Reply@shop.example>",
      "To: me@example.org",
      "Subject: Your receipt",
      "",
      "Thanks.",
    );
    expect((await convert(noreply)).bulk).toBe(true);
    expect((await convert(fixtures.multipartAlternative)).bulk).toBe(false);
  });
});
