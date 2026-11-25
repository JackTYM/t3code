// Synthetic messages written for these tests; none is a capture of real mail. The Gmail and iCloud
// shapes are inferred from how those services are known to forward, not recorded from them.
const encoder = new TextEncoder();

/** Joins lines with CRLF, as SMTP delivers them, and ends the message with a newline. */
export function eml(...lines: string[]): Uint8Array<ArrayBuffer> {
  return encoder.encode(`${lines.join("\r\n")}\r\n`);
}

/** A message whose body is raw bytes in a legacy charset, which a JS string cannot hold. */
export function emlWithBytes(headerLines: string[], body: number[]): Uint8Array<ArrayBuffer> {
  const head = encoder.encode(`${headerLines.join("\r\n")}\r\n\r\n`);
  const out = new Uint8Array(head.length + body.length);
  out.set(head, 0);
  out.set(body, head.length);
  return out;
}

/** What Cloudflare Email Routing prepends, per its documentation. */
export const CLOUDFLARE_AUTH =
  "Authentication-Results: mx.cloudflare.net; spf=pass smtp.mailfrom=alice@example.net; dkim=pass header.d=example.net; dmarc=pass header.from=example.net";

export const multipartAlternative = eml(
  CLOUDFLARE_AUTH,
  "Message-ID: <alt-1@example.net>",
  "From: Alice Example <Alice@Example.NET>",
  "To: Me <me@example.org>, other@example.org",
  "Subject: Lunch plans",
  "Date: Tue, 03 Nov 2026 10:15:00 +0000",
  "MIME-Version: 1.0",
  'Content-Type: multipart/alternative; boundary="b1"',
  "",
  "--b1",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Plain version of the lunch plans.",
  "--b1",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<p>HTML version of the lunch plans.</p>",
  "--b1--",
);

export const htmlOnly = eml(
  CLOUDFLARE_AUTH,
  "Message-ID: <html-1@example.net>",
  "From: news@example.net",
  "To: me@example.org",
  "Subject: Newsletter",
  "Date: Tue, 03 Nov 2026 10:15:00 +0000",
  "MIME-Version: 1.0",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<html><head><style>.x { color: red }</style><script>alert('SCRIPT-MARKER')</script></head>",
  "<body><h1>Big news</h1><p>Rock &amp; roll &lt;3</p>",
  '<img src="https://tracker.example.net/pixel.gif"><!-- COMMENT-MARKER --></body></html>',
);

export const base64Body = eml(
  CLOUDFLARE_AUTH,
  "Message-ID: <b64-1@example.net>",
  "From: alice@example.net",
  "To: me@example.org",
  "Subject: Encoded",
  "Date: Tue, 03 Nov 2026 10:15:00 +0000",
  "MIME-Version: 1.0",
  "Content-Type: text/plain; charset=utf-8",
  "Content-Transfer-Encoding: base64",
  "",
  "SGVsbG8gZnJvbSBiYXNlNjQgYm9keS4gw5xuw69jb2RlIOKckwo=",
);

export const rfc2047Subject = eml(
  CLOUDFLARE_AUTH,
  "Message-ID: <rfc2047-1@example.net>",
  "From: =?UTF-8?Q?J=C3=BCrgen_M=C3=BCller?= <jm@example.net>",
  "To: me@example.org",
  "Subject: =?UTF-8?B?Q2Fmw6kg8J+Ygg==?= =?ISO-8859-1?Q?_au_lait_=E9t=E9?=",
  "Date: Tue, 03 Nov 2026 10:15:00 +0000",
  "Content-Type: text/plain; charset=us-ascii",
  "",
  "ok",
);

export const latin1QuotedPrintable = eml(
  CLOUDFLARE_AUTH,
  "Message-ID: <qp-1@example.net>",
  "From: alice@example.net",
  "To: me@example.org",
  "Subject: Gr=?ISO-8859-1?Q?=FC=DFe?=",
  "Date: Tue, 03 Nov 2026 10:15:00 +0000",
  "Content-Type: text/plain; charset=iso-8859-1",
  "Content-Transfer-Encoding: quoted-printable",
  "",
  "Gr=FC=DFe aus M=FCnchen, soft=",
  "wrapped line.",
);

// "Привет" in KOI8-R, sent as raw 8-bit bytes.
export const koi8rBody = emlWithBytes(
  [
    CLOUDFLARE_AUTH,
    "Message-ID: <koi8-1@example.net>",
    "From: alice@example.net",
    "To: me@example.org",
    "Subject: koi8",
    "Date: Tue, 03 Nov 2026 10:15:00 +0000",
    "Content-Type: text/plain; charset=koi8-r",
    "Content-Transfer-Encoding: 8bit",
  ],
  [0xf0, 0xd2, 0xc9, 0xd7, 0xc5, 0xd4, 0x0a],
);

