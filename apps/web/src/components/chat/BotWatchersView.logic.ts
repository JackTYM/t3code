import type {
  BotSecretGrant,
  BotWatcher,
  BotWatcherReview,
  BotWatcherRunsOn,
  EnvironmentId,
} from "@t3tools/contracts";

/**
 * What the badge says. `reviewing` is a first version the reviewer has not approved, so nothing
 * runs. `revising` is a running watcher with a newer version under review.
 */
export type BotWatcherState =
  | "reviewing"
  | "revising"
  | "invalid"
  | "paused"
  | "waiting"
  | "failing"
  | "running";

export function botWatcherState(watcher: BotWatcher): BotWatcherState {
  switch (watcher.status) {
    case "needs_approval":
      return "reviewing";
    case "invalid":
      return "invalid";
    case "paused":
      return "paused";
    case "waiting":
      return "waiting";
    case "tripped":
      return "failing";
    case "healthy":
      return watcher.pendingHash === undefined ? "running" : "revising";
  }
}

export type BotWatcherGroup = "attention" | "running" | "paused";

const GROUP_OF = {
  reviewing: "running",
  revising: "running",
  invalid: "attention",
  failing: "attention",
  waiting: "running",
  running: "running",
  paused: "paused",
} as const satisfies Record<BotWatcherState, BotWatcherGroup>;

/** What needs the user first, then what runs, then what they stopped. */
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

/**
 * How many watchers the Bot button badge counts: failing ones and invalid ones (files that no
 * longer match what was reviewed). A version waiting on the reviewer asks nothing of the user.
 */
export const botWatchersNeedingYou = (watchers: ReadonlyArray<BotWatcher>): number =>
  watchers.filter((watcher) => watcher.status === "tripped" || watcher.status === "invalid").length;

const REVIEW_REFRESH_MS = 5000;

/**
 * The server pushes nothing when a review ends, so a list with a version under review is
 * refetched on a timer, and left alone otherwise.
 */
export const watchersRefreshIntervalMs = (watchers: ReadonlyArray<BotWatcher>): number | null =>
  watchers.some((watcher) => {
    const state = botWatcherState(watcher);
    return state === "reviewing" || state === "revising";
  })
    ? REVIEW_REFRESH_MS
    : null;

/** The reviewer's newest verdict. */
export function latestReview(watcher: BotWatcher): BotWatcherReview | undefined {
  let newest: BotWatcherReview | undefined;
  for (const review of watcher.reviews) {
    // `>=` so that of two saved in the same instant the later one wins.
    if (newest === undefined || Date.parse(review.at) >= Date.parse(newest.at)) newest = review;
  }
  return newest;
}

/** The version `watcher.lastDryRun` describes, when it is the one on show. */
export const botWatcherDryRunOf = (watcher: BotWatcher) =>
  watcher.lastDryRun?.hash === watcher.hash ? watcher.lastDryRun : undefined;

/** Mirrors the server's rule: the dry run must be of exactly this version, where it will run. */
const botWatcherDryRunHolds = (watcher: BotWatcher, hash: string, runsOn: BotWatcherRunsOn) =>
  watcher.lastDryRun?.hash === hash && (watcher.lastDryRun.runsOn ?? "local") === runsOn;

export type BotWatcherGrants = {
  /** Run once, move and resume run code, so they need terminal access. */
  readonly runCode: boolean;
  /** Pause and remove run nothing, so operate access is enough. */
  readonly operate: boolean;
};

/** Why Run once is closed, which is the one control whose reason the view prints. */
export type BotWatcherBlock = "needs_terminal_access" | "no_source" | "not_reviewed";

export type BotWatcherControl =
  | { readonly enabled: true }
  | { readonly enabled: false; readonly reason: BotWatcherBlock };

export interface BotWatcherControls {
  readonly runOnce: BotWatcherControl;
  readonly pause: boolean;
  readonly resume: boolean;
  readonly remove: boolean;
  /** Moving an approved watcher, which runs nothing until the move is made. */
  readonly move: boolean;
  /** Whether a version waits on the reviewer. */
  readonly pending: boolean;
}

/**
 * Which controls work for `watcher` when the user means it to run on `target`, and why Run once
 * does not. The server is the authority; this only keeps the UI from offering a call it would
 * refuse.
 */
export function botWatcherControls(
  watcher: BotWatcher,
  target: BotWatcherRunsOn,
  grants: BotWatcherGrants,
): BotWatcherControls {
  const pending = watcher.pendingHash !== undefined;
  // A new watcher has no approved version yet, so its pending one is the version on show.
  const runnableHash = watcher.pendingHash ?? watcher.approvedHash;

  // The server runs a new version for nobody, the user included, until the reviewer approved it.
  const reviewed = watcher.reviews.some(
    (review) =>
      review.hash === watcher.pendingHash &&
      review.verdict === "approve" &&
      review.source === "model",
  );
  const runOnce: BotWatcherControl = !grants.runCode
    ? { enabled: false, reason: "needs_terminal_access" }
    : watcher.source === undefined || runnableHash === undefined
      ? { enabled: false, reason: "no_source" }
      : pending && !reviewed
        ? { enabled: false, reason: "not_reviewed" }
        : { enabled: true };

  return {
    runOnce,
    pause: grants.operate,
    resume: grants.runCode,
    remove: grants.operate,
    move:
      grants.runCode &&
      watcher.approvedHash !== undefined &&
      !pending &&
      target !== watcher.runsOn &&
      botWatcherDryRunHolds(watcher, watcher.approvedHash, target),
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

/**
 * Each secret the version declares, and whether the user's grants cover it: a grant of that name
 * that allows every host the version declares. `granted` is null while the grants are not loaded,
 * so the view does not claim a secret is missing. The server decides again when the watcher runs.
 */
export function botWatcherSecretStatus(
  watcher: BotWatcher,
  grants: ReadonlyArray<BotSecretGrant> | null,
): ReadonlyArray<{ readonly name: string; readonly granted: boolean | null }> {
  const hosts = watcher.hosts ?? [];
  return (watcher.secrets ?? []).map((name) => {
    if (grants === null) return { name, granted: null };
    const grant = grants.find((candidate) => candidate.name === name);
    return {
      name,
      granted: grant !== undefined && hosts.every((host) => grant.hosts.includes(host)),
    };
  });
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
