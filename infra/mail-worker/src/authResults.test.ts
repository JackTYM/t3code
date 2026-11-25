import { describe, expect, it } from "vite-plus/test";

import { readCloudflareAuth } from "./authResults.ts";

const header = (value: string, key = "authentication-results") => ({ key, value });

describe("readCloudflareAuth", () => {
  it("reads the verdicts of Cloudflare's header", () => {
    expect(
      readCloudflareAuth([header("mx.cloudflare.net; spf=pass; dkim=fail; dmarc=pass")]),
    ).toEqual({ spf: "pass", dkim: "fail", dmarc: "pass", source: "cloudflare" });
  });

  it("maps softfail to fail and verdicts that assert nothing to none", () => {
    const auth = readCloudflareAuth([
      header("mx.cloudflare.net; spf=softfail; dkim=neutral; dmarc=temperror"),
    ]);
    expect(auth).toMatchObject({ spf: "fail", dkim: "none", dmarc: "none" });
  });

  it("reports none for a mechanism the header does not mention, without computing DMARC", () => {
    expect(readCloudflareAuth([header("mx.cloudflare.net; spf=pass; dkim=pass")])).toMatchObject({
      dmarc: "none",
    });
  });

  it("lets any passing DKIM signature win, then any failing one", () => {
    expect(
      readCloudflareAuth([header("mx.cloudflare.net; dkim=fail header.d=a; dkim=pass header.d=b")]),
    ).toMatchObject({ dkim: "pass" });
    expect(
      readCloudflareAuth([header("mx.cloudflare.net; dkim=none; dkim=fail header.d=b")]),
    ).toMatchObject({ dkim: "fail" });
  });

  it("tolerates case, a trailing dot, a version, comments and folding whitespace", () => {
    expect(
      readCloudflareAuth([
        header(
          "MX.Cloudflare.NET. 1 (mx; v1) ; SPF = pass (sender IP is 1.2.3.4; ok) ;\n dmarc=pass",
        ),
      ]),
    ).toMatchObject({ spf: "pass", dmarc: "pass" });
  });

  it("reads only the topmost header, so a lower forged one cannot change the result", () => {
    const auth = readCloudflareAuth([
      header("mx.cloudflare.net; spf=fail; dkim=none; dmarc=fail"),
      header("mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass"),
    ]);
    expect(auth).toMatchObject({ spf: "fail", dkim: "none", dmarc: "fail" });
  });

  it("trusts nothing when the topmost header names another server", () => {
    const auth = readCloudflareAuth([
      header("mx.attacker.example; spf=pass; dkim=pass; dmarc=pass"),
      header("mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass"),
    ]);
    expect(auth).toEqual({ spf: "none", dkim: "none", dmarc: "none", source: "cloudflare" });
  });

  it("does not accept lookalike server ids", () => {
    for (const id of [
      "mx.cloudflare.net.evil.example",
      "evil-mx.cloudflare.net",
      "cloudflare.net",
    ]) {
      expect(readCloudflareAuth([header(`${id}; dmarc=pass`)])).toMatchObject({ dmarc: "none" });
    }
  });

  it("returns none when there is no header or it is junk", () => {
    expect(readCloudflareAuth([])).toMatchObject({ dmarc: "none" });
    expect(readCloudflareAuth([header("")])).toMatchObject({ dmarc: "none" });
    expect(readCloudflareAuth([header("mx.cloudflare.net; none")])).toMatchObject({
      spf: "none",
      dkim: "none",
      dmarc: "none",
    });
  });
});
