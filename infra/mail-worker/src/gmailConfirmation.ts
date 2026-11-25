// Gmail sends this to the forwarding destination when an account turns forwarding on; the user
// must click the link or paste the code into Gmail once per account. The sender and subject are
// documented in practice, but the body layout is not published, so the code and link are read
// leniently and the guide tells the operator to fall back to the raw message.
const GMAIL_CONFIRMATION_SENDER = "forwarding-noreply@google.com";

export function isGmailForwardingConfirmation(from: string, subject: string): boolean {
  return (
    from.trim().toLowerCase() === GMAIL_CONFIRMATION_SENDER &&
    subject.toLowerCase().includes("forwarding confirmation")
  );
}

/** The confirmation code and any Google link in the body, for the operator's `wrangler tail`. */
export function readGmailConfirmation(bodyText: string): { code?: string; link?: string } {
  const code = /confirmation code\D{0,40}(\d{6,12})/i.exec(bodyText)?.[1];
  // Only a link on Google's own host is logged; the body is sender text.
  const link = bodyText.match(/https:\/\/[^\s<>"')]+/g)?.find((candidate) => {
    try {
      const host = new URL(candidate).hostname;
      return host === "google.com" || host.endsWith(".google.com");
    } catch {
      return false;
    }
  });
  return { ...(code ? { code } : {}), ...(link ? { link } : {}) };
}
