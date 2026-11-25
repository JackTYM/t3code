// @effect-diagnostics nodeBuiltinImport:off -- fixtures build message bytes.
import { assert, describe, it } from "@effect/vitest";

import { emlxMessage, isBulkMail, parseMail } from "./MailMessageParser.ts";
import { rfc822 } from "./MailAppReader.testkit.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const parse = (raw: string | Uint8Array) => parseMail(typeof raw === "string" ? bytes(raw) : raw);

describe("emlxMessage", () => {
  it("cuts the message out from between the length line and the trailing plist", () => {
    const message = rfc822([["Subject", "Hi"]], "body");
    const file = bytes(`${message.length}\n${message}<?xml version="1.0"?><plist/>`);
    assert.strictEqual(new TextDecoder().decode(emlxMessage(file)), message);
  });

  it("takes a file with no length line as a bare message", () => {
    const message = rfc822([["Subject", "Hi"]], "body");
    assert.strictEqual(new TextDecoder().decode(emlxMessage(bytes(message))), message);
  });

  it("does not read past a length that is longer than the file", () => {
    const file = bytes("999999\nSubject: x\r\n\r\nbody");
    assert.strictEqual(new TextDecoder().decode(emlxMessage(file)), "Subject: x\r\n\r\nbody");
  });
});

describe("headers", () => {
  it("decodes RFC 2047 words in B and Q form, in several charsets, across folded lines", () => {
    const mail = parse(
      rfc822(
        [
          ["Subject", "=?UTF-8?B?Q2Fmw6k=?= =?utf-8?q?_cr=C3=A8me?="],
          ["From", "=?ISO-8859-1?Q?Andr=E9?= <Andre@Example.COM>"],
          ["To", "A <a@x.test>,\r\n\t=?utf-8?Q?B=C3=A9?= <b@x.test>"],
        ],
        "",
      ),
    );
    assert.strictEqual(mail.subject, "Café crème");
    assert.strictEqual(mail.from, "andre@example.com");
    assert.deepStrictEqual(mail.to, ["a@x.test", "b@x.test"]);
  });

  it("reads addresses with quoted names, comments and groups without being fooled by them", () => {
    const mail = parse(
      rfc822(
        [
          ["From", '"evil <fake@evil.test>, boss" <real@x.test> (Real Person)'],
          ["To", "Team: a@x.test, B <b@x.test>;"],
          ["Cc", "undisclosed-recipients:;"],
        ],
        "",
      ),
    );
    assert.strictEqual(mail.from, "real@x.test");
    assert.deepStrictEqual(mail.to, ["a@x.test", "b@x.test"]);
    assert.deepStrictEqual(mail.cc, []);
  });

  it("gives a message with no Message-ID the same synthetic one every time", () => {
    const raw = rfc822([["Subject", "no id"]], "body");
    const first = parse(raw).messageId;
    assert.match(first, /^no-message-id-[0-9a-f]{32}@mail-app\.invalid$/u);
    assert.strictEqual(parse(raw).messageId, first);
    assert.strictEqual(parse(rfc822([["Message-ID", "<abc@x.test>"]], "")).messageId, "abc@x.test");
  });

  it("reads only the topmost Delivered-To, the one the receiving server added", () => {
    const mail = parse(
      rfc822(
        [
          ["Delivered-To", "me@x.test"],
          ["Delivered-To", "forged@evil.test"],
        ],
        "",
      ),
    );
    assert.strictEqual(mail.deliveredTo, "me@x.test");
  });

  it("parses the Date header and returns nothing for one it cannot read", () => {
    assert.strictEqual(
      parse(rfc822([["Date", "Tue, 10 Jun 2025 08:30:00 +0200 (CEST)"]], "")).sentAtMs,
      Date.UTC(2025, 5, 10, 6, 30),
    );
    assert.isUndefined(parse(rfc822([["Date", "sometime last week"]], "")).sentAtMs);
    assert.isUndefined(parse(rfc822([], "")).sentAtMs);
  });

  it("recognises a Mail draft by its type header", () => {
    assert.isTrue(
      parse(rfc822([["X-Uniform-Type-Identifier", "com.apple.mail-draft"]], "")).isDraft,
    );
    assert.isFalse(parse(rfc822([["Subject", "x"]], "")).isDraft);
  });
});

