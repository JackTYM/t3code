import { describe, expect, it } from "vite-plus/test";

import { isGmailForwardingConfirmation, readGmailConfirmation } from "./gmailConfirmation.ts";

describe("Gmail forwarding confirmation", () => {
  it("recognises Google's sender and subject only", () => {
    const subject = "Gmail Forwarding Confirmation - Receive Mail from me@gmail.com";
    expect(isGmailForwardingConfirmation("forwarding-noreply@google.com", subject)).toBe(true);
    expect(isGmailForwardingConfirmation("Forwarding-Noreply@Google.com", subject)).toBe(true);
    expect(
      isGmailForwardingConfirmation("forwarding-noreply@google.com.evil.example", subject),
    ).toBe(false);
    expect(isGmailForwardingConfirmation("alice@example.net", subject)).toBe(false);
    expect(isGmailForwardingConfirmation("forwarding-noreply@google.com", "Hello")).toBe(false);
  });

  it("reads the code and a Google link, and ignores links to other hosts", () => {
    const body = [
      "Confirmation code: 123456789",
      "https://evil.example/phish?x=google.com",
      "https://mail-settings.google.com/mail/vf-abc",
    ].join("\n");
    expect(readGmailConfirmation(body)).toEqual({
      code: "123456789",
      link: "https://mail-settings.google.com/mail/vf-abc",
    });
    expect(readGmailConfirmation("nothing useful")).toEqual({});
  });
});
