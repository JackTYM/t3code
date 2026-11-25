import {
  BOT_MAIL_MAX_DIGEST_WINDOW_MINUTES,
  BOT_MAIL_MAX_MAILBOXES,
  BOT_MAIL_MAX_RETENTION_DAYS,
  isUnknownAccountMailbox,
  type BotMailBackfillStatus,
  type BotMailStatus,
  type EnvironmentId,
} from "@t3tools/contracts";

/** What the user can pick for a history import; the server accepts 1 to 90. */
export const BOT_MAIL_BACKFILL_DAYS = [30, 60, 90] as const;
export type BotMailBackfillDays = (typeof BOT_MAIL_BACKFILL_DAYS)[number];

/** Same shape the server enforces on every mailbox, so a save is not refused for it. */
const MAILBOX_PATTERN = /^[^\s@<>]+@[^\s@<>]+$/u;
const MAILBOX_MAX_CHARS = 320;

export type BotMailMailboxProblem = "empty" | "invalid" | "too_long" | "duplicate" | "too_many";

type BotMailMailboxParse =
  | { readonly ok: true; readonly address: string }
  | { readonly ok: false; readonly problem: BotMailMailboxProblem };

/** An address as the server stores it (trimmed, lower-cased), or why it cannot join `current`. */
export function parseBotMailMailbox(
  raw: string,
  current: ReadonlyArray<string>,
): BotMailMailboxParse {
  const address = raw.trim().toLowerCase();
  if (address.length === 0) return { ok: false, problem: "empty" };
  if (address.length > MAILBOX_MAX_CHARS) return { ok: false, problem: "too_long" };
  if (!MAILBOX_PATTERN.test(address)) return { ok: false, problem: "invalid" };
  if (current.includes(address)) return { ok: false, problem: "duplicate" };
  if (current.length >= BOT_MAIL_MAX_MAILBOXES) return { ok: false, problem: "too_many" };
  return { ok: true, address };
}

/** A whole number from 1 to `max`, written plainly; anything else is not a setting. */
export function parseBotMailWholeNumber(text: string, max: number): number | null {
  if (!/^\d{1,7}$/u.test(text.trim())) return null;
  const value = Number(text.trim());
  return value >= 1 && value <= max ? value : null;
}

/** What the user has changed so far; `null` follows what the server has. */
export type BotMailSettingsDraft = {
  readonly mailboxes: ReadonlyArray<string> | null;
  readonly retention: string | null;
  readonly digest: string | null;
};

export const EMPTY_BOT_MAIL_SETTINGS_DRAFT: BotMailSettingsDraft = {
  mailboxes: null,
  retention: null,
  digest: null,
};

type BotMailSettingsPlan = {
  readonly mailboxes: ReadonlyArray<string>;
  readonly retentionText: string;
  readonly digestText: string;
  readonly retentionValid: boolean;
  readonly digestValid: boolean;
  readonly changed: boolean;
  /** The request that saves the draft, once it is valid and differs from the server. */
  readonly save:
    | {
        readonly mailboxes: ReadonlyArray<string>;
        readonly retentionDays: number;
        readonly digestWindowMinutes: number;
      }
    | undefined;
};

const sameAddresses = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  a.length === b.length && a.every((address) => b.includes(address));

export function botMailSettingsPlan(
  server: Pick<BotMailStatus, "mailboxes" | "retentionDays" | "digestWindowMinutes">,
  draft: BotMailSettingsDraft,
): BotMailSettingsPlan {
  const mailboxes = draft.mailboxes ?? server.mailboxes;
  const retentionText = draft.retention ?? String(server.retentionDays);
  const digestText = draft.digest ?? String(server.digestWindowMinutes);
  const retentionDays = parseBotMailWholeNumber(retentionText, BOT_MAIL_MAX_RETENTION_DAYS);
  const digestWindowMinutes = parseBotMailWholeNumber(
    digestText,
    BOT_MAIL_MAX_DIGEST_WINDOW_MINUTES,
  );
  const changed =
    !sameAddresses(mailboxes, server.mailboxes) ||
    retentionDays !== server.retentionDays ||
    digestWindowMinutes !== server.digestWindowMinutes;
  return {
    mailboxes,
    retentionText,
    digestText,
    retentionValid: retentionDays !== null,
    digestValid: digestWindowMinutes !== null,
    changed,
    save:
      changed && retentionDays !== null && digestWindowMinutes !== null
        ? { mailboxes, retentionDays, digestWindowMinutes }
        : undefined,
  };
}

type BotMailCountRow = {
  readonly mailbox: string;
  readonly forward: number;
  readonly backfill: number;
  /** Mail kept for an address that is no longer on the list stays until it ages out. */
  readonly listed: boolean;
};

/** The listed mailboxes first, each with what is kept for it, then any other address with mail. */
export function botMailCountRows(
  status: Pick<BotMailStatus, "mailboxes" | "counts">,
): ReadonlyArray<BotMailCountRow> {
  const rows = new Map<string, { forward: number; backfill: number }>();
  for (const mailbox of status.mailboxes) rows.set(mailbox, { forward: 0, backfill: 0 });
  for (const { mailbox, origin, count } of status.counts) {
    const row = rows.get(mailbox) ?? { forward: 0, backfill: 0 };
    row[origin] += count;
    rows.set(mailbox, row);
  }
  return [...rows]
    .map(([mailbox, counts]) => ({
      mailbox,
      ...counts,
      listed: status.mailboxes.includes(mailbox),
    }))
    .toSorted((a, b) =>
      a.listed === b.listed ? a.mailbox.localeCompare(b.mailbox) : a.listed ? -1 : 1,
    );
}

