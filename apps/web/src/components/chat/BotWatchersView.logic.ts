import type { BotWatcher, BotWatcherRunsOn, EnvironmentId } from "@t3tools/contracts";

/** What the badge says. `changed` is a needs-approval watcher that ran an older version. */
export type BotWatcherState =
  | "new"
  | "changed"
  | "invalid"
  | "paused"
  | "waiting"
  | "failing"
  | "running";

export function botWatcherState(watcher: BotWatcher): BotWatcherState {
  switch (watcher.status) {
    case "needs_approval":
      return watcher.approvedHash === undefined ? "new" : "changed";
    case "invalid":
      return "invalid";
    case "paused":
      return "paused";
    case "waiting":
      return "waiting";
    case "tripped":
      return "failing";
    case "healthy":
      return "running";
  }
}

export type BotWatcherGroup = "attention" | "running" | "paused";

const GROUP_OF = {
  new: "attention",
  changed: "attention",
  invalid: "attention",
  failing: "attention",
  waiting: "running",
  running: "running",
  paused: "paused",
} as const satisfies Record<BotWatcherState, BotWatcherGroup>;

/**
 * What needs the user first, then what runs, then what they stopped. A paused watcher with a
 * newer version waiting still needs them, so it sorts with the first group.
 */
export function groupBotWatchers(
  watchers: ReadonlyArray<BotWatcher>,
): ReadonlyArray<{ group: BotWatcherGroup; watchers: ReadonlyArray<BotWatcher> }> {
  const groups: ReadonlyArray<BotWatcherGroup> = ["attention", "running", "paused"];
  return groups
    .map((group) => ({
      group,
      watchers: watchers
        .filter((watcher) => GROUP_OF[botWatcherState(watcher)] === group)
        .toSorted((a, b) => a.name.localeCompare(b.name)),
    }))
    .filter((entry) => entry.watchers.length > 0);
}

/** The version `watcher.lastDryRun` describes, when it is the one on show. */
export const botWatcherDryRunOf = (watcher: BotWatcher) =>
  watcher.lastDryRun?.hash === watcher.hash ? watcher.lastDryRun : undefined;

/** Mirrors the server's rule: the dry run must be of exactly this version, where it will run. */
const botWatcherDryRunHolds = (watcher: BotWatcher, hash: string, runsOn: BotWatcherRunsOn) =>
  watcher.lastDryRun?.hash === hash && (watcher.lastDryRun.runsOn ?? "local") === runsOn;

export type BotWatcherGrants = {
  /** Run once, approve, move and resume run code, so they need terminal access. */
  readonly runCode: boolean;
  /** Reject, pause and remove run nothing, so operate access is enough. */
  readonly operate: boolean;
};

export type BotWatcherBlock =
  | "needs_terminal_access"
  | "needs_operate_access"
  | "no_source"
  | "run_once_first"
  | "run_once_there_first"
  | "nothing_to_approve"
  | "already_there";

export type BotWatcherControl =
  | { readonly enabled: true }
  | { readonly enabled: false; readonly reason: BotWatcherBlock };

const allowed: BotWatcherControl = { enabled: true };
const blocked = (reason: BotWatcherBlock): BotWatcherControl => ({ enabled: false, reason });

export interface BotWatcherControls {
  readonly runOnce: BotWatcherControl;
  readonly approve: BotWatcherControl;
  readonly reject: BotWatcherControl;
  readonly pause: BotWatcherControl;
  readonly resume: BotWatcherControl;
  readonly remove: BotWatcherControl;
  /** Moving an approved watcher, which runs nothing until the move is made. */
  readonly move: BotWatcherControl;
  /** Whether the watcher is waiting for a decision on a new version. */
  readonly pending: boolean;
}

/**
 * Which controls work for `watcher` when the user means it to run on `target`, and why not. The
 * server is the authority; this only keeps the UI from offering a call it would refuse.
 */
