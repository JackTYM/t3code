import {
  type BotTask,
  type BotTaskRawLine,
  type BotTaskStatus,
  ThreadId,
} from "@t3tools/contracts";

/**
 * One task per line: `- [ ] id | title | status | note | threadId threadId`, indented two spaces
 * per level. The status word decides; `[x]` only mirrors done. Any other line stays in the file
 * and is shown as written. docs/internals/bots.md has the rest.
 */

const STATUSES: ReadonlySet<string> = new Set<BotTaskStatus>([
  "open",
  "in_progress",
  "waiting",
  "done",
]);

const TASK_LINE = /^(?<indent>[ \t]*)- \[(?<mark>[ xX])\] (?<fields>.*)$/u;
const FIELD_SEPARATOR = " | ";
const MAX_FIELDS = 5;

interface ParsedLine {
  readonly indent: string;
  readonly depth: number;
  readonly id: string;
  readonly title: string;
  readonly status: BotTaskStatus;
  readonly note: string;
  readonly threads: string;
}

// A tab counts as one level, as two spaces do.
const depthOf = (indent: string) =>
  Math.floor([...indent].reduce((width, char) => width + (char === "\t" ? 2 : 1), 0) / 2);

const parseLine = (line: string): ParsedLine | undefined => {
  const match = TASK_LINE.exec(line.trimEnd());
  if (match === null) return undefined;
  const { indent = "", fields: rest = "" } = match.groups ?? {};
  const fields = rest.split(FIELD_SEPARATOR).map((field) => field.trim());
  if (fields.length < 3 || fields.length > MAX_FIELDS) return undefined;
  const [id = "", title = "", statusWord = "", note = "", threads = ""] = fields;
  const status = statusWord.toLowerCase().replace(/[\s-]+/gu, "_");
  if (id === "" || /\s/u.test(id) || title === "" || !STATUSES.has(status)) return undefined;
  return {
    indent,
    depth: depthOf(indent),
    id,
    title,
    status: status as BotTaskStatus,
    note,
    threads,
  };
};

const formatLine = (task: ParsedLine, status: BotTaskStatus) => {
  const tail =
    task.threads !== "" ? [task.note, task.threads] : task.note !== "" ? [task.note] : [];
  return `${task.indent}- [${status === "done" ? "x" : " "}] ${[task.id, task.title, status, ...tail].join(FIELD_SEPARATOR)}`;
};

/**
 * Walks the lines once. A second task with an id already used is kept as a raw line: a client acts
 * on an id, and acting on the wrong one of two would be worse than showing the line as text.
 */
const scan = (text: string) => {
  const seen = new Set<string>();
  return text.split("\n").map((line) => {
    const task = parseLine(line);
    if (task === undefined || seen.has(task.id)) return { line, task: undefined };
    seen.add(task.id);
    return { line, task };
  });
};

export const parseBotTasks = (text: string): ReadonlyArray<BotTask | BotTaskRawLine> =>
  scan(text).flatMap(({ line, task }): Array<BotTask | BotTaskRawLine> => {
    if (task !== undefined) {
      return [
        {
          kind: "task",
          id: task.id as BotTask["id"],
          title: task.title,
          status: task.status,
          ...(task.note === "" ? {} : { note: task.note }),
          threadIds: task.threads
            .split(/[\s,]+/u)
            .filter((id) => id !== "")
            .map((id) => ThreadId.make(id)),
          depth: task.depth,
        },
      ];
    }
    return line.trim() === "" ? [] : [{ kind: "raw", text: line.trimEnd() }];
  });

/**
 * `text` with one task's status changed and its checkbox kept in step, every other line byte for
 * byte as it was. Undefined when no task has that id.
 */
export const setBotTaskStatus = (
  text: string,
  taskId: string,
  status: BotTaskStatus,
): string | undefined => {
  let found = false;
  const lines = scan(text).map(({ line, task }) => {
    if (task === undefined || task.id !== taskId) return line;
    found = true;
    return formatLine(task, status);
  });
  return found ? lines.join("\n") : undefined;
};
