import type {
  BotSecretGrant,
  BotWatcher,
  BotWatcherReview,
  BotWatcherRun,
  EnvironmentId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  botWatcherControls,
  botWatcherDryRunOf,
  botWatcherInterval,
  botWatcherKind,
  botWatcherPlaces,
  botWatcherReviseMessage,
  botWatcherSecretStatus,
  botWatcherState,
  botWatcherToolCall,
  botWatchersNeedingYou,
  botWatchersUsingTool,
  groupBotWatchers,
  latestReview,
  parseBotWatcherDiff,
  watchersRefreshIntervalMs,
} from "./BotWatchersView.logic";

const LAPTOP = "env-laptop" as EnvironmentId;
const both = { runCode: true, operate: true };

const watcher = (overrides: Partial<BotWatcher> & { name: string }): BotWatcher => ({
  status: "healthy",
  hash: "aaaaaaaaaaaaaaaaaaaa",
  approvedHash: "aaaaaaaaaaaaaaaaaaaa",
  source: "echo ok",
  runsOn: "local",
  paused: false,
  history: [],
  reviews: [],
  ...overrides,
});

const run = (overrides: Partial<BotWatcherRun>): BotWatcherRun => ({
  hash: "bbbbbbbbbbbbbbbbbbbb",
  ranAt: "2026-11-25T10:00:00.000Z" as BotWatcherRun["ranAt"],
  exit: "0",
  stdout: "",
  stderr: "",
  healthy: true,
  ...overrides,
});

const review = (overrides: Partial<BotWatcherReview> = {}): BotWatcherReview => ({
  hash: "bbbbbbbbbbbbbbbbbbbb",
  at: "2026-11-25T10:00:00.000Z" as BotWatcherReview["at"],
  verdict: "approve",
  reason: "Reads only.",
  model: "reviewer-model",
  source: "model",
  ...overrides,
});

/** A revision the reviewer has not finished with, beside the version that keeps running. */
const revising = (overrides: Partial<BotWatcher> = {}) =>
  watcher({
    name: "deadlines",
    hash: "bbbbbbbbbbbbbbbbbbbb",
    pendingHash: "bbbbbbbbbbbbbbbbbbbb",
    ...overrides,
  });

/** A first version the reviewer has not approved yet, so nothing runs. */
const proposed = (overrides: Partial<BotWatcher> = {}) =>
  revising({ status: "needs_approval", approvedHash: undefined, ...overrides });

const tool = (overrides: Partial<BotWatcher> & { name: string }) =>
  watcher({ kind: "tool", usage: "gh-issues <repo>", ...overrides });

describe("botWatcherState", () => {
  it("calls an approved tool ready, not running, and keeps it with the active rows", () => {
    expect(botWatcherKind(watcher({ name: "a" }))).toBe("watch");
    expect(botWatcherState(tool({ name: "gh" }))).toBe("ready");
    expect(botWatcherState(tool({ name: "gh", pendingHash: "bbbbbbbbbbbbbbbbbbbb" }))).toBe(
      "revising",
    );
    expect(groupBotWatchers([tool({ name: "gh" })]).map((entry) => entry.group)).toEqual([
      "running",
    ]);
  });

  it("tells a first version under review from a revision beside a running one", () => {
    expect(botWatcherState(proposed())).toBe("reviewing");
    expect(botWatcherState(revising())).toBe("revising");
  });

  it("keys the revision off the pending version, not the status", () => {
    expect(botWatcherState(watcher({ name: "a" }))).toBe("running");
    expect(botWatcherState(revising({ status: "needs_approval" }))).toBe("reviewing");
  });

  it("keeps a failing, paused or waiting watcher as that, with a revision pending", () => {
    expect(botWatcherState(revising({ status: "tripped" }))).toBe("failing");
    expect(botWatcherState(revising({ status: "paused", paused: true }))).toBe("paused");
    expect(botWatcherState(revising({ status: "waiting" }))).toBe("waiting");
  });

  it("names the other statuses", () => {
    expect(botWatcherState(watcher({ name: "a", status: "tripped" }))).toBe("failing");
    expect(botWatcherState(watcher({ name: "a", status: "waiting" }))).toBe("waiting");
    expect(botWatcherState(watcher({ name: "a", status: "paused" }))).toBe("paused");
    expect(botWatcherState(watcher({ name: "a", status: "invalid" }))).toBe("invalid");
    expect(botWatcherState(watcher({ name: "a" }))).toBe("running");
  });
});

