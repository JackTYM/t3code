import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";

import { parseBotTasks, setBotTaskStatus } from "./botTasks.ts";

const FILE = [
  "# Essay",
  "",
  "- [ ] t1 | Write draft | in_progress | due Dec 6 | thread:a, thread:b",
  "  - [x] t2 | Find sources | done",
  "    - [ ] t3 | Read Foner | open |  | thread:c",
  "\t- [ ] t4 | Cite | Waiting",
  "- [ ] t8 | Dashes | In-Progress",
  "- [ ] t5 | Pipes | in | title | waiting",
  "- [ ] t1 | Same id again | open",
  "- [ ] has space | Bad id | open",
  "- [ ] t6 | Too | open | many | fields | here",
  "- [ ] t7 | | open",
  "- plain bullet",
].join("\n");

it("parses tasks, depth, note and threads, and keeps every other line raw in order", () => {
  assert.deepStrictEqual(parseBotTasks(FILE), [
    { kind: "raw", text: "# Essay" },
    {
      kind: "task",
      id: "t1",
      title: "Write draft",
      status: "in_progress",
      note: "due Dec 6",
      threadIds: [ThreadId.make("thread:a"), ThreadId.make("thread:b")],
      depth: 0,
    },
    { kind: "task", id: "t2", title: "Find sources", status: "done", threadIds: [], depth: 1 },
    {
      kind: "task",
      id: "t3",
      title: "Read Foner",
      status: "open",
      threadIds: [ThreadId.make("thread:c")],
      depth: 2,
    },
    { kind: "task", id: "t4", title: "Cite", status: "waiting", threadIds: [], depth: 1 },
    { kind: "task", id: "t8", title: "Dashes", status: "in_progress", threadIds: [], depth: 0 },
    { kind: "raw", text: "- [ ] t5 | Pipes | in | title | waiting" },
    { kind: "raw", text: "- [ ] t1 | Same id again | open" },
    { kind: "raw", text: "- [ ] has space | Bad id | open" },
    { kind: "raw", text: "- [ ] t6 | Too | open | many | fields | here" },
    { kind: "raw", text: "- [ ] t7 | | open" },
    { kind: "raw", text: "- plain bullet" },
  ]);
});

it("never throws on junk", () => {
  for (const junk of [
    "",
    "\n\n",
    "- [",
    "- [ ] ",
    "- [ ] | | |",
    "\u0000 | - [x] a | b | done",
    "|||",
  ]) {
    parseBotTasks(junk);
  }
});

it("changes one task's status and checkbox and leaves every other line as it was", () => {
  const done = setBotTaskStatus(FILE, "t1", "done")!;
  assert.strictEqual(
    done,
    FILE.replace(
      "- [ ] t1 | Write draft | in_progress | due Dec 6 | thread:a, thread:b",
      "- [x] t1 | Write draft | done | due Dec 6 | thread:a, thread:b",
    ),
  );
  // Reopening round-trips, and a task with threads but no note keeps its empty note slot.
  assert.strictEqual(setBotTaskStatus(done, "t1", "in_progress"), FILE);
  assert.include(
    setBotTaskStatus(FILE, "t3", "done")!,
    "    - [x] t3 | Read Foner | done |  | thread:c",
  );
  assert.include(setBotTaskStatus(FILE, "t4", "done")!, "\t- [x] t4 | Cite | done");
});

it("finds only the first task with an id and reports a missing one", () => {
  assert.strictEqual(setBotTaskStatus(FILE, "nope", "done"), undefined);
  assert.strictEqual(setBotTaskStatus(FILE, "has space", "done"), undefined);
  assert.include(setBotTaskStatus(FILE, "t1", "done")!, "- [ ] t1 | Same id again | open");
});
