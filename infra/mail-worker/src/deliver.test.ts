import { describe, expect, it } from "vite-plus/test";

import { deliverToBox, signBody } from "./deliver.ts";

const encoder = new TextEncoder();
const sleeps: number[] = [];
const noSleep = async (ms: number) => {
  sleeps.push(ms);
};

describe("signBody", () => {
  it("matches the published HMAC-SHA256 test vector", async () => {
    expect(
      await signBody("key", encoder.encode("The quick brown fox jumps over the lazy dog")),
    ).toBe("sha256=f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8");
  });

  it("matches RFC 4231 test case 2", async () => {
    expect(await signBody("Jefe", encoder.encode("what do ya want for nothing?"))).toBe(
      "sha256=5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
  });
});

describe("deliverToBox", () => {
  it("signs the exact bytes it sends", async () => {
    let seen: RequestInit | undefined;
    const result = await deliverToBox({
      url: "https://box.example/mail",
      secret: "s3cret",
      payload: { subject: "héllo ✓" },
      fetch: async (_url, init) => {
        seen = init;
        return new Response(null, { status: 204 });
      },
      sleep: noSleep,
    });
    expect(result).toEqual({ ok: true, status: 204, attempts: 1 });
    const body = seen?.body as Uint8Array<ArrayBuffer>;
    expect(new TextDecoder().decode(body)).toBe('{"subject":"héllo ✓"}');
    const headers = seen?.headers as Record<string, string>;
    expect(headers["x-t3-signature"]).toBe(await signBody("s3cret", body));
  });

  it("retries a non-2xx or a network error with backoff, then succeeds", async () => {
    sleeps.length = 0;
    const outcomes: Array<Response | "network"> = [
      new Response(null, { status: 502 }),
      "network",
      new Response(null, { status: 200 }),
    ];
    const result = await deliverToBox({
      url: "https://box.example/mail",
      secret: "s",
      payload: {},
      fetch: async () => {
        const next = outcomes.shift()!;
        if (next === "network") throw new TypeError("boom");
        return next;
      },
      sleep: noSleep,
    });
    expect(result).toEqual({ ok: true, status: 200, attempts: 3 });
    expect(sleeps).toEqual([1_000, 4_000]);
  });

  it("gives up after the last attempt and reports the last status", async () => {
    let calls = 0;
    const result = await deliverToBox({
      url: "https://box.example/mail",
      secret: "s",
      payload: {},
      fetch: async () => {
        calls += 1;
        return new Response(null, { status: 401 });
      },
      sleep: noSleep,
    });
    expect(result).toEqual({ ok: false, status: 401, attempts: 4 });
    expect(calls).toBe(4);
  });

  it("reports no status when every attempt failed without a response", async () => {
    const result = await deliverToBox({
      url: "https://box.example/mail",
      secret: "s",
      payload: {},
      fetch: async () => {
        throw new TypeError("offline");
      },
      sleep: noSleep,
    });
    expect(result).toEqual({ ok: false, status: undefined, attempts: 4 });
  });
});
