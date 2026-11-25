import type { BotTask, BotTaskRawLine, BotTaskStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { botTaskCounts, visibleBotTaskRows } from "./BotTasksView.logic";

const task = (id: string, depth: number, status: BotTaskStatus): BotTask => ({
  kind: "task",
  id: id as BotTask["id"],
  title: id,
  status,
  threadIds: [],
  depth,
});
const raw = (text: string): BotTaskRawLine => ({ kind: "raw", text });

const entries = [
  raw("# Essay"),
  task("research", 0, "in_progress"),
  task("sources", 1, "done"),
  task("foner", 1, "open"),
  task("write", 0, "open"),
  task("draft", 1, "waiting"),
  task("cite", 2, "waiting"),
];

const ids = (rows: ReturnType<typeof visibleBotTaskRows>) =>
  rows.map(({ entry }) => (entry.kind === "raw" ? entry.text : entry.id));

describe("visibleBotTaskRows", () => {
  it("shows every entry in file order when nothing is filtered or collapsed", () => {
    const rows = visibleBotTaskRows(entries, "all", new Set());
    expect(ids(rows)).toEqual([
      "# Essay",
      "research",
      "sources",
      "foner",
      "write",
      "draft",
      "cite",
    ]);
    expect(
      rows.find(({ entry }) => entry.kind === "task" && entry.id === "write")?.hasChildren,
    ).toBe(true);
  });

  it("hides a collapsed task's whole subtree and nothing after it", () => {
    expect(ids(visibleBotTaskRows(entries, "all", new Set(["write", "sources"])))).toEqual([
      "# Essay",
      "research",
      "sources",
      "foner",
      "write",
    ]);
  });

  it("keeps matches with their parents as context, drops raw lines, and ignores collapsing", () => {
    const rows = visibleBotTaskRows(entries, "waiting", new Set(["write"]));
    expect(rows.map(({ entry, context }) => [(entry as BotTask).id, context])).toEqual([
      ["write", true],
      ["draft", false],
      ["cite", false],
    ]);
  });

  it("is empty when nothing matches", () => {
    expect(visibleBotTaskRows([task("a", 0, "open")], "done", new Set())).toEqual([]);
  });
});

describe("botTaskCounts", () => {
  it("counts tasks and the ones not done, ignoring raw lines", () => {
    expect(botTaskCounts(entries)).toEqual({ total: 6, open: 5 });
  });
});
