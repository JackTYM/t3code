import { describe, expect, it } from "vite-plus/test";

import { isBulkMail } from "./bulk.ts";

const bulk = (headers: Array<[string, string]>, from = "alice@example.com") =>
  isBulkMail(
    headers.map(([key, value]) => ({ key, value })),
    from,
  );

describe("isBulkMail", () => {
  it("is not bulk for a person's mail with ordinary headers", () => {
    expect(
      bulk([
        ["subject", "Lunch?"],
        ["auto-submitted", "no"],
        ["precedence", "normal"],
      ]),
    ).toBe(false);
  });

  it.each([
    ["List-Unsubscribe", "list-unsubscribe", "<mailto:leave@example.com>"],
    ["List-Id", "list-id", "<news.example.com>"],
    ["Precedence: bulk", "precedence", "bulk"],
    ["Precedence: list", "precedence", " List "],
    ["Precedence: junk", "precedence", "junk"],
    ["Auto-Submitted: auto-generated", "auto-submitted", "auto-generated"],
    ["Auto-Submitted: auto-replied with a comment", "auto-submitted", "auto-replied (vacation)"],
  ])("is bulk for %s", (_name, key, value) => {
    expect(bulk([[key, value]])).toBe(true);
  });

  it("ignores empty list headers and an unknown precedence", () => {
    expect(
      bulk([
        ["list-unsubscribe", "  "],
        ["precedence", "first-class"],
        ["auto-submitted", ""],
      ]),
    ).toBe(false);
  });

  it.each([
    "noreply@shop.example",
    "no-reply@shop.example",
    "no_reply@shop.example",
    "do-not-reply@shop.example",
    "DoNotReply@shop.example",
    "newsletter@shop.example",
    "newsletters@shop.example",
    "marketing@shop.example",
    "notifications@shop.example",
    "NoReply+tag@shop.example",
  ])("is bulk for the obvious machine sender %s", (from) => {
    expect(bulk([], from)).toBe(true);
  });

  it.each([
    "mailer-daemon@example.com",
    "alice@example.com",
    "noreply.person@example.com",
    "marketing.lead@example.com",
    "alice@noreply.example.com",
    "",
    "no-at-sign",
  ])("is not bulk for the sender %s alone", (from) => {
    expect(bulk([], from)).toBe(false);
  });
});
