import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { withBotInstructions } from "./botInstructions.ts";

describe("withBotInstructions", () => {
  const instructions = withBotInstructions(ThreadId.make("thread-1"), "hello");

  it("keeps an empty prompt empty", () => {
    expect(withBotInstructions(ThreadId.make("thread-1"), "  ")).toBe("  ");
  });

  it("explains grants, tools and what a tool call does to the turn", () => {
    for (const name of [
      "t3_bot_tool_propose",
      "t3_bot_tool_run",
      "t3_bot_secret_grants_list",
      "$T3_TOOL_OUTPUT_DIR",
      "Settings → Home",
    ]) {
      expect(instructions).toContain(name);
    }
    expect(instructions).toContain("after you call a tool");
    // The Bot once denied that a watcher has a field for declaring tools.
    expect(instructions).toContain("`tools` parameter of t3_bot_watcher_propose");
  });
});