/** What is kept (bulk included), how much of it is bulk, and what was dropped for an unlisted mailbox. */
export function botMailTotals(status: Pick<BotMailStatus, "counts" | "bulk" | "dropped">) {
  return {
    stored: status.counts.reduce((sum, { count }) => sum + count, 0),
    bulk: status.bulk ?? 0,
    dropped: status.dropped?.count ?? 0,
  };
}

/** Recently dropped mailboxes the user can still allow, newest first. */
export function botMailDroppedMailboxes(
  status: Pick<BotMailStatus, "mailboxes" | "dropped">,
): ReadonlyArray<{ readonly mailbox: string; readonly count: number }> {
  return (status.dropped?.mailboxes ?? []).filter(
    ({ mailbox }) => !status.mailboxes.includes(mailbox),
  );
}

/** Placeholder accounts the import saw, minus any the user has already allowed. */
export function botMailUnknownAccounts(
  status: Pick<BotMailStatus, "mailboxes" | "unknownAccounts">,
): ReadonlyArray<{ readonly mailbox: string; readonly seen: number }> {
  return (status.unknownAccounts ?? [])
    .filter(
      ({ mailbox }) =>
        isUnknownAccountMailbox(mailbox) && !status.mailboxes.includes(mailbox.toLowerCase()),
    )
    .map(({ mailbox, seen }) => ({ mailbox: mailbox.toLowerCase(), seen }));
}

type BotMailControl =
  | { readonly enabled: true }
  | { readonly enabled: false; readonly reason: BotMailBlock };

export type BotMailBlock =
  | "needs_operate_access"
  | "hook_exists"
  | "no_hook"
  | "no_linked_environment"
  | "import_running"
  | "nothing_to_save";

const allowed: BotMailControl = { enabled: true };
const blocked = (reason: BotMailBlock): BotMailControl => ({ enabled: false, reason });

type Hook = NonNullable<BotMailStatus["hook"]>;

type BotMailHookControls = {
  readonly create: BotMailControl;
  readonly rotate: BotMailControl;
};

/** Every mail command needs operate access; creating needs no hook yet and rotating one. */
export function botMailHookControls(
  hook: Hook | undefined,
  grants: { readonly operate: boolean },
): BotMailHookControls {
  if (!grants.operate) {
    return { create: blocked("needs_operate_access"), rotate: blocked("needs_operate_access") };
  }
  return {
    create: hook === undefined ? allowed : blocked("hook_exists"),
    rotate: hook === undefined ? blocked("no_hook") : allowed,
  };
}

export function botMailSaveControl(
  plan: BotMailSettingsPlan,
  grants: { readonly operate: boolean },
): BotMailControl {
  if (!grants.operate) return blocked("needs_operate_access");
  return plan.save === undefined ? blocked("nothing_to_save") : allowed;
}

type BotMailHookProblem = "disabled" | "unsigned" | "signature_rejected";

/** What is wrong with a hook that exists, most serious first, or `null` when nothing is. */
export function botMailHookProblem(hook: Hook): BotMailHookProblem | null {
  if (!hook.enabled) return "disabled";
  if (!hook.signed) return "unsigned";
  if (hook.lastOutcome === "rejected_signature") return "signature_rejected";
  return null;
}

type BotMailDeliveryOutcome = {
  readonly kind:
    | "accepted"
    | "rejected_signature"
    | "dispatch_failed"
    | "rate_limited"
    | "disabled"
    | "expired"
    | "other";
  /** The server's own word, shown for an outcome this client has no sentence for. */
  readonly raw: string;
  readonly tone: "good" | "bad" | "neutral";
};

export function botMailDeliveryOutcome(outcome: string): BotMailDeliveryOutcome {
  switch (outcome) {
    case "accepted":
      return { kind: "accepted", raw: outcome, tone: "good" };
    case "rejected_signature":
    case "dispatch_failed":
    case "rate_limited":
    case "disabled":
    case "expired":
      return { kind: outcome, raw: outcome, tone: "bad" };
    default:
      return { kind: "other", raw: outcome.replaceAll("_", " "), tone: "neutral" };
  }
}

/** The machine an import runs on: the one asked for, else the last one used, else the first. */
export function botMailImportTarget(
  linked: ReadonlyMap<EnvironmentId, string>,
  picked: EnvironmentId | null,
  previous: EnvironmentId | undefined,
): EnvironmentId | null {
  if (picked !== null && linked.has(picked)) return picked;
  if (previous !== undefined && linked.has(previous)) return previous;
  return linked.keys().next().value ?? null;
}

export function botMailImportDays(
  picked: BotMailBackfillDays | null,
  previous: number | undefined,
): BotMailBackfillDays {
  if (picked !== null) return picked;
  return BOT_MAIL_BACKFILL_DAYS.find((days) => days === previous) ?? BOT_MAIL_BACKFILL_DAYS[0];
}

/**
 * `resume` mirrors the server's rule: the same machine and window as an unfinished pull picks up
 * where it stopped; anything else starts over, which is safe because stored mail is deduped.
 */
export function botMailImportKind(
  backfill: BotMailBackfillStatus | undefined,
  environmentId: EnvironmentId | null,
  days: number,
): "import" | "resume" | "again" {
  if (backfill === undefined) return "import";
  if (backfill.state === "done") return "again";
  return backfill.environmentId === environmentId && backfill.sinceDays === days
    ? "resume"
    : "import";
}

export function botMailImportControl(input: {
  readonly backfill: BotMailBackfillStatus | undefined;
  readonly environmentId: EnvironmentId | null;
  readonly grants: { readonly operate: boolean };
}): BotMailControl {
  if (!input.grants.operate) return blocked("needs_operate_access");
  if (input.environmentId === null) return blocked("no_linked_environment");
  return input.backfill?.state === "running" ? blocked("import_running") : allowed;
}
