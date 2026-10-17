import { describe, expect, it } from "vite-plus/test";
import {
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  deriveThreadSubagentRunGroups,
  deriveThreadTurnSubagents,
  resolveSubagentPillSegment,
} from "./threadSubagents.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);

function subagent(
  overrides: Omit<Partial<OrchestrationV2Subagent>, "id"> & { readonly id: string },
): OrchestrationV2Subagent {
  const { id, ...rest } = overrides;
  return {
    id: NodeId.make(id),
    threadId: ThreadId.make("thread-1"),
    runId: RunId.make("run-1"),
    parentNodeId: NodeId.make("node-1"),
    origin: "app_owned",
    createdBy: "agent",
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerThreadId: null,
    childThreadId: ThreadId.make("thread-child"),
    nativeTaskRef: null,
    prompt: "Do the thing",
    title: "Worker",
    model: "gpt-5.4",
    status: "running",
    result: null,
    startedAt: at("2026-06-20T00:00:00.000Z"),
    completedAt: null,
    updatedAt: at("2026-06-20T00:00:01.000Z"),
    ...rest,
  };
}

const run = (id: string, status: "running" | "completed") =>
  ({ id: RunId.make(id), status }) as never;
const activeRun = run("run-1", "running");
const finishedRun = run("run-1", "completed");

describe("deriveThreadTurnSubagents", () => {
  it("returns null when the thread has never spawned an agent", () => {
    expect(deriveThreadTurnSubagents({ runs: [activeRun], subagents: [] })).toBeNull();
  });

  it("scopes the roster to the active run and orders it newest-first", () => {
    const turn = deriveThreadTurnSubagents({
      runs: [run("run-0", "completed"), activeRun],
      subagents: [
        subagent({ id: "b", startedAt: at("2026-06-20T00:00:05.000Z") }),
        subagent({ id: "old", runId: RunId.make("run-0") }),
        subagent({ id: "a", startedAt: at("2026-06-20T00:00:02.000Z") }),
      ],
    });

    expect(turn?.runId).toBe("run-1");
    expect(turn?.subagents.map((entry) => entry.id)).toEqual(["b", "a"]);
    expect(turn?.turnActive).toBe(true);
  });

  it("pins live agents above idle, and idle above settled agents", () => {
    const turn = deriveThreadTurnSubagents({
      runs: [activeRun],
      subagents: [
        subagent({
          id: "settled",
          status: "completed",
          startedAt: at("2026-06-20T00:00:09.000Z"),
          completedAt: at("2026-06-20T00:00:10.000Z"),
          updatedAt: at("2026-06-20T00:00:10.000Z"),
        }),
        subagent({ id: "idle", status: "idle", startedAt: at("2026-06-20T00:00:03.000Z") }),
        subagent({ id: "live", status: "running", startedAt: at("2026-06-20T00:00:01.000Z") }),
      ],
    });

    expect(turn?.subagents.map((entry) => entry.id)).toEqual(["live", "idle", "settled"]);
  });

  it("orders settled agents by when they ended, most recent first", () => {
    const turn = deriveThreadTurnSubagents({
      runs: [activeRun],
      subagents: [
        subagent({
          id: "started-later-ended-earlier",
          status: "completed",
          startedAt: at("2026-06-20T00:00:05.000Z"),
          completedAt: at("2026-06-20T00:00:06.000Z"),
          updatedAt: at("2026-06-20T00:00:06.000Z"),
        }),
        subagent({
          id: "started-earlier-ended-later",
          status: "failed",
          startedAt: at("2026-06-20T00:00:01.000Z"),
          completedAt: at("2026-06-20T00:00:09.000Z"),
          updatedAt: at("2026-06-20T00:00:09.000Z"),
        }),
      ],
    });

    expect(turn?.subagents.map((entry) => entry.id)).toEqual([
      "started-earlier-ended-later",
      "started-later-ended-earlier",
    ]);
  });

  it("falls back to the most recently updated agent's run once the turn settles", () => {
    const turn = deriveThreadTurnSubagents({
      runs: [finishedRun, run("run-2", "completed")],
      subagents: [
        subagent({ id: "old", status: "completed", updatedAt: at("2026-06-20T00:00:01.000Z") }),
        subagent({
          id: "recent",
          runId: RunId.make("run-2"),
          status: "completed",
          updatedAt: at("2026-06-20T00:00:09.000Z"),
        }),
      ],
    });

    expect(turn?.runId).toBe("run-2");
    expect(turn?.turnActive).toBe(false);
    expect(turn?.subagents.map((entry) => entry.id)).toEqual(["recent"]);
  });

  it("counts idle as neither working nor done", () => {
    const turn = deriveThreadTurnSubagents({
      runs: [activeRun],
      subagents: [
        subagent({ id: "a", status: "running" }),
        subagent({ id: "b", status: "idle" }),
        subagent({ id: "c", status: "failed" }),
      ],
    });

    expect(turn?.liveCount).toBe(1);
    expect(turn?.settledCount).toBe(1);
    expect(turn?.subagents).toHaveLength(3);
  });
});