describe("groupBotWatchers", () => {
  it("puts what needs the user first and sorts by name inside a group", () => {
    const groups = groupBotWatchers([
      watcher({ name: "zeta" }),
      watcher({ name: "paused-one", status: "paused", paused: true }),
      watcher({ name: "beta", status: "tripped" }),
      proposed({ name: "alpha" }),
      watcher({ name: "alpine", status: "waiting" }),
    ]);
    expect(groups.map((entry) => [entry.group, entry.watchers.map((w) => w.name)])).toEqual([
      ["attention", ["beta"]],
      ["running", ["alpha", "alpine", "zeta"]],
      ["paused", ["paused-one"]],
    ]);
  });

  it("does not ask anything of the user while the reviewer is working", () => {
    expect(groupBotWatchers([proposed()]).map((entry) => entry.group)).toEqual(["running"]);
    expect(groupBotWatchers([revising()]).map((entry) => entry.group)).toEqual(["running"]);
  });

  it("leaves out empty groups", () => {
    expect(groupBotWatchers([])).toEqual([]);
  });
});

describe("botWatchersNeedingYou", () => {
  it("counts the watchers that are failing or broken", () => {
    expect(
      botWatchersNeedingYou([
        proposed({ name: "new-one" }),
        revising({ name: "changed-one" }),
        revising({ name: "paused-with-update", status: "paused", paused: true }),
        watcher({ name: "failing-one", status: "tripped" }),
        revising({ name: "failing-with-update", status: "tripped" }),
        watcher({ name: "invalid-one", status: "invalid" }),
        watcher({ name: "fine" }),
        watcher({ name: "waiting-one", status: "waiting" }),
        watcher({ name: "stopped", status: "paused", paused: true }),
      ]),
    ).toBe(3);
  });

  it("is zero with nothing wrong", () => {
    expect(botWatchersNeedingYou([])).toBe(0);
    expect(botWatchersNeedingYou([watcher({ name: "fine" }), proposed()])).toBe(0);
  });
});

describe("watchersRefreshIntervalMs", () => {
  // The server pushes nothing when a review ends, so the list is polled while one is under way.
  it("polls while a first version or a revision waits on the reviewer", () => {
    expect(watchersRefreshIntervalMs([proposed({ name: "new-one" })])).toBe(5000);
    expect(
      watchersRefreshIntervalMs([watcher({ name: "fine" }), revising({ name: "changed-one" })]),
    ).toBe(5000);
  });

  it("does not poll when nothing is under review", () => {
    expect(watchersRefreshIntervalMs([])).toBeNull();
    expect(
      watchersRefreshIntervalMs([
        watcher({ name: "fine" }),
        watcher({ name: "failing-one", status: "tripped" }),
        watcher({ name: "stopped", status: "paused", paused: true }),
      ]),
    ).toBeNull();
  });
});

describe("latestReview", () => {
  it("is undefined before the reviewer has judged anything", () => {
    expect(latestReview(watcher({ name: "a" }))).toBeUndefined();
  });

  it("returns the newest verdict by time, whatever the order they were saved in", () => {
    const old = review({ hash: "a", at: "2026-11-25T09:00:00.000Z" as BotWatcherReview["at"] });
    const newest = review({ hash: "c", at: "2026-11-25T11:00:00.000Z" as BotWatcherReview["at"] });
    const middle = review({ hash: "b", at: "2026-11-25T10:00:00.000Z" as BotWatcherReview["at"] });
    expect(latestReview(watcher({ name: "a", reviews: [old, newest, middle] }))).toBe(newest);
  });
});

describe("botWatcherDryRunOf", () => {
  it("shows a dry run only of the version on show", () => {
    expect(botWatcherDryRunOf(revising({ lastDryRun: run({ hash: "cccccccccccc" }) }))).toBe(
      undefined,
    );
    const matching = run({});
    expect(botWatcherDryRunOf(revising({ lastDryRun: matching }))).toBe(matching);
  });
});

