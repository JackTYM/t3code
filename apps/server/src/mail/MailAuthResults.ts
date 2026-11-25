import type { BotMailAuth, BotMailAuthVerdict } from "@t3tools/contracts";

import { stripCommentsAndQuotes, type MailHeader } from "./MailMessageParser.ts";

/**
 * Who received the mail, which decides whose `Authentication-Results` can be believed. Only the
 * receiving provider's own server vouches for a verdict; a sender can write any header it likes.
 */
export type MailProvider = "google" | "icloud" | "other";

// The authserv-id each provider writes at the front of the header it adds on receipt. Google's is
// the `mx.google.com` its Gmail headers show. iCloud's, `bimi.icloud.com`, was read off real
// iCloud messages; no public source states it. Providers are not interchangeable: a Google id on
// an iCloud account is a header some sender wrote.
const TRUSTED_AUTHSERV_IDS: Readonly<Record<MailProvider, ReadonlySet<string>>> = {
  google: new Set(["mx.google.com"]),
  icloud: new Set(["bimi.icloud.com"]),
  other: new Set(),
};

const ICLOUD_DOMAINS: ReadonlySet<string> = new Set(["icloud.com", "me.com", "mac.com"]);

/**
 * Which provider received an account's mail. Gmail is known by its folder layout. iCloud is known
 * by the account's own address, since Mail's folder names for it are the same as for any other
 * IMAP server. An iCloud account on a custom domain or a Hide My Email alias is not recognised,
 * which only costs it a verdict: unknown means `other`, and `other` trusts no header.
 */
export function providerOfAccount(account: {
  readonly hasGmailFolder: boolean;
  readonly addresses: ReadonlyArray<string>;
}): MailProvider {
  if (account.hasGmailFolder) return "google";
  return account.addresses.some((address) =>
    ICLOUD_DOMAINS.has(address.slice(address.lastIndexOf("@") + 1).toLowerCase()),
  )
    ? "icloud"
    : "other";
}

const NONE: BotMailAuth = { dkim: "none", spf: "none", dmarc: "none", source: "mail-app" };

// Only a clear pass is a pass. Anything the server could not decide on is no verdict, never fail.
const verdictOf = (result: string): BotMailAuthVerdict =>
  result === "pass" ? "pass" : result === "fail" || result === "softfail" ? "fail" : "none";

/**
 * The receiving provider's verdicts. Mail servers add their `Authentication-Results` above
 * everything that was already in the message, so the sender's own forged ones sit below the
 * real one. Only the topmost such header is read, and only when its authserv-id is the
 * provider's: if it names anyone else, nothing is looked for further down.
 */
export function receiverAuth(
  headers: ReadonlyArray<MailHeader>,
  provider: MailProvider,
): BotMailAuth {
  const header = headers.find((candidate) => candidate.name === "authentication-results");
  if (header === undefined) return NONE;
  const [authserv, ...results] = stripCommentsAndQuotes(header.value).split(";");
  const id = (authserv ?? "").trim().split(/\s+/u)[0]?.toLowerCase().replace(/\.$/u, "") ?? "";
  if (!TRUSTED_AUTHSERV_IDS[provider].has(id)) return NONE;

  const byMethod = new Map<string, Array<BotMailAuthVerdict>>();
  for (const result of results) {
    const match = /^\s*([a-z][a-z0-9-]*)(?:\/\d+)?\s*=\s*([a-z]+)/iu.exec(result);
    if (match === null) continue;
    const method = match[1]!.toLowerCase();
    byMethod.set(method, [...(byMethod.get(method) ?? []), verdictOf(match[2]!.toLowerCase())]);
  }
  const verdicts = (method: string) => byMethod.get(method) ?? [];
  // A message can carry several DKIM signatures and one good one is enough; SPF and DMARC are
  // one verdict each, so a repeat later in the header is not read.
  const dkim = verdicts("dkim");
  return {
    dkim: dkim.includes("pass") ? "pass" : (dkim.find((v) => v === "fail") ?? "none"),
    spf: verdicts("spf")[0] ?? "none",
    dmarc: verdicts("dmarc")[0] ?? "none",
    source: "mail-app",
  };
}
