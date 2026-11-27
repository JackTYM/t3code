import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { withBotInstructions } from "./botInstructions.ts";

describe("withBotInstructions", () => {
  const instructions = withBotInstructions(ThreadId.make("thread-1"), "hello");

  it("keeps an empty prompt empty", () => {
    expect(withBotInstructions(ThreadId.make("thread-1"), "  ")).toBe("  ");
  });

  it("tells the Bot a script with a secret reaches only its declared hosts, over HTTPS, through a proxy", () => {
    expect(instructions).toContain("only its declared hosts, over HTTPS on port 443");
    expect(instructions).toContain("HTTPS_PROXY");
    expect(instructions).toContain("egress blocked:");
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

  it("points the Bot at the recipes for a calendar or GitHub", () => {
    expect(instructions).toMatch(/calendar.*GitHub.*t3_bot_recipe/iu);
  });
});