export function botWatcherControls(
  watcher: BotWatcher,
  target: BotWatcherRunsOn,
  grants: BotWatcherGrants,
): BotWatcherControls {
  const pending = watcher.pendingHash !== undefined;
  // A new watcher has no approved version, so its pending one is the version on show.
  const runnableHash = watcher.pendingHash ?? watcher.approvedHash;
  const needsCode = grants.runCode ? allowed : blocked("needs_terminal_access");
  const needsOperate = grants.operate ? allowed : blocked("needs_operate_access");

  const runOnce = !grants.runCode
    ? blocked("needs_terminal_access")
    : watcher.source === undefined || runnableHash === undefined
      ? blocked("no_source")
      : allowed;

  const approve = !grants.runCode
    ? blocked("needs_terminal_access")
    : watcher.pendingHash === undefined
      ? blocked("nothing_to_approve")
      : watcher.source === undefined
        ? blocked("no_source")
        : !botWatcherDryRunHolds(watcher, watcher.pendingHash, target)
          ? blocked(
              watcher.lastDryRun?.hash === watcher.pendingHash
                ? "run_once_there_first"
                : "run_once_first",
            )
          : allowed;

  const move = !grants.runCode
    ? blocked("needs_terminal_access")
    : watcher.approvedHash === undefined || pending
      ? blocked("nothing_to_approve")
      : target === watcher.runsOn
        ? blocked("already_there")
        : !botWatcherDryRunHolds(watcher, watcher.approvedHash, target)
          ? blocked("run_once_there_first")
          : allowed;

  return {
    runOnce,
    approve,
    reject: pending ? needsOperate : blocked("nothing_to_approve"),
    pause: needsOperate,
    resume: needsCode,
    remove: needsOperate,
    move,
    pending,
  };
}

/** Where a watcher can run: this environment, then each machine it links to, by name. */
export function botWatcherPlaces(
  linked: ReadonlyMap<EnvironmentId, string>,
  current: BotWatcherRunsOn,
): ReadonlyArray<{ readonly value: BotWatcherRunsOn; readonly name: string | null }> {
  const places: Array<{ value: BotWatcherRunsOn; name: string | null }> = [
    { value: "local", name: null },
  ];
  for (const [id, name] of linked) places.push({ value: id, name });
  // A machine the link list no longer has still has to show, or the select would lie.
  if (!places.some((place) => place.value === current)) places.push({ value: current, name: null });
  return places;
}

export type BotWatcherInterval = {
  readonly count: number;
  readonly unit: "second" | "minute" | "hour" | "day";
};

/** The largest unit that divides the interval evenly, so "every 90 min" is not "1.5 h". */
export function botWatcherInterval(seconds: number): BotWatcherInterval {
  if (seconds % 86_400 === 0) return { count: seconds / 86_400, unit: "day" };
  if (seconds % 3_600 === 0) return { count: seconds / 3_600, unit: "hour" };
  if (seconds % 60 === 0) return { count: seconds / 60, unit: "minute" };
  return { count: seconds, unit: "second" };
}

export const shortBotWatcherHash = (hash: string) => hash.slice(0, 12);

export type BotWatcherDiffLine = {
  readonly kind: "add" | "remove" | "hunk" | "context";
  readonly text: string;
};

/** Drops the patch's file headers: both sides are the same watcher, so they say nothing. */
export function parseBotWatcherDiff(diff: string): ReadonlyArray<BotWatcherDiffLine> {
  const lines: Array<BotWatcherDiffLine> = [];
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) {
      inHunk = true;
      lines.push({ kind: "hunk", text: line });
    } else if (!inHunk) {
      continue;
    } else if (line.startsWith("+")) {
      lines.push({ kind: "add", text: line.slice(1) });
    } else if (line.startsWith("-")) {
      lines.push({ kind: "remove", text: line.slice(1) });
    } else if (line.startsWith(" ")) {
      lines.push({ kind: "context", text: line.slice(1) });
    }
  }
  return lines;
}

/** What the Bot is sent to ask for a revision. It is sent as the user, so it is not translated. */
export function botWatcherReviseMessage(watcher: BotWatcher, note: string): string {
  const version = shortBotWatcherHash(watcher.pendingHash ?? watcher.approvedHash ?? watcher.hash);
  // oxlint-disable-next-line t3code/no-untranslated-copy -- sent to the Bot as the user's message, so it stays English like the Bot's instructions
  return `Please revise the watcher "${watcher.name}" (version ${version}) and propose the new version. ${note.trim()}`;
}
