import { assert, it } from "@effect/vitest";

import { normaliseToolRefs } from "./ToolRuns.ts";

it("refuses two tool names that differ only in case, as their output files would collide", () => {
  const refused = normaliseToolRefs([
    { name: "Balance", args: [] },
    { name: "balance", args: [] },
  ]);
  assert.property(refused, "refused");
  // The same name twice is one tool, as before.
  assert.deepStrictEqual(
    normaliseToolRefs([
      { name: "b", args: [] },
      { name: "b", args: [] },
    ]),
    { tools: [{ name: "b", args: [] }] },
  );
});