describe("botWatcherControls", () => {
  it("has no approve or reject: a reviewer model decides", () => {
    const controls = botWatcherControls(revising(), "local", both);
    expect(Object.keys(controls).toSorted()).toEqual([
      "choosesPlace",
      "move",
      "pause",
      "pending",
      "remove",
      "resume",
      "runOnce",
    ]);
  });

  it("runs a version once when the files are there, and only with terminal access", () => {
    const approved = revising({ reviews: [review()] });
    expect(botWatcherControls(approved, "local", both).runOnce).toEqual({ enabled: true });
    expect(
      botWatcherControls(approved, "local", { runCode: false, operate: true }).runOnce,
    ).toEqual({ enabled: false, reason: "needs_terminal_access" });
    // The version that runs needs no verdict of its own.
    expect(botWatcherControls(watcher({ name: "a" }), "local", both).runOnce).toEqual({
      enabled: true,
    });
  });

  it("will not run a new version before the reviewer has approved that version itself", () => {
    const notReviewed = { enabled: false, reason: "not_reviewed" };
    expect(botWatcherControls(revising(), "local", both).runOnce).toEqual(notReviewed);
    for (const reviews of [
      [review({ verdict: "reject" })],
      // The server's own rejection and a verdict about some other version are not approvals.
      [review({ source: "error" })],
      [review({ hash: "cccccccccccccccccccc" })],
    ]) {
      expect(botWatcherControls(revising({ reviews }), "local", both).runOnce).toEqual(notReviewed);
    }
    expect(botWatcherControls(proposed(), "local", both).runOnce).toEqual(notReviewed);
    expect(botWatcherControls(proposed({ reviews: [review()] }), "local", both).runOnce).toEqual({
      enabled: true,
    });
  });

  it("cannot run a version whose files are missing", () => {
    expect(botWatcherControls(revising({ source: undefined }), "local", both).runOnce).toEqual({
      enabled: false,
      reason: "no_source",
    });
  });

  it("lets operate access pause and remove, but not resume", () => {
    const controls = botWatcherControls(revising(), "local", { runCode: false, operate: true });
    expect(controls.pause).toBe(true);
    expect(controls.remove).toBe(true);
    expect(controls.resume).toBe(false);
  });

  it("closes pause and remove for a connection with no grants", () => {
    const controls = botWatcherControls(revising(), "local", { runCode: false, operate: false });
    expect(controls.pause).toBe(false);
    expect(controls.remove).toBe(false);
  });

  it("moves an approved watcher only after it has run once in the new place", () => {
    const approved = watcher({ name: "a" });
    expect(botWatcherControls(approved, "local", both).move).toBe(false);
    expect(botWatcherControls(approved, LAPTOP, both).move).toBe(false);
    const tried = watcher({
      name: "a",
      lastDryRun: run({ hash: "aaaaaaaaaaaaaaaaaaaa", runsOn: LAPTOP }),
    });
    expect(botWatcherControls(tried, LAPTOP, both).move).toBe(true);
    expect(botWatcherControls(tried, LAPTOP, { runCode: false, operate: true }).move).toBe(false);
  });

  it("does not move a watcher while a revision is under review", () => {
    expect(botWatcherControls(revising(), LAPTOP, both).move).toBe(false);
  });
});

describe("where a row can run", () => {
  const declared = [{ name: "gh", args: ["owner/repo"] }];

  it("offers no place for a tool, nor to move one, even with a dry run on file", () => {
    const row = tool({
      name: "gh",
      lastDryRun: run({ hash: "aaaaaaaaaaaaaaaaaaaa", runsOn: LAPTOP }),
    });
    const controls = botWatcherControls(row, LAPTOP, both);
    expect(controls.choosesPlace).toBe(false);
    expect(controls.move).toBe(false);
  });

  it("offers none for a watcher that uses secrets or tools, which the server keeps here", () => {
    expect(
      botWatcherControls(watcher({ name: "a", secrets: ["KEY"] }), "local", both),
    ).toMatchObject({
      choosesPlace: false,
    });
    expect(
      botWatcherControls(watcher({ name: "a", tools: declared }), "local", both),
    ).toMatchObject({
      choosesPlace: false,
    });
    expect(botWatcherControls(watcher({ name: "a" }), "local", both).choosesPlace).toBe(true);
  });

  it("keeps the picker for a row that already sits elsewhere", () => {
    expect(
      botWatcherControls(watcher({ name: "a", tools: declared, runsOn: LAPTOP }), "local", both)
        .choosesPlace,
    ).toBe(true);
  });
});

describe("declared tools", () => {
  it("writes a call the way the Bot makes it, quoting what needs it", () => {
    expect(botWatcherToolCall({ name: "gh", args: ["owner/repo", "is open"] })).toBe(
      'gh owner/repo "is open"',
    );
    expect(botWatcherToolCall({ name: "inbox", args: [] })).toBe("inbox");
  });

  it("lists the watchers that stop working when a tool goes", () => {
    const rows = [
      watcher({ name: "zed", tools: [{ name: "gh", args: [] }] }),
      watcher({
        name: "alpha",
        tools: [
          { name: "gh", args: ["x"] },
          { name: "other", args: [] },
        ],
      }),
      watcher({ name: "beta", tools: [{ name: "other", args: [] }] }),
      watcher({ name: "plain" }),
    ];
    expect(botWatchersUsingTool(rows, tool({ name: "gh" }))).toEqual(["alpha", "zed"]);
    expect(botWatchersUsingTool(rows, tool({ name: "none" }))).toEqual([]);
  });
});

