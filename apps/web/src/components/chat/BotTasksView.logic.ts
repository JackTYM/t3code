import type { BotTask, BotTaskRawLine, BotTaskStatus } from "@t3tools/contracts";

export type BotTaskEntry = BotTask | BotTaskRawLine;
export type BotTaskFilter = "all" | BotTaskStatus;

export interface BotTaskRow {
  /** Stable across renders: a task's id, or a raw line's place in the file. */
  readonly key: string;
  readonly entry: BotTaskEntry;
  readonly hasChildren: boolean;
  readonly collapsed: boolean;
  /** Kept only to show where a match sits, so it reads dimmed. */
  readonly context: boolean;
}

/** A task's subtasks are the tasks right after it that sit deeper; a raw line ends them. */
const subtreeEnd = (entries: ReadonlyArray<BotTaskEntry>, index: number, depth: number) => {
  let end = index + 1;
  while (end < entries.length) {
    const next = entries[end]!;
    if (next.kind !== "task" || next.depth <= depth) break;
    end += 1;
  }
  return end;
};

/**
 * The rows to draw. A filter keeps matching tasks and the parents above them, drops raw lines, and
 * ignores collapsing so a match is never hidden. Without one, a collapsed task hides its subtasks.
 */
export function visibleBotTaskRows(
  entries: ReadonlyArray<BotTaskEntry>,
  filter: BotTaskFilter,
  collapsedIds: ReadonlySet<string>,
): ReadonlyArray<BotTaskRow> {
  const rows: Array<BotTaskRow> = [];
  let skipUntil = 0;
  entries.forEach((entry, index) => {
    if (index < skipUntil) return;
    if (entry.kind === "raw") {
      if (filter === "all")
        rows.push({
          key: `raw:${index}`,
          entry,
          hasChildren: false,
          collapsed: false,
          context: false,
        });
      return;
    }
    const end = subtreeEnd(entries, index, entry.depth);
    const hasChildren = end > index + 1;
    if (filter !== "all") {
      const own = entry.status === filter;
      const below = entries
        .slice(index + 1, end)
        .some((descendant) => descendant.kind === "task" && descendant.status === filter);
      if (own || below)
        rows.push({ key: entry.id, entry, hasChildren, collapsed: false, context: !own });
      return;
    }
    const collapsed = hasChildren && collapsedIds.has(entry.id);
    rows.push({ key: entry.id, entry, hasChildren, collapsed, context: false });
    if (collapsed) skipUntil = end;
  });
  return rows;
}

export function botTaskCounts(entries: ReadonlyArray<BotTaskEntry>) {
  const tasks = entries.filter((entry): entry is BotTask => entry.kind === "task");
  return { total: tasks.length, open: tasks.filter((task) => task.status !== "done").length };
}
