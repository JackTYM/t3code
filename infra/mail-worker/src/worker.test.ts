import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import worker from "./worker.ts";
import * as fixtures from "./testFixtures.ts";

const env = {
  BOX_URL: "https://box.example/mail",
  WEBHOOK_SECRET: "s3cret",
  MAILBOXES: "me@gmail.com",
};

function incoming(raw: Uint8Array<ArrayBuffer>) {
  return {
    from: "bounce@example.net",
    to: "routing@mail.example.com",
    raw: new Response(raw).body!,
    rawSize: raw.length,
    headers: new Headers(),
    setReject: vi.fn(),
    forward: vi.fn(),
    reply: vi.fn(),
  } as unknown as ForwardableEmailMessage;
}

function run(message: ForwardableEmailMessage, overrides: Partial<typeof env> = {}) {
  return worker.email!(message, { ...env, ...overrides });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("email handler", () => {
  it("posts a signed BotMailMessage to the box and logs only the outcome", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const message = incoming(fixtures.gmailForwarded);
    await run(message);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://box.example/mail");
    expect((init.headers as Record<string, string>)["x-t3-signature"]).toMatch(
      /^sha256=[0-9a-f]{64}$/,
    );
    expect(JSON.parse(new TextDecoder().decode(init.body as Uint8Array))).toMatchObject({
      messageId: "gmail-1@example.net",
      mailbox: "me@gmail.com",
    });
    expect(message.setReject).not.toHaveBeenCalled();
    expect(message.forward).not.toHaveBeenCalled();

    const logged = log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(JSON.parse(logged)).toEqual({
      event: "mail.delivered",
      messageId: "gmail-1@example.net",
      status: 200,
      attempts: 1,
    });
    expect(logged).not.toContain("Forwarded by Gmail");
  });

  it("keeps Gmail's confirmation mail off the box and logs its code and link", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await run(incoming(fixtures.gmailConfirmation));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      event: "gmail.forwarding_confirmation",
      code: "123456789",
      link: "https://mail-settings.google.com/mail/vf-%5BANGjdJ-fake%5D-abc123",
    });
  });

  it("treats a confirmation that fails DMARC as ordinary mail", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await run(
      incoming(
        fixtures.gmailConfirmationWith(
          "Authentication-Results: mx.cloudflare.net; spf=fail; dkim=none; dmarc=fail",
        ),
      ),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("drops the message after the retries without throwing or rejecting it", async () => {
    // Backoff sleeps resolve at once; fake timers would also stall the stream reads.
    vi.stubGlobal("setTimeout", (callback: () => void) => {
      callback();
      return 0;
    });
    const fetchMock = vi.fn(async () => new Response(null, { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const message = incoming(fixtures.icloudForwarded);

    await run(message);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(message.setReject).not.toHaveBeenCalled();
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({
      event: "mail.dropped",
      messageId: "icloud-1@example.net",
      status: 500,
      attempts: 4,
    });
  });

  it("logs and returns when the bindings are missing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await run(incoming(fixtures.icloudForwarded), { WEBHOOK_SECRET: "" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.parse(String(log.mock.calls[0]?.[0])).event).toBe("mail.not_configured");
  });
});
