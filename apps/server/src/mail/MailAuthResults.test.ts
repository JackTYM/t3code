import { assert, describe, it } from "@effect/vitest";

import { providerOfAccount, receiverAuth } from "./MailAuthResults.ts";
import { rfc822 } from "./MailAppReader.testkit.ts";
import { parseMail } from "./MailMessageParser.ts";

const authFor = (
  headers: ReadonlyArray<readonly [string, string]>,
  provider: "google" | "icloud" | "other",
) => receiverAuth(parseMail(new TextEncoder().encode(rfc822(headers, ""))).headers, provider);

const GOOGLE =
  "mx.google.com; dkim=pass header.i=@x.test header.s=s1; spf=pass (google.com: domain of a@x.test designates 1.2.3.4 as permitted sender) smtp.mailfrom=a@x.test; dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=x.test";
const ICLOUD =
  'bimi.icloud.com; bimi=skipped reason="insufficient dmarc"; dkim=pass header.d=x.test header.s=s1; dmarc=pass header.from=x.test; spf=pass smtp.mailfrom=a@x.test';
const NONE = { dkim: "none", spf: "none", dmarc: "none", source: "mail-app" } as const;

describe("receiverAuth", () => {
  it("reads the verdicts Google added when it received the mail", () => {
    assert.deepStrictEqual(authFor([["Authentication-Results", GOOGLE]], "google"), {
      dkim: "pass",
      spf: "pass",
      dmarc: "pass",
      source: "mail-app",
    });
  });

  it("maps failures to fail and anything undecided to none", () => {
    assert.deepStrictEqual(
      authFor(
        [
          [
            "Authentication-Results",
            'mx.google.com; dkim=fail reason="bad"; spf=softfail smtp.mailfrom=a@x.test; dmarc=temperror header.from=x.test',
          ],
        ],
        "google",
      ),
      { dkim: "fail", spf: "fail", dmarc: "none", source: "mail-app" },
    );
    assert.deepStrictEqual(
      authFor([["Authentication-Results", "mx.google.com; spf=neutral; dkim=none"]], "google"),
      NONE,
    );
  });

  it("counts one good DKIM signature among several, but takes SPF and DMARC once", () => {
    assert.deepStrictEqual(
      authFor(
        [
          [
            "Authentication-Results",
            "mx.google.com; dkim=fail header.d=a.test; dkim=pass header.d=b.test; spf=fail; spf=pass; dmarc=fail; dmarc=pass",
          ],
        ],
        "google",
      ),
      { dkim: "pass", spf: "fail", dmarc: "fail", source: "mail-app" },
    );
  });

  it("returns none when there is no Authentication-Results header", () => {
    assert.deepStrictEqual(authFor([["Subject", "x"]], "google"), NONE);
  });

  it("ignores a forged header the sender put below the one Google added", () => {
    assert.deepStrictEqual(
      authFor(
        [
          ["Authentication-Results", "mx.google.com; dkim=fail; spf=fail; dmarc=fail"],
          ["Received", "from elsewhere by mx.google.com"],
          ["Authentication-Results", GOOGLE],
        ],
        "google",
      ),
      { dkim: "fail", spf: "fail", dmarc: "fail", source: "mail-app" },
    );
  });

  it("returns none, and looks no further down, when the topmost header is not the receiver's", () => {
    assert.deepStrictEqual(
      authFor(
        [
          ["Authentication-Results", "relay.evil.test; dkim=pass; spf=pass; dmarc=pass"],
          ["Authentication-Results", GOOGLE],
        ],
        "google",
      ),
      NONE,
    );
  });

  it("does not take a Google verdict on an account that does not receive through Google", () => {
    assert.deepStrictEqual(authFor([["Authentication-Results", GOOGLE]], "other"), NONE);
  });

  it("is not fooled by an authserv-id that merely contains or extends Google's", () => {
    for (const id of ["mx.google.com.evil.test", "evilmx.google.com", "mx.google.com@evil.test"]) {
      assert.deepStrictEqual(
        authFor([["Authentication-Results", `${id}; dkim=pass; spf=pass; dmarc=pass`]], "google"),
        NONE,
      );
    }
  });

  it("does not read verdicts out of comments or quoted reasons", () => {
    assert.deepStrictEqual(
      authFor(
        [
          [
            "Authentication-Results",
            'mx.google.com; dkim=fail (dkim=pass; spf=pass; dmarc=pass) reason="; spf=pass; dmarc=pass"',
          ],
        ],
        "google",
      ),
      { dkim: "fail", spf: "none", dmarc: "none", source: "mail-app" },
    );
  });

  it("does not read text in the body that looks like the header", () => {
    const mail = parseMail(
      new TextEncoder().encode(rfc822([["Subject", "x"]], `Authentication-Results: ${GOOGLE}`)),
    );
    assert.deepStrictEqual(receiverAuth(mail.headers, "google"), NONE);
  });
});

describe("receiverAuth on iCloud", () => {
  it("reads the verdicts iCloud added when it received the mail", () => {
    assert.deepStrictEqual(authFor([["Authentication-Results", ICLOUD]], "icloud"), {
      dkim: "pass",
      spf: "pass",
      dmarc: "pass",
      source: "mail-app",
    });
  });

  it("ignores a forged header the sender put below iCloud's own", () => {
    assert.deepStrictEqual(
      authFor(
        [
          ["Authentication-Results", "bimi.icloud.com; dkim=fail; spf=fail; dmarc=fail"],
          ["Received", "from elsewhere by bimi.icloud.com"],
          ["Authentication-Results", ICLOUD],
        ],
        "icloud",
      ),
      { dkim: "fail", spf: "fail", dmarc: "fail", source: "mail-app" },
    );
  });

  it("gives no verdict when a forged header is on top, whoever it claims to be", () => {
    for (const id of ["relay.evil.test", "mx.google.com", "bimi.icloud.com.evil.test"]) {
      assert.deepStrictEqual(
        authFor(
          [
            ["Authentication-Results", `${id}; dkim=pass; spf=pass; dmarc=pass`],
            ["Authentication-Results", ICLOUD],
          ],
          "icloud",
        ),
        NONE,
      );
    }
  });

  it("does not take a Gmail-style id on an iCloud account, or iCloud's on a Gmail one", () => {
    assert.deepStrictEqual(authFor([["Authentication-Results", GOOGLE]], "icloud"), NONE);
    assert.deepStrictEqual(authFor([["Authentication-Results", ICLOUD]], "google"), NONE);
    assert.deepStrictEqual(authFor([["Authentication-Results", ICLOUD]], "other"), NONE);
  });
});

describe("providerOfAccount", () => {
  it("knows Gmail by its folder and iCloud by the account's own address", () => {
    assert.strictEqual(providerOfAccount({ hasGmailFolder: true, addresses: [] }), "google");
    for (const address of ["me@icloud.com", "Me@ME.com", "old@mac.com"]) {
      assert.strictEqual(
        providerOfAccount({ hasGmailFolder: false, addresses: [address] }),
        "icloud",
      );
    }
  });

  it("leaves everything else, and an account with no known address, as other", () => {
    for (const addresses of [
      [],
      ["me@gmail.com"],
      ["me@icloud.com.evil.test"],
      ["me@noticloud.com"],
    ]) {
      assert.strictEqual(providerOfAccount({ hasGmailFolder: false, addresses }), "other");
    }
  });
});
