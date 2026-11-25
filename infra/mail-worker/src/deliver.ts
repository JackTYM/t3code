const encoder = new TextEncoder();

/** `sha256=<lowercase hex HMAC-SHA256 of the body bytes>`, the `x-t3-signature` header value. */
export async function signBody(secret: string, body: Uint8Array<ArrayBuffer>): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, body));
  return `sha256=${Array.from(mac, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

const RETRY_DELAYS_MS = [1_000, 4_000, 15_000];

/**
 * POSTs one message to the box and retries with backoff on any non-2xx or network error.
 * Mail is never bounced to the sender, so after the last attempt the caller logs and drops it.
 * Returns the last HTTP status, or undefined when the last attempt never got a response.
 */
export async function deliverToBox(input: {
  url: string;
  secret: string;
  payload: unknown;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{ ok: boolean; status: number | undefined; attempts: number }> {
  const send = input.fetch ?? fetch;
  const sleep = input.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  // Sign and send the same bytes: re-serializing could change them between signing and sending.
  const body = encoder.encode(JSON.stringify(input.payload));
  const signature = await signBody(input.secret, body);

  let status: number | undefined;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]!);
    try {
      const response = await send(input.url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-t3-signature": signature },
        body,
      });
      status = response.status;
      await response.body?.cancel();
      if (response.ok) return { ok: true, status, attempts: attempt + 1 };
    } catch {
      status = undefined;
    }
  }
  return { ok: false, status, attempts: RETRY_DELAYS_MS.length + 1 };
}
