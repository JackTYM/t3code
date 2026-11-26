import { assert, it } from "@effect/vitest";

import { redactSecrets, redactionSlack } from "./redactSecrets.ts";

it("replaces a value with the name of the grant it came from", () => {
  assert.strictEqual(
    redactSecrets("token is ghp_abcdef123456 ok", [
      { name: "GITHUB_TOKEN", value: "ghp_abcdef123456" },
    ]),
    "token is [secret GITHUB_TOKEN] ok",
  );
});

it("replaces every occurrence, across lines", () => {
  assert.strictEqual(
    redactSecrets("a hunter2hunter2\nb hunter2hunter2\nhunter2hunter2", [
      { name: "PASS", value: "hunter2hunter2" },
    ]),
    "a [secret PASS]\nb [secret PASS]\n[secret PASS]",
  );
});

it("replaces a value that spans lines, and the trimmed form of a value with a trailing newline", () => {
  const multi = "line-one-secret\nline-two-secret";
  assert.strictEqual(
    redactSecrets(`x ${multi} y`, [{ name: "KEY", value: multi }]),
    "x [secret KEY] y",
  );
  assert.strictEqual(
    redactSecrets("echo abcdefgh12345678 done", [{ name: "KEY", value: "abcdefgh12345678\n" }]),
    "echo [secret KEY] done",
  );
});

it("replaces the base64 and URL-encoded forms of a long value, not of a short one", () => {
  const value = "p@ss word/with+chars=";
  const base64 = Buffer.from(value).toString("base64");
  const encoded = encodeURIComponent(value);
  assert.notStrictEqual(encoded, value);
  assert.strictEqual(
    redactSecrets(`b64=${base64} url=${encoded} raw=${value}`, [{ name: "KEY", value }]),
    "b64=[secret KEY] url=[secret KEY] raw=[secret KEY]",
  );
  // Seven characters: only the value itself, since a short form would match unrelated text.
  const short = "a/b c+d";
  assert.strictEqual(short.length, 7);
  const shortBase64 = Buffer.from(short).toString("base64");
  assert.strictEqual(
    redactSecrets(`${shortBase64} ${encodeURIComponent(short)} ${short}`, [
      { name: "KEY", value: short },
    ]),
    `${shortBase64} ${encodeURIComponent(short)} [secret KEY]`,
  );
});

it("treats characters that mean something in a regular expression as plain text", () => {
  const value = "a.b*c+d?(e)[f]{g}|h^i$j\\k";
  assert.strictEqual(
    redactSecrets(`before ${value} after aXb`, [{ name: "KEY", value }]),
    "before [secret KEY] after aXb",
  );
});

it("skips a value that is empty or only whitespace, so it cannot rewrite every gap", () => {
  assert.strictEqual(
    redactSecrets("a b\n c", [
      { name: "EMPTY", value: "" },
      { name: "BLANK", value: " \n" },
    ]),
    "a b\n c",
  );
});

it("replaces a secret that contains another one as a whole, whichever comes first", () => {
  const inner = "abcd1234";
  const outer = "abcd1234efgh5678";
  for (const secrets of [
    [
      { name: "INNER", value: inner },
      { name: "OUTER", value: outer },
    ],
    [
      { name: "OUTER", value: outer },
      { name: "INNER", value: inner },
    ],
  ]) {
    assert.strictEqual(
      redactSecrets(`x ${outer} y ${inner} z`, secrets),
      "x [secret OUTER] y [secret INNER] z",
    );
  }
});

it("does not let a replacement be taken for text of another secret", () => {
  assert.strictEqual(
    redactSecrets("tok-123456 and secret", [
      { name: "TOKEN", value: "tok-123456" },
      { name: "WORD", value: "secret" },
    ]),
    "[secret TOKEN] and [secret WORD]",
  );
});

it("leaves no part of two secrets that overlap each other in the text", () => {
  const out = redactSecrets("zz-aaaaXXXXbbbb-zz", [
    { name: "A", value: "aaaaXXXX" },
    { name: "B", value: "XXXXbbbb" },
  ]);
  assert.notInclude(out, "aaaa");
  assert.notInclude(out, "bbbb");
  assert.notInclude(out, "XXXX");
  assert.include(out, "[secret A]");
  assert.include(out, "[secret B]");
});

it("returns the text as it was when there is nothing to hide", () => {
  assert.strictEqual(redactSecrets("plain", []), "plain");
  assert.strictEqual(redactSecrets("", [{ name: "KEY", value: "abcdefgh" }]), "");
});

it("does not throw on a value with a lone surrogate, and still hides it", () => {
  const value = "abc\uD800defghij";
  assert.strictEqual(redactSecrets(`x ${value} y`, [{ name: "KEY", value }]), "x [secret KEY] y");
});

it("hides the base64url, unpadded base64, JSON-escaped and lowercase percent-encoded forms", () => {
  const value = 'k?>~"tok\\en\n12345';
  const base64 = Buffer.from(value).toString("base64");
  const forms = {
    base64url: Buffer.from(value).toString("base64url"),
    unpadded: base64.replace(/=+$/u, ""),
    json: JSON.stringify(value).slice(1, -1),
    lowerPercent: encodeURIComponent(value).replace(/%[0-9A-F]{2}/gu, (match) =>
      match.toLowerCase(),
    ),
  };
  assert.notStrictEqual(forms.lowerPercent, encodeURIComponent(value));
  for (const [label, form] of Object.entries(forms)) {
    assert.strictEqual(
      redactSecrets(`<${form}>`, [{ name: "KEY", value }]),
      "<[secret KEY]>",
      label,
    );
  }
});

it("says how much longer than a value its longest form can be", () => {
  assert.strictEqual(redactionSlack([]), 0);
  const value = "p@ss word/with+chars=";
  const longest = Math.max(
    ...[
      value,
      Buffer.from(value).toString("base64"),
      encodeURIComponent(value),
      JSON.stringify(value),
    ].map((form) => Buffer.byteLength(form)),
  );
  assert.isAtLeast(redactionSlack([{ value }]), longest);
});