// A sender who prepends their own results claiming a pass, and a forged copy of Cloudflare's
// authserv-id further down. Cloudflare's real header, added last, is on top.
export const forgedAuthBelowCloudflare = eml(
  "Authentication-Results: mx.cloudflare.net; spf=fail; dkim=none; dmarc=fail header.from=bank.example",
  "Authentication-Results: mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass",
  "Authentication-Results: mx.google.com; dkim=pass; spf=pass; dmarc=pass",
  "Message-ID: <forged-1@bank.example>",
  "From: security@bank.example",
  "To: me@example.org",
  "Subject: Verify your account",
  "Date: Tue, 03 Nov 2026 10:15:00 +0000",
  "",
  "Click here",
);

// Cloudflare added nothing on top (hypothetically); the forged header must not be trusted.
export const forgedAuthOnTop = eml(
  "Authentication-Results: mx.attacker.example; spf=pass; dkim=pass; dmarc=pass",
  "Authentication-Results: mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass",
  "Message-ID: <forged-2@bank.example>",
  "From: security@bank.example",
  "To: me@example.org",
  "Subject: Verify your account",
  "Date: Tue, 03 Nov 2026 10:15:00 +0000",
  "",
  "Click here",
);

export const gmailForwarded = eml(
  "Authentication-Results: mx.cloudflare.net; dkim=pass header.d=example.net; spf=softfail smtp.mailfrom=alice@example.net; dmarc=pass header.from=example.net",
  "Received: from mail-sor-f41.google.com by mx.cloudflare.net; Tue, 03 Nov 2026 10:15:05 +0000",
  "X-Forwarded-To: routing@mail.example.com",
  "X-Forwarded-For: me@gmail.com routing@mail.example.com",
  "Delivered-To: me@gmail.com",
  "Message-ID: <gmail-1@example.net>",
  "From: Alice <alice@example.net>",
  "To: Me.Name+shop@gmail.com, friend@example.org",
  "Subject: Fwd test",
  "Date: Tue, 03 Nov 2026 10:15:00 +0000",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Forwarded by Gmail.",
);

// Inferred: iCloud's forward-to keeps the original headers and adds no routing hints.
export const icloudForwarded = eml(
  CLOUDFLARE_AUTH,
  "Received: from mr85p00im-ztdg06021901.me.com by mx.cloudflare.net; Tue, 03 Nov 2026 10:15:05 +0000",
  "Message-ID: <icloud-1@example.net>",
  "From: alice@example.net",
  "To: me@icloud.com",
  "Subject: Hello iCloud",
  "Date: Tue, 03 Nov 2026 10:15:00 +0000",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Forwarded by iCloud.",
);

export const withAttachments = eml(
  CLOUDFLARE_AUTH,
  "Message-ID: <att-1@example.net>",
  "From: alice@example.net",
  "To: me@example.org",
  "Subject: Files",
  "Date: Tue, 03 Nov 2026 10:15:00 +0000",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="m1"',
  "",
  "--m1",
  "Content-Type: text/plain",
  "",
  "See attached.",
  "--m1",
  'Content-Type: application/pdf; name="invoice.pdf"',
  'Content-Disposition: attachment; filename="invoice.pdf"',
  "Content-Transfer-Encoding: base64",
  "",
  "SEVBVkFUVEFDSE1FTlRCWVRFUw==",
  "--m1",
  "Content-Type: application/octet-stream",
  "Content-Disposition: attachment",
  "Content-Transfer-Encoding: base64",
  "",
  "AAECAw==",
  "--m1--",
);

export function oversizedBody(chars: number): Uint8Array<ArrayBuffer> {
  return eml(
    CLOUDFLARE_AUTH,
    "Message-ID: <big-1@example.net>",
    "From: alice@example.net",
    "To: me@example.org",
    `Subject: ${"S".repeat(5_000)}`,
    "Date: Tue, 03 Nov 2026 10:15:00 +0000",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "word ".repeat(Math.ceil(chars / 5)),
  );
}

export const junk = eml("not a header at all", "", "\u0000\u0001 garbage <<<<<<< ((((");

export const noMessageIdBadDate = eml(
  CLOUDFLARE_AUTH,
  "From: alice@example.net",
  "To: me@example.org",
  "Subject: Odd",
  "Date: not a date",
  "",
  "body",
);

export const gmailConfirmation = gmailConfirmationWith(CLOUDFLARE_AUTH);

export function gmailConfirmationWith(authLine: string): Uint8Array<ArrayBuffer> {
  return eml(
    authLine,
    "Message-ID: <gconf-1@mail.gmail.com>",
    "From: Gmail Team <forwarding-noreply@google.com>",
    "To: routing@mail.example.com",
    "Subject: Gmail Forwarding Confirmation - Receive Mail from me@gmail.com",
    "Date: Tue, 03 Nov 2026 10:15:00 +0000",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "me@gmail.com has requested to automatically forward mail to your email address routing@mail.example.com.",
    "",
    "Confirmation code: 123456789",
    "",
    "To allow me@gmail.com to automatically forward mail to your address, please click the link below to confirm the request:",
    "",
    "https://mail-settings.google.com/mail/vf-%5BANGjdJ-fake%5D-abc123",
    "",
    "If you click the link and it appears to be broken, please copy and paste it into a new browser window.",
  );
}
