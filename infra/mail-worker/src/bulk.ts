// Mirrors `isBulkMail` in apps/server/src/mail/MailMessageParser.ts, which the Mac Mail backfill
// uses; keep the two rules identical. The Worker is a separate bundle and cannot import it.

/**
 * Local parts that are only ever machines or marketing. Deliberately short: a real person's mail
 * marked bulk would never wake the Bot, so anything a human might use as a name is left out.
 * `mailer-daemon` is automated but not bulk, and stays out too.
 */
const BULK_SENDER =
  /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|newsletters?|marketing|notifications?)$/;

/**
 * Whether a message is marketing or automated mail, from the sender's own headers: a list
 * unsubscribe or list id, `Precedence: bulk|list|junk`, `Auto-Submitted` other than `no`, or an
 * obvious no-reply sender. The sender writes all of these, so this sorts mail, it does not vouch
 * for it: a bulk message is still stored and searchable, it just never wakes the Bot.
 */
export function isBulkMail(
  headers: ReadonlyArray<{ key: string; value: string }>,
  fromAddress: string,
): boolean {
  for (const header of headers) {
    const value = header.value.trim();
    switch (header.key) {
      case "list-unsubscribe":
      case "list-id":
        if (value !== "") return true;
        break;
      case "precedence":
        if (/^(?:bulk|list|junk)$/i.test(value)) return true;
        break;
      case "auto-submitted": {
        const kind = value.split(/[\s;]/)[0]!.toLowerCase();
        if (kind !== "" && kind !== "no") return true;
        break;
      }
    }
  }
  const at = fromAddress.lastIndexOf("@");
  if (at <= 0) return false;
  return BULK_SENDER.test(fromAddress.slice(0, at).split("+")[0]!.toLowerCase());
}