describe("botWatcherPlaces", () => {
  it("offers this environment first, then linked machines", () => {
    const linked = new Map<EnvironmentId, string>([[LAPTOP, "MacBook"]]);
    expect(botWatcherPlaces(linked, "local")).toEqual([
      { value: "local", name: null },
      { value: LAPTOP, name: "MacBook" },
    ]);
  });

  it("keeps a machine the link list lost, so the choice is not hidden", () => {
    expect(botWatcherPlaces(new Map(), LAPTOP)).toEqual([
      { value: "local", name: null },
      { value: LAPTOP, name: null },
    ]);
  });
});

describe("botWatcherInterval", () => {
  it("uses the largest unit that divides evenly", () => {
    expect(botWatcherInterval(60)).toEqual({ count: 1, unit: "minute" });
    expect(botWatcherInterval(5400)).toEqual({ count: 90, unit: "minute" });
    expect(botWatcherInterval(21_600)).toEqual({ count: 6, unit: "hour" });
    expect(botWatcherInterval(172_800)).toEqual({ count: 2, unit: "day" });
    expect(botWatcherInterval(75)).toEqual({ count: 75, unit: "second" });
  });
});

describe("parseBotWatcherDiff", () => {
  it("drops the file headers and keeps hunks and changes in order", () => {
    const diff = [
      "===",
      "--- approved",
      "+++ proposed",
      "@@ -1,3 +1,3 @@",
      " keep",
      "-old line",
      "+new line",
      "",
    ].join("\n");
    expect(parseBotWatcherDiff(diff)).toEqual([
      { kind: "hunk", text: "@@ -1,3 +1,3 @@" },
      { kind: "context", text: "keep" },
      { kind: "remove", text: "old line" },
      { kind: "add", text: "new line" },
    ]);
  });

  it("shows a changed line that starts with dashes, as only the headers are dropped", () => {
    const diff = ["--- a", "+++ b", "@@ -1 +1 @@", "--- not a header", "+++ not a header"].join(
      "\n",
    );
    expect(parseBotWatcherDiff(diff).map((line) => line.kind)).toEqual(["hunk", "remove", "add"]);
  });
});

describe("botWatcherReviseMessage", () => {
  it("names the watcher and the version and carries the user's note", () => {
    expect(botWatcherReviseMessage(revising(), "  Only look at announcements.  ")).toBe(
      'Please revise the watcher "deadlines" (version bbbbbbbbbbbb) and propose the new version. Only look at announcements.',
    );
  });
});

describe("botWatcherReviseMessage for a tool", () => {
  it("calls it a tool", () => {
    expect(botWatcherReviseMessage(tool({ name: "gh" }), "Add paging.")).toBe(
      'Please revise the tool "gh" (version aaaaaaaaaaaa) and propose the new version. Add paging.',
    );
  });
});

describe("botWatcherSecretStatus", () => {
  const grant = (name: string, hosts: string[]): BotSecretGrant => ({
    name,
    hosts,
    source: "stored",
  });
  const declaring = watcher({
    name: "a",
    secrets: ["GITHUB_TOKEN", "SLACK_TOKEN"],
    hosts: ["api.github.com", "slack.com"],
  });

  it("is granted when a grant of that name allows every declared host", () => {
    const status = botWatcherSecretStatus(declaring, [
      grant("GITHUB_TOKEN", ["slack.com", "api.github.com", "extra.example.com"]),
    ]);
    expect(status).toEqual([
      { name: "GITHUB_TOKEN", granted: true },
      { name: "SLACK_TOKEN", granted: false },
    ]);
  });

  it("needs a grant when it allows only some of the declared hosts", () => {
    expect(
      botWatcherSecretStatus(declaring, [grant("GITHUB_TOKEN", ["api.github.com"])])[0],
    ).toEqual({ name: "GITHUB_TOKEN", granted: false });
  });

  it("needs a grant for every name when there are no grants", () => {
    expect(botWatcherSecretStatus(declaring, []).every((entry) => !entry.granted)).toBe(true);
  });

  it("does not call a secret missing while the grants are unknown", () => {
    expect(botWatcherSecretStatus(declaring, null).map((entry) => entry.granted)).toEqual([
      null,
      null,
    ]);
  });

  it("lists nothing for a version that declares no secrets", () => {
    expect(botWatcherSecretStatus(watcher({ name: "b" }), [grant("X", ["a.com"])])).toEqual([]);
  });
});
