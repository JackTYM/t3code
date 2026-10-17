import type { ThreadSubagentRunGroup } from "@t3tools/client-runtime/state/thread-subagents";
import * as DateTime from "effect/DateTime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { subagentRunGroupLabel } from "./thread-agents-presentation";

const group = (overrides: Partial<ThreadSubagentRunGroup>): ThreadSubagentRunGroup => ({
  runId: "run-1" as ThreadSubagentRunGroup["runId"],
  isCurrentRun: false,
  requestedAt: null,
  subagents: [],
  liveCount: 0,
  ...overrides,
});

describe("subagentRunGroupLabel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-20T12:00:00.000Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("calls the current run this turn", () => {
    expect(subagentRunGroupLabel(group({ isCurrentRun: true }))).toBe("This turn");
  });

  it("labels older runs by how long ago they were requested", () => {
    expect(
      subagentRunGroupLabel(
        group({ requestedAt: DateTime.makeUnsafe("2026-06-20T09:00:00.000Z") }),
      ),
    ).toBe("3h ago");
  });

  it("falls back when the run is unknown", () => {
    expect(subagentRunGroupLabel(group({}))).toBe("Earlier");
  });
});