describe("bodies", () => {
  it("decodes quoted-printable in UTF-8 and in a legacy charset, with soft line breaks", () => {
    const utf8 = parse(
      rfc822(
        [
          ["Content-Type", 'text/plain; charset="utf-8"'],
          ["Content-Transfer-Encoding", "quoted-printable"],
        ],
        "caf=C3=A9 au la=\r\nit =E2=82=AC5",
      ),
    );
    assert.strictEqual(utf8.bodyText, "café au lait €5");
    const latin = parse(
      rfc822(
        [
          ["Content-Type", "text/plain; charset=iso-8859-1"],
          ["Content-Transfer-Encoding", "quoted-printable"],
        ],
        "na=EFve",
      ),
    );
    assert.strictEqual(latin.bodyText, "naïve");
  });

  it("decodes base64, and 8-bit text in the declared charset", () => {
    const based = parse(
      rfc822(
        [
          ["Content-Type", "text/plain; charset=utf-8"],
          ["Content-Transfer-Encoding", "base64"],
        ],
        Buffer.from("héllo wörld", "utf8").toString("base64"),
      ),
    );
    assert.strictEqual(based.bodyText, "héllo wörld");
    const eightBit = parse(
      Buffer.concat([
        Buffer.from(rfc822([["Content-Type", "text/plain; charset=windows-1252"]], "")),
        Buffer.from([0x93, 0x68, 0x69, 0x94]),
      ]),
    );
    assert.strictEqual(eightBit.bodyText, "“hi”");
  });

  it("prefers the plain part of multipart/alternative, even when HTML comes last", () => {
    const mail = parse(
      rfc822(
        [["Content-Type", 'multipart/alternative; boundary="B1"']],
        [
          "preamble",
          "--B1",
          "Content-Type: text/plain; charset=utf-8",
          "",
          "plain version",
          "--B1",
          "Content-Type: text/html; charset=utf-8",
          "",
          "<p>html <b>version</b></p>",
          "--B1--",
          "epilogue",
        ].join("\r\n"),
      ),
    );
    assert.strictEqual(mail.bodyText, "plain version");
  });

  it("turns an HTML-only mail into text without scripts, styles, tags or remote content", () => {
    const html = [
      "<html><head><title>Ignore me</title><style>p { color: red }</style></head>",
      "<body><!-- hidden comment --><script>alert('x')</script>",
      '<p>Hello &amp; welcome, &hellip; &#169; &#x1F600;</p><img src="https://tracker.test/p.gif">',
      '<ul><li>one</li><li>two</li></ul><a href="https://example.test/confirm?t=1">Confirm</a>',
      "<table><tr><td>a</td><td>b</td></tr></table>",
      "<div>5 < 6 and <not a tag</div></body></html>",
    ].join("");
    const text = parse(rfc822([["Content-Type", "text/html; charset=utf-8"]], html)).bodyText;
    assert.include(text, "Hello & welcome, … © 😀");
    assert.include(text, "- one\n- two");
    assert.include(text, "Confirm (https://example.test/confirm?t=1)");
    assert.include(text, "a b");
    for (const dropped of [
      "Ignore me",
      "color",
      "alert",
      "hidden comment",
      "tracker",
      "<p>",
      "<script",
    ]) {
      assert.notInclude(text, dropped);
    }
  });

  it("is not slowed or broken by unclosed tags, huge attributes and nested junk", () => {
    const hostile = `<a ${'x="'.repeat(50_000)} ${"<div>".repeat(50_000)} <script>${"<".repeat(100_000)}`;
    const mail = parse(rfc822([["Content-Type", "text/html"]], hostile));
    assert.isString(mail.bodyText);
  });

  it("lists attachment names, including RFC 2231 and RFC 2047 ones, and never their bytes", () => {
    const mail = parse(
      rfc822(
        [["Content-Type", 'multipart/mixed; boundary="M"']],
        [
          "--M",
          "Content-Type: text/plain",
          "",
          "see attached",
          "--M",
          "Content-Type: application/pdf",
          'Content-Disposition: attachment; filename="invoice.pdf"',
          "Content-Transfer-Encoding: base64",
          "",
          "JVBERi0xLjQK",
          "--M",
          "Content-Type: image/png; name*=utf-8''r%C3%A9sum%C3%A9.png",
          "",
          "iVBORw0KGgo=",
          "--M",
          "Content-Type: application/zip",
          "Content-Disposition: attachment; filename*0*=utf-8''a%20long; filename*1*=%20name.zip",
          "",
          "UEsDBA==",
          "--M",
          "Content-Type: text/csv",
          'Content-Disposition: attachment; filename="=?utf-8?B?ZGF0YeKAkzIuY3N2?="',
          "",
          "a,b",
          "--M--",
        ].join("\r\n"),
      ),
    );
    assert.strictEqual(mail.bodyText, "see attached");
    assert.deepStrictEqual(mail.attachmentNames, [
      "invoice.pdf",
      "résumé.png",
      "a long name.zip",
      "data–2.csv",
    ]);
  });

  it("joins the text parts of a mixed message and finds a body nested inside related", () => {
    const mail = parse(
      rfc822(
        [["Content-Type", 'multipart/mixed; boundary="O"']],
        [
          "--O",
          'Content-Type: multipart/related; boundary="I"',
          "",
          "--I",
          "Content-Type: text/html",
          "",
          "<p>first</p>",
          "--I--",
          "--O",
          "Content-Type: text/plain",
          "",
          "second",
          "--O--",
        ].join("\r\n"),
      ),
    );
    assert.strictEqual(mail.bodyText, "first\n\nsecond");
  });

  it("does not throw on junk: truncated multiparts, binary bodies, missing boundaries, deep nesting", () => {
    const nested = Array.from({ length: 30 }, (_, i) =>
      [`Content-Type: multipart/mixed; boundary="L${i}"`, "", `--L${i}`].join("\r\n"),
    ).join("\r\n");
    for (const raw of [
      "",
      "\r\n\r\n",
      "garbage with no colon\r\nmore garbage",
      rfc822([["Content-Type", "multipart/mixed"]], "no boundary parameter"),
      rfc822(
        [["Content-Type", 'multipart/mixed; boundary="X"']],
        "--X\r\nContent-Type: text/plain\r\n\r\ncut off",
      ),
      rfc822([["Content-Type", "text/plain; charset=no-such-charset"]], "still text"),
      rfc822([["Content-Transfer-Encoding", "base64"]], "!!!not base64!!!"),
      rfc822([["Content-Type", 'multipart/mixed; boundary="L0"']], nested),
    ]) {
      assert.isString(parse(raw).bodyText);
    }
    assert.strictEqual(
      parse(rfc822([["Content-Type", "text/plain; charset=no-such-charset"]], "still text"))
        .bodyText,
      "still text",
    );
    assert.isString(parse(new Uint8Array([0xff, 0x00, 0xfe, 0x0a, 0x0a, 0x80])).bodyText);
  });

  it("caps every field at the size the contract allows", () => {
    const mail = parse(
      rfc822(
        [
          ["Subject", "s".repeat(5_000)],
          ["From", `${"f".repeat(400)}@x.test`],
          ["To", `${"t".repeat(400)}@x.test, ok@x.test`],
          ["Message-ID", `<${"m".repeat(2_000)}@x.test>`],
          ["Content-Type", "text/plain"],
        ],
        "b".repeat(500_000),
      ),
    );
    assert.strictEqual(mail.subject.length, 1_000);
    assert.strictEqual(mail.bodyText.length, 200_000);
    assert.strictEqual(mail.messageId.length, 998);
    assert.strictEqual(mail.from, "");
    assert.deepStrictEqual(mail.to, ["ok@x.test"]);
  });

  it("does not cut a surrogate pair when it truncates", () => {
    const mail = parse(
      rfc822([["Content-Type", "text/plain; charset=utf-8"]], "😀".repeat(150_000)),
    );
    assert.isAtMost(mail.bodyText.length, 200_000);
    assert.notMatch(mail.bodyText, /[\ud800-\udbff]$/u);
  });
});

