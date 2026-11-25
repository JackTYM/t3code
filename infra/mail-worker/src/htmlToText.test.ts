import { describe, expect, it } from "vite-plus/test";

import { htmlToText } from "./htmlToText.ts";

describe("htmlToText", () => {
  it("keeps text and block structure, and decodes entities", () => {
    expect(
      htmlToText(
        "<h1>Hi &amp; welcome</h1><p>One<br>two &#x263A; &#65; &nbsp;&bogus;</p><ul><li>a</li><li>b</li></ul>",
      ),
    ).toBe("Hi & welcome\n\nOne\ntwo ☺ A &bogus;\n\n* a\n* b");
  });

  it("drops scripts, styles, titles, comments and tags, but never fetches or follows anything", () => {
    const text = htmlToText(
      '<title>T</title><style>p{}</style><script>var x="</p>";</script><!-- hidden --><p>shown</p><img src="https://t.example/p.gif" alt="a>b">',
    );
    expect(text).toBe("shown");
  });

  it("appends the target of a web link and ignores other schemes", () => {
    expect(
      htmlToText(
        '<a href="https://x.example/v?a=1&amp;b=2">Verify</a> <a href="javascript:alert(1)">no</a>',
      ),
    ).toBe("Verify (https://x.example/v?a=1&b=2) no");
  });

  it("treats a lone < as text and removes zero-width padding", () => {
    expect(htmlToText("1 < 2 &zwnj;​‌­ ok")).toBe("1 < 2 ok");
  });

  it("stays linear on unclosed and deeply repeated markup", () => {
    for (const hostile of [
      "<a ".repeat(200_000),
      "<!--".repeat(200_000),
      "<script>".repeat(100_000),
      '<a href="'.repeat(100_000),
    ]) {
      expect(htmlToText(hostile)).toBeTypeOf("string");
    }
    expect(htmlToText("x".repeat(5_000_000)).length).toBeLessThanOrEqual(3_000_000);
  });
});
