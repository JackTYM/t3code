const ADDRESS = /[^\s<>,;:"'()[\]]+@[^\s<>,;:"'()[\]]+/g;

function addressesIn(value: string): string[] {
  return (value.match(ADDRESS) ?? []).map((address) => address.replace(/\.+$/, "").toLowerCase());
}

/**
 * Gmail delivers `me.name+shop@gmail.com` to `mename@gmail.com`, so those are one mailbox. Other
 * providers treat dots and tags as meaningful, so only Gmail's two domains are folded.
 */
function mailboxKey(address: string): string {
  const at = address.lastIndexOf("@");
  const domain = address.slice(at + 1);
  if (domain !== "gmail.com" && domain !== "googlemail.com") return address;
  return `${address.slice(0, at).split("+")[0]!.replaceAll(".", "")}@gmail.com`;
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
 * Picks the user's address the message was originally sent to. Matching is lower-cased and exact,
 * except that Gmail's dots, `+tags` and googlemail.com fold together. The result is the spelling
 * from `MAILBOXES`, so one account is always one mailbox. Falls back to the first To address (the
 * box drops unknown mailboxes), then the envelope recipient, never to empty.
 */
export function chooseMailbox(input: {
  headers: ReadonlyArray<{ key: string; value: string }>;
  allowlist: string;
  envelopeTo: string;
}): string {
  const allowed = new Map<string, string>();
  for (const entry of input.allowlist.split(",")) {
    const address = entry.trim().toLowerCase();
    if (address !== "" && !allowed.has(mailboxKey(address)))
      allowed.set(mailboxKey(address), address);
  }

  if (allowed.size > 0) {
    for (const name of RECIPIENT_HEADERS) {
      for (const header of input.headers) {
        if (header.key !== name) continue;
        for (const address of addressesIn(header.value)) {
          const listed = allowed.get(mailboxKey(address));
          if (listed !== undefined) return listed;
        }
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