describe("deriveThreadSubagentRunGroups", () => {
  const ordinalRun = (id: string, ordinal: number, status: "running" | "completed") =>
    ({ id: RunId.make(id), ordinal, status, requestedAt: at("2026-06-20T00:00:00.000Z") }) as never;

  it("returns no groups for a thread that never spawned an agent", () => {
    expect(
      deriveThreadSubagentRunGroups({ runs: [ordinalRun("run-1", 1, "running")], subagents: [] }),
    ).toEqual([]);
  });

  it("groups agents by run, newest run first, regardless of projection order", () => {
    const groups = deriveThreadSubagentRunGroups({
      runs: [
        ordinalRun("run-2", 2, "completed"),
        ordinalRun("run-1", 1, "completed"),
        ordinalRun("run-3", 3, "completed"),
      ],
      subagents: [
        subagent({ id: "a", runId: RunId.make("run-1") }),
        subagent({ id: "c", runId: RunId.make("run-3") }),
        subagent({ id: "b", runId: RunId.make("run-2") }),
        subagent({ id: "a2", runId: RunId.make("run-1") }),
      ],
    });

    expect(groups.map((group) => group.runId)).toEqual(["run-3", "run-2", "run-1"]);
    expect(groups.map((group) => group.subagents.length)).toEqual([1, 1, 2]);
  });

  it("orders agents newest-first inside each group", () => {
    const [group] = deriveThreadSubagentRunGroups({
      runs: [ordinalRun("run-1", 1, "completed")],
      subagents: [
        subagent({ id: "early", status: "completed", startedAt: at("2026-06-20T00:00:01.000Z") }),
        subagent({ id: "live", status: "running", startedAt: at("2026-06-20T00:00:00.000Z") }),
        subagent({ id: "late", status: "completed", startedAt: at("2026-06-20T00:00:05.000Z") }),
      ],
    });

    expect(group?.subagents.map((entry) => entry.id)).toEqual(["live", "late", "early"]);
    expect(group?.liveCount).toBe(1);
  });

  it("marks the active run as current even when a newer-ordinal run has no agents", () => {
    const groups = deriveThreadSubagentRunGroups({
      runs: [ordinalRun("run-1", 1, "running"), ordinalRun("run-2", 2, "completed")],
      subagents: [
        subagent({ id: "a", runId: RunId.make("run-1") }),
        subagent({ id: "b", runId: RunId.make("run-2") }),
      ],
    });

    expect(groups.map((group) => [group.runId, group.isCurrentRun])).toEqual([
      ["run-2", false],
      ["run-1", true],
    ]);
  });

  it("treats the latest run as current once nothing is active, and keeps older agents", () => {
    const groups = deriveThreadSubagentRunGroups({
      runs: [ordinalRun("run-1", 1, "completed"), ordinalRun("run-2", 2, "completed")],
      subagents: [subagent({ id: "old", status: "completed", runId: RunId.make("run-1") })],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.isCurrentRun).toBe(false);
  });

  it("keeps agents whose run is missing from the projection, after known runs", () => {
    const groups = deriveThreadSubagentRunGroups({
      runs: [ordinalRun("run-1", 1, "completed")],
      subagents: [
        subagent({ id: "orphan", runId: RunId.make("run-gone") }),
        subagent({ id: "known", runId: RunId.make("run-1") }),
      ],
    });

    expect(groups.map((group) => group.runId)).toEqual(["run-1", "run-gone"]);
    expect(groups[1]?.requestedAt).toBeNull();
  });

  it("keeps agents that were never attached to a run in a trailing group", () => {
    const groups = deriveThreadSubagentRunGroups({
      runs: [ordinalRun("run-1", 1, "running")],
      subagents: [
        subagent({ id: "detached", runId: null }),
        subagent({ id: "known", runId: RunId.make("run-1") }),
      ],
    });

    expect(groups.map((group) => group.runId)).toEqual(["run-1", null]);
    expect(groups[1]?.isCurrentRun).toBe(false);
  });
});

describe("resolveSubagentPillSegment", () => {
  it("shows how many of the turn's agents are still working", () => {
    const turn = deriveThreadTurnSubagents({
      runs: [activeRun],
      subagents: [
        subagent({ id: "a", status: "running" }),
        subagent({ id: "b", status: "waiting" }),
        subagent({ id: "c", status: "completed" }),
      ],
    });

    expect(resolveSubagentPillSegment(turn)).toEqual({
      label: "2/3",
      accessibilityLabel: "2 of 3 agents working",
    });
  });

  it("reports the finished roster while the turn is still running", () => {
    const turn = deriveThreadTurnSubagents({
      runs: [activeRun],
      subagents: [subagent({ id: "a", status: "completed" })],
    });

    expect(resolveSubagentPillSegment(turn)).toEqual({
      label: "1 done",
      accessibilityLabel: "1 agent done",
    });
  });

  it("hides itself once the turn is over and nothing is working", () => {
    const turn = deriveThreadTurnSubagents({
      runs: [finishedRun],
      subagents: [subagent({ id: "a", status: "completed" })],
    });

    expect(resolveSubagentPillSegment(turn)).toBeNull();
    expect(resolveSubagentPillSegment(null)).toBeNull();
  });

  it("stays visible after the turn ends while an agent is still working", () => {
    const turn = deriveThreadTurnSubagents({
      runs: [finishedRun],
      subagents: [subagent({ id: "a", status: "running" })],
    });

    expect(resolveSubagentPillSegment(turn)?.label).toBe("1/1");
  });
});
