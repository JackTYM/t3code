import type { BotMailAuth, BotMailAuthVerdict } from "@t3tools/contracts";

// Cloudflare documents that Email Routing prepends its own Authentication-Results header with
// this authserv-id, and that any other Authentication-Results header may have been supplied by
// the sender. https://developers.cloudflare.com/email-service/api/route-emails/email-handler/#authentication-results
const CLOUDFLARE_AUTHSERV_ID = "mx.cloudflare.net";

const NONE: BotMailAuth = { dkim: "none", spf: "none", dmarc: "none", source: "cloudflare" };

function stripComments(value: string): string {
  let depth = 0;
  let out = "";
  for (const char of value) {
    if (char === "(") depth += 1;
    else if (char === ")" && depth > 0) depth -= 1;
    else if (depth === 0) out += char;
  }
  return out;
}

// `none`/`neutral` and the error results (temperror, permerror, policy) assert nothing, so they
// stay `none` rather than becoming a failure. RFC 8601 spells out the result names.
function toVerdict(result: string): BotMailAuthVerdict {
  switch (result.toLowerCase()) {
    case "pass":
      return "pass";
    case "fail":
    case "softfail":
      return "fail";
    default:
      return "none";
  }
}

// One mechanism can report several results (a message may carry several DKIM signatures). Any
// pass counts, as in DMARC; otherwise any fail counts.
function merge(verdicts: BotMailAuthVerdict[]): BotMailAuthVerdict {
  if (verdicts.includes("pass")) return "pass";
  if (verdicts.includes("fail")) return "fail";
  return "none";
}

/**
 * Reads Cloudflare's verdicts from headers in document order, duplicates kept. Only the topmost
 * Authentication-Results counts: Cloudflare prepends its own, and a sender can write any
 * authserv-id lower down, `mx.cloudflare.net` included. If the top one is not Cloudflare's,
 * every verdict is `none`. DMARC is read from the header, never computed.
 */
export function readCloudflareAuth(
  headers: ReadonlyArray<{ key: string; value: string }>,
): BotMailAuth {
  const top = headers.find((header) => header.key === "authentication-results");
  if (!top) return NONE;

  const [idPart, ...results] = stripComments(top.value).split(";");
  const authservId = idPart?.trim().split(/\s+/)[0]?.toLowerCase().replace(/\.$/, "");
  if (authservId !== CLOUDFLARE_AUTHSERV_ID) return NONE;

  const byMethod: Record<"dkim" | "spf" | "dmarc", BotMailAuthVerdict[]> = {
    dkim: [],
    spf: [],
    dmarc: [],
  };
  for (const part of results) {
    const match = /^\s*(dkim|spf|dmarc)\s*=\s*([a-z]+)/i.exec(part);
    if (match?.[1] && match[2]) {
      byMethod[match[1].toLowerCase() as "dkim" | "spf" | "dmarc"].push(toVerdict(match[2]));
    }
  }
  return {
    dkim: merge(byMethod.dkim),
    spf: merge(byMethod.spf),
    dmarc: merge(byMethod.dmarc),
    source: "cloudflare",
  };
}
