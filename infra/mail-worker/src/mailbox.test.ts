import { describe, expect, it } from "vite-plus/test";

import { chooseMailbox } from "./mailbox.ts";

const h = (key: string, value: string) => ({ key, value });

describe("chooseMailbox", () => {
  const allowlist = "me@gmail.com, Other@iCloud.com";

  it("takes the allowlisted address from a forwarding header, case-insensitively", () => {
    expect(
      chooseMailbox({
        headers: [
          h("x-forwarded-for", "ME@Gmail.com routing@mail.example.com"),
          h("to", "someone@else.example"),
        ],
        allowlist,
        envelopeTo: "routing@mail.example.com",
      }),
    ).toBe("me@gmail.com");
  });

  it("matches a name-addr To header and picks the allowlisted one among several", () => {
    expect(
      chooseMailbox({
        headers: [h("to", '"A, B" <a@b.example>, Me <other@icloud.com>')],
        allowlist,
        envelopeTo: "routing@mail.example.com",
      }),
    ).toBe("other@icloud.com");
  });

  it("does not treat Gmail dots or plus tags as the same address", () => {
    expect(
      chooseMailbox({
        headers: [h("to", "m.e@gmail.com, me+shop@gmail.com")],
        allowlist,
        envelopeTo: "routing@mail.example.com",
      }),
    ).toBe("m.e@gmail.com");
  });

  it("falls back to the first To address when nothing matches, or no allowlist is set", () => {
    for (const list of [allowlist, ""]) {
      expect(
        chooseMailbox({
          headers: [h("to", "Unknown <Stranger@Example.org>, second@example.org")],
          allowlist: list,
          envelopeTo: "routing@mail.example.com",
        }),
      ).toBe("stranger@example.org");
    }
  });

  it("falls back to the envelope recipient, never to an empty string", () => {
    expect(chooseMailbox({ headers: [], allowlist, envelopeTo: "Routing@Mail.Example.com" })).toBe(
      "routing@mail.example.com",
    );
    expect(chooseMailbox({ headers: [], allowlist, envelopeTo: "" })).toBe("unknown");
  });

  it("prefers the topmost header of a kind and Delivered-To over To", () => {
    expect(
      chooseMailbox({
        headers: [
          h("delivered-to", "other@icloud.com"),
          h("delivered-to", "me@gmail.com"),
          h("to", "me@gmail.com"),
        ],
        allowlist,
        envelopeTo: "routing@mail.example.com",
      }),
    ).toBe("other@icloud.com");
  });
});