describe("isBulkMail", () => {
  const bulk = (fields: Array<[string, string]>, from = "alice@example.com") => {
    const mail = parse(rfc822([["From", from], ...fields], "body"));
    return isBulkMail(mail.headers, mail.from);
  };

  it("leaves a person's mail alone", () => {
    assert.isFalse(
      bulk([
        ["Subject", "Lunch?"],
        ["Auto-Submitted", "no"],
        ["Precedence", "normal"],
      ]),
    );
  });

  it("is bulk for list headers, bulk precedence and automated submission", () => {
    assert.isTrue(bulk([["List-Unsubscribe", "<mailto:leave@shop.example>"]]));
    assert.isTrue(bulk([["List-Id", "<news.example.com>"]]));
    assert.isTrue(bulk([["Precedence", "Bulk"]]));
    assert.isTrue(bulk([["Precedence", "list"]]));
    assert.isTrue(bulk([["Precedence", "junk"]]));
    assert.isTrue(bulk([["Auto-Submitted", "auto-generated"]]));
    assert.isTrue(bulk([["Auto-Submitted", "auto-replied (vacation)"]]));
  });

  it("is bulk for obvious machine senders, and not for look-alikes or mailer-daemon", () => {
    for (const from of [
      "noreply@shop.example",
      "No-Reply+x@shop.example",
      "newsletter@shop.example",
      "marketing@shop.example",
      "notifications@shop.example",
      "do_not_reply@shop.example",
    ]) {
      assert.isTrue(bulk([], from), from);
    }
    for (const from of [
      "mailer-daemon@example.com",
      "noreply.person@example.com",
      "alice@noreply.example.com",
    ]) {
      assert.isFalse(bulk([], from), from);
    }
  });
});
