import {
  BOT_SECRET_GRANT_MAX_HOSTS,
  BOT_SECRET_GRANT_MIN_VALUE_LENGTH,
  BotSecretGrantHost,
  BotSecretGrantName,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, SecretReference, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isGrantName = Schema.is(BotSecretGrantName);
const isGrantHost = Schema.is(BotSecretGrantHost);

/** Hosts are case-insensitive, and the contract only takes them in lower case. */
function parseGrantHosts(text: string): ReadonlyArray<string> {
  return [
    ...new Set(
      text
        .split(/[\s,]+/u)
        .map((host) => host.toLowerCase())
        .filter((host) => host !== ""),
    ),
  ];
}

export type BotSecretGrantDraftResult =
  | { readonly ok: true; readonly name: string; readonly hosts: ReadonlyArray<string> }
  | {
      readonly ok: false;
      readonly issue: "name" | "hosts_required" | "hosts_too_many" | "host";
      /** The first host that is not a plain host name. */
      readonly host?: string;
    };

/** The same checks the server makes, so a typo shows before anything is sent. */
export function validateBotSecretGrantDraft(draft: {
  readonly name: string;
  readonly hostsText: string;
}): BotSecretGrantDraftResult {
  const name = draft.name.trim();
  if (!isGrantName(name)) return { ok: false, issue: "name" };
  const hosts = parseGrantHosts(draft.hostsText);
  if (hosts.length === 0) return { ok: false, issue: "hosts_required" };
  const badHost = hosts.find((host) => !isGrantHost(host));
  if (badHost !== undefined) return { ok: false, issue: "host", host: badHost };
  if (hosts.length > BOT_SECRET_GRANT_MAX_HOSTS) return { ok: false, issue: "hosts_too_many" };
  return { ok: true, name, hosts };
}

interface BotGrantTarget {
  readonly threadId: ThreadId;
  /** Null for Home when its thread has no shell to take a title from. */
  readonly title: string | null;
  readonly isHome: boolean;
}

/** The Bots whose grants this environment holds: Home first when it is on, then the others by title. */
export function botGrantTargets(
  shells: ReadonlyArray<
    Pick<EnvironmentThreadShell, "environmentId" | "id" | "title" | "botConfig" | "archivedAt">
  >,
  environmentId: EnvironmentId,
  homeThreadId: ThreadId | null,
): ReadonlyArray<BotGrantTarget> {
  const inEnvironment = shells.filter((shell) => shell.environmentId === environmentId);
  const home: ReadonlyArray<BotGrantTarget> =
    homeThreadId === null
      ? []
      : [
          {
            threadId: homeThreadId,
            title: inEnvironment.find((shell) => shell.id === homeThreadId)?.title ?? null,
            isHome: true,
          },
        ];
  const others = inEnvironment
    .filter(
      (shell) => shell.id !== homeThreadId && shell.botConfig != null && shell.archivedAt === null,
    )
    .map((shell) => ({ threadId: shell.id, title: shell.title, isHome: false }))
    .toSorted((a, b) => a.title.localeCompare(b.title));
  return [...home, ...others];
}

/** Saving a name the Bot already has replaces that grant's value and hosts. */
export const replacesBotSecretGrant = (name: string, existing: ReadonlyArray<{ name: string }>) =>
  existing.some((grant) => grant.name === name.trim());

/**
 * Whether saving carries a value. Editing the hosts of a grant keeps its stored value or
 * reference as it is, unless the user chooses to give a new one.
 */
export const botSecretGrantSaveCarriesValue = (
  mode: "add" | "hosts" | "value",
  keepCurrentValue: boolean,
) => mode !== "hosts" || !keepCurrentValue;

export type BotSecretGrantValueIssue = "empty" | "too_short" | "reference_required";

/**
 * What stops a value from being saved. A reference grant stays a reference: its provider text is
 * not shown, so a typed value would silently turn it into a stored one.
 */
export function botSecretGrantValueIssue(
  value: string | SecretReference,
  grantIsReference: boolean,
): BotSecretGrantValueIssue | null {
  if (typeof value !== "string") return null;
  if (grantIsReference) return "reference_required";
  const length = value.trim().length;
  if (length === 0) return "empty";
  return length < BOT_SECRET_GRANT_MIN_VALUE_LENGTH ? "too_short" : null;
}

/**
 * The Bot the grants screen shows. Asking for a Bot this environment does not list is its own
 * outcome, so the screen never shows another Bot's grants in its place.
 */
export function resolveBotGrantTarget<T extends { readonly threadId: ThreadId }>(
  targets: ReadonlyArray<T>,
  requested: ThreadId | null,
):
  | { readonly kind: "found"; readonly target: T }
  | { readonly kind: "missing" }
  | { readonly kind: "none" } {
  if (requested === null) {
    const first = targets[0];
    return first === undefined ? { kind: "none" } : { kind: "found", target: first };
  }
  const target = targets.find((candidate) => candidate.threadId === requested);
  return target === undefined ? { kind: "missing" } : { kind: "found", target };
}
