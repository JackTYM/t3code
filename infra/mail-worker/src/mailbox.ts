const ADDRESS = /[^\s<>,;:"'()[\]]+@[^\s<>,;:"'()[\]]+/g;

function addressesIn(value: string): string[] {
  return (value.match(ADDRESS) ?? []).map((address) => address.replace(/\.+$/, "").toLowerCase());
}

/**
 * Headers that can name the original recipient of forwarded mail, best first. Gmail lists it
 * first in `X-Forwarded-For`. The sender can write all of them, so only an address on the
 * user's `MAILBOXES` list is accepted from them.
 */
const RECIPIENT_HEADERS = [
  "delivered-to",
  "x-original-to",
  "x-forwarded-for",
  "x-forwarded-to",
  "to",
  "cc",
];

/**
 * Picks the user's address the message was originally sent to. Matching is exact and
 * lower-cased: Gmail dots and `+tags` are different addresses here. Falls back to the first To
 * address (the box drops unknown mailboxes), then the envelope recipient, never to empty.
 */
export function chooseMailbox(input: {
  headers: ReadonlyArray<{ key: string; value: string }>;
  allowlist: string;
  envelopeTo: string;
}): string {
  const allowed = new Set(
    input.allowlist
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );

  if (allowed.size > 0) {
    for (const name of RECIPIENT_HEADERS) {
      for (const header of input.headers) {
        if (header.key !== name) continue;
        const match = addressesIn(header.value).find((address) => allowed.has(address));
        if (match) return match;
      }
    }
  }

  const firstTo = input.headers.find((header) => header.key === "to");
  return (
    (firstTo ? addressesIn(firstTo.value)[0] : undefined) ??
    addressesIn(input.envelopeTo)[0] ??
    (input.envelopeTo.trim().toLowerCase() || "unknown")
  );
}
