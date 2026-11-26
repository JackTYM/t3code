import type { BotWatcher, BotWatcherRun, EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  botWatcherControls,
  botWatcherDryRunOf,
  botWatcherInterval,
  botWatcherPlaces,
  botWatcherReviseMessage,
  botWatcherState,
  botWatchersNeedingYou,
  groupBotWatchers,
  parseBotWatcherDiff,
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

const pending = (overrides: Partial<BotWatcher> = {}) =>
  watcher({
    name: "deadlines",
    status: "needs_approval",
    hash: "bbbbbbbbbbbbbbbbbbbb",
    pendingHash: "bbbbbbbbbbbbbbbbbbbb",
    ...overrides,
  });

describe("botWatcherState", () => {
  it("tells a brand new proposal from a change to an approved watcher", () => {
    expect(botWatcherState(pending({ approvedHash: undefined }))).toBe("new");
    expect(botWatcherState(pending())).toBe("changed");
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
      pending({ name: "alpha" }),
      watcher({ name: "alpine", status: "waiting" }),
    ]);
    expect(groups.map((entry) => [entry.group, entry.watchers.map((w) => w.name)])).toEqual([
      ["attention", ["alpha", "beta"]],
      ["running", ["alpine", "zeta"]],
      ["paused", ["paused-one"]],
    ]);
  });

  it("keeps a paused watcher with a newer version waiting in the first group", () => {
    const [first] = groupBotWatchers([pending({ paused: true })]);
    expect(first?.group).toBe("attention");
  });

  it("leaves out empty groups", () => {
    expect(groupBotWatchers([])).toEqual([]);
  });
});

describe("botWatchersNeedingYou", () => {
  it("counts exactly the watchers listed under Needs you", () => {
    const watchers = [
      pending({ name: "new-one", approvedHash: undefined }),
      pending({ name: "changed-one" }),
      pending({ name: "paused-with-update", paused: true }),
      watcher({ name: "failing-one", status: "tripped" }),
      watcher({ name: "fine" }),
      watcher({ name: "waiting-one", status: "waiting" }),
      watcher({ name: "stopped", status: "paused", paused: true }),
    ];
    expect(botWatchersNeedingYou(watchers)).toBe(4);
    expect(botWatchersNeedingYou(watchers)).toBe(
      groupBotWatchers(watchers).find((entry) => entry.group === "attention")?.watchers.length,
    );
  });

  it("is zero with nothing waiting on the user", () => {
    expect(botWatchersNeedingYou([])).toBe(0);
    expect(botWatchersNeedingYou([watcher({ name: "fine" })])).toBe(0);
  });
});

describe("botWatcherDryRunOf", () => {
  it("shows a dry run only of the version on show", () => {
    expect(botWatcherDryRunOf(pending({ lastDryRun: run({ hash: "cccccccccccc" }) }))).toBe(
      undefined,
    );
    const matching = run({});
    expect(botWatcherDryRunOf(pending({ lastDryRun: matching }))).toBe(matching);
  });
});

describe("botWatcherControls approve", () => {
  it("is closed until the pending version has run once", () => {
    expect(botWatcherControls(pending(), "local", both).approve).toEqual({
      enabled: false,
      reason: "run_once_first",
    });
  });

  it("is open after a dry run of exactly that version where it will run", () => {
    expect(botWatcherControls(pending({ lastDryRun: run({}) }), "local", both).approve).toEqual({
      enabled: true,
    });
    expect(
      botWatcherControls(pending({ lastDryRun: run({ runsOn: LAPTOP }) }), LAPTOP, both).approve,
    ).toEqual({ enabled: true });
  });

  it("stays closed when the dry run was somewhere else or of another version", () => {
    expect(botWatcherControls(pending({ lastDryRun: run({}) }), LAPTOP, both).approve).toEqual({
      enabled: false,
      reason: "run_once_there_first",
    });
    expect(
      botWatcherControls(pending({ lastDryRun: run({ hash: "cccccccccccc" }) }), "local", both)
        .approve,
    ).toEqual({ enabled: false, reason: "run_once_first" });
  });

  it("needs terminal access, whatever the dry run says", () => {
    const controls = botWatcherControls(pending({ lastDryRun: run({}) }), "local", {
      runCode: false,
      operate: true,
    });
    expect(controls.approve).toEqual({ enabled: false, reason: "needs_terminal_access" });
    expect(controls.runOnce).toEqual({ enabled: false, reason: "needs_terminal_access" });
    expect(controls.resume).toEqual({ enabled: false, reason: "needs_terminal_access" });
    expect(controls.reject).toEqual({ enabled: true });
    expect(controls.pause).toEqual({ enabled: true });
  });

  it("has nothing to approve on a watcher with no waiting version", () => {
    expect(botWatcherControls(watcher({ name: "a" }), "local", both).approve).toEqual({
      enabled: false,
      reason: "nothing_to_approve",
    });
  });

  it("cannot approve a version whose files are missing", () => {
    const controls = botWatcherControls(
      pending({ source: undefined, lastDryRun: run({}) }),
      "local",
      both,
    );
    expect(controls.approve).toEqual({ enabled: false, reason: "no_source" });
    expect(controls.runOnce).toEqual({ enabled: false, reason: "no_source" });
  });
});

describe("botWatcherControls stopping and moving", () => {
  it("lets operate access pause, remove and reject, but not resume", () => {
    const controls = botWatcherControls(pending(), "local", { runCode: false, operate: true });
    expect(controls.pause).toEqual({ enabled: true });
    expect(controls.remove).toEqual({ enabled: true });
    expect(controls.reject).toEqual({ enabled: true });
    expect(controls.resume.enabled).toBe(false);
  });

  it("closes everything but nothing-to-reject for a connection with no grants", () => {
    const controls = botWatcherControls(pending(), "local", { runCode: false, operate: false });
    expect(controls.pause).toEqual({ enabled: false, reason: "needs_operate_access" });
    expect(controls.remove).toEqual({ enabled: false, reason: "needs_operate_access" });
    expect(controls.reject).toEqual({ enabled: false, reason: "needs_operate_access" });
  });

  it("only rejects a watcher that has a version waiting", () => {
    expect(botWatcherControls(watcher({ name: "a" }), "local", both).reject).toEqual({
      enabled: false,
      reason: "nothing_to_approve",
    });
  });

  it("moves an approved watcher only after it has run once in the new place", () => {
    const approved = watcher({ name: "a" });
    expect(botWatcherControls(approved, "local", both).move).toEqual({
      enabled: false,
      reason: "already_there",
    });
    expect(botWatcherControls(approved, LAPTOP, both).move).toEqual({
      enabled: false,
      reason: "run_once_there_first",
    });
    const tried = watcher({
      name: "a",
      lastDryRun: run({ hash: "aaaaaaaaaaaaaaaaaaaa", runsOn: LAPTOP }),
    });
    expect(botWatcherControls(tried, LAPTOP, both).move).toEqual({ enabled: true });
  });

  it("does not move a watcher while a new version waits: approval chooses the place", () => {
    expect(botWatcherControls(pending(), LAPTOP, both).move.enabled).toBe(false);
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
    expect(botWatcherReviseMessage(pending(), "  Only look at announcements.  ")).toBe(
      'Please revise the watcher "deadlines" (version bbbbbbbbbbbb) and propose the new version. Only look at announcements.',
    );
  });
});
