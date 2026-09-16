import { describe, expect, it } from "vite-plus/test";
import * as ThreadBackgroundLiveness from "./ThreadBackgroundLiveness.ts";

describe("ThreadBackgroundLiveness", () => {
  it("does not let status-free progress or metadata restart an idle task", () => {
    const liveness = ThreadBackgroundLiveness.make();
    liveness.recordTaskLiveness({
      threadId: "thread",
      taskId: "task",
      taskType: undefined,
      status: undefined,
      kind: "started",
    });
    liveness.recordTaskLiveness({
      threadId: "thread",
      taskId: "task",
      taskType: undefined,
      status: "idle",
      kind: "updated",
    });
    liveness.recordTaskLiveness({
      threadId: "thread",
      taskId: "task",
      taskType: undefined,
      status: undefined,
      kind: "progress",
    });
    liveness.recordTaskLiveness({
      threadId: "thread",
      taskId: "task",
      taskType: undefined,
      status: undefined,
      kind: "updated",
    });
    expect(liveness.getThreadBackgroundLiveness("thread")).toBeNull();

    liveness.recordTaskLiveness({
      threadId: "thread",
      taskId: "completed-task",
      taskType: undefined,
      status: undefined,
      kind: "started",
    });
    liveness.recordTaskLiveness({
      threadId: "thread",
      taskId: "completed-task",
      taskType: undefined,
      status: "completed",
      kind: "completed",
    });
    liveness.recordTaskLiveness({
      threadId: "thread",
      taskId: "completed-task",
      taskType: undefined,
      status: undefined,
      kind: "updated",
    });
    expect(liveness.getThreadBackgroundLiveness("thread")).toBeNull();
  });

  it("agents present as working; monitors as monitoring; agents win", () => {
    const liveness = ThreadBackgroundLiveness.make();
    const threadId = "t-live-1";
    liveness.recordTaskLiveness({
      threadId,
      taskId: "m1",
      taskType: "local_bash",
      status: undefined,
      kind: "started",
    });
    expect(liveness.getThreadBackgroundLiveness(threadId)).toBe("monitoring");
    liveness.recordTaskLiveness({
      threadId,
      taskId: "a1",
      taskType: "subagent",
      status: undefined,
      kind: "started",
    });
    expect(liveness.getThreadBackgroundLiveness(threadId)).toBe("working");
    liveness.recordTaskLiveness({
      threadId,
      taskId: "a1",
      taskType: "subagent",
      status: "completed",
      kind: "completed",
    });
    expect(liveness.getThreadBackgroundLiveness(threadId)).toBe("monitoring");
    liveness.recordTaskLiveness({
      threadId,
      taskId: "m1",
      taskType: "local_bash",
      status: "completed",
      kind: "completed",
    });
    expect(liveness.getThreadBackgroundLiveness(threadId)).toBeNull();
  });

  it("terminal rows without a taskType still clear monitor entries", () => {
    const liveness = ThreadBackgroundLiveness.make();
    const threadId = "t-live-2";
    liveness.recordTaskLiveness({
      threadId,
      taskId: "m1",
      taskType: "local_bash",
      status: undefined,
      kind: "started",
    });
    // Terminal tick arrives with no taskType (common on task.completed).
    liveness.recordTaskLiveness({
      threadId,
      taskId: "m1",
      taskType: undefined,
      status: "completed",
      kind: "completed",
    });
    expect(liveness.getThreadBackgroundLiveness(threadId)).toBeNull();
  });

  it("nested agents (agentId + agent taskType) still count toward liveness", () => {
    const liveness = ThreadBackgroundLiveness.make();
    const threadId = "t-live-nested";
    liveness.recordTaskLiveness({
      threadId,
      taskId: "n1",
      taskType: "local_agent",
      status: undefined,
      kind: "started",
      agentId: "owner",
    });
    expect(liveness.getThreadBackgroundLiveness(threadId)).toBe("working");
    liveness.recordTaskLiveness({
      threadId,
      taskId: "n1",
      taskType: "local_agent",
      status: "completed",
      kind: "completed",
      agentId: "owner",
    });
    expect(liveness.getThreadBackgroundLiveness(threadId)).toBeNull();
  });

  it("untyped rows count as agents; idle is not live; agent-owned tasks are ignored", () => {
    const liveness = ThreadBackgroundLiveness.make();
    const threadId = "t-live-3";
    liveness.recordTaskLiveness({
      threadId,
      taskId: "wf:1",
      taskType: undefined,
      status: "running",
      kind: "progress",
    });
    expect(liveness.getThreadBackgroundLiveness(threadId)).toBe("working");
    liveness.recordTaskLiveness({
      threadId,
      taskId: "wf:1",
      taskType: undefined,
      status: "idle",
      kind: "updated",
    });
    expect(liveness.getThreadBackgroundLiveness(threadId)).toBeNull();
    liveness.recordTaskLiveness({
      threadId,
      taskId: "sh:1",
      taskType: "local_bash",
      status: undefined,
      kind: "started",
      agentId: "owner",
    });
    expect(liveness.getThreadBackgroundLiveness(threadId)).toBeNull();
  });

  it("reclassification moves a task between buckets instead of duplicating it", () => {
    const liveness = ThreadBackgroundLiveness.make();
    const threadId = "t-live-reclass";
    // First seen without a taskType: counts as an agent.
    liveness.recordTaskLiveness({
      threadId,
      taskId: "x1",
      taskType: undefined,
      status: "running",
      kind: "started",
    });
    expect(liveness.getThreadBackgroundLiveness(threadId)).toBe("working");
    // Later transition reveals it's a shell: downgrade to monitoring, not
    // a stale duplicate pinning "working".
    liveness.recordTaskLiveness({
      threadId,
      taskId: "x1",
      taskType: "local_bash",
      status: "running",
      kind: "progress",
    });
    expect(liveness.getThreadBackgroundLiveness(threadId)).toBe("monitoring");
    // Turning out to be inert or agent-owned drops the prior entry too.
    liveness.recordTaskLiveness({
      threadId,
      taskId: "x1",
      taskType: "local_bash",
      status: "running",
      kind: "progress",
      agentId: "owner",
    });
    expect(liveness.getThreadBackgroundLiveness(threadId)).toBeNull();
  });

  it("plan tasks are inert; clear removes everything; instances are isolated", () => {
    const a = ThreadBackgroundLiveness.make();
    const b = ThreadBackgroundLiveness.make();
    a.recordTaskLiveness({
      threadId: "t",
      taskId: "p1",
      taskType: "plan",
      status: undefined,
      kind: "started",
    });
    expect(a.getThreadBackgroundLiveness("t")).toBeNull();
    a.recordTaskLiveness({
      threadId: "t",
      taskId: "a1",
      taskType: "local_workflow",
      status: undefined,
      kind: "started",
    });
    expect(a.getThreadBackgroundLiveness("t")).toBe("working");
    expect(b.getThreadBackgroundLiveness("t")).toBeNull();
    a.clearThreadLiveness("t");
    expect(a.getThreadBackgroundLiveness("t")).toBeNull();
  });
});

describe("ThreadBackgroundLiveness elapsed start", () => {
  const start = (
    liveness: ReturnType<typeof ThreadBackgroundLiveness.make>,
    taskId: string,
    occurredAt: string,
  ) =>
    liveness.recordTaskLiveness({
      threadId: "thread",
      taskId,
      taskType: "subagent",
      status: "running",
      kind: "started",
      occurredAt,
    });

  it("stamps the stretch once, not each task", () => {
    const liveness = ThreadBackgroundLiveness.make();
    start(liveness, "task-1", "2026-05-22T12:00:00.000Z");
    start(liveness, "task-2", "2026-05-22T12:05:00.000Z");

    // A second agent joining must not restart the clock.
    expect(liveness.getThreadBackgroundLivenessState("thread")).toEqual({
      liveness: "working",
      since: "2026-05-22T12:00:00.000Z",
    });
  });

  it("starts a new stretch when background work resumes after going quiet", () => {
    const liveness = ThreadBackgroundLiveness.make();
    start(liveness, "task-1", "2026-05-22T12:00:00.000Z");
    liveness.recordTaskLiveness({
      threadId: "thread",
      taskId: "task-1",
      taskType: "subagent",
      status: "completed",
      kind: "completed",
      occurredAt: "2026-05-22T12:01:00.000Z",
    });
    expect(liveness.getThreadBackgroundLivenessState("thread")).toEqual({
      liveness: null,
      since: null,
    });

    start(liveness, "task-2", "2026-05-22T12:30:00.000Z");
    expect(liveness.getThreadBackgroundLivenessState("thread")).toEqual({
      liveness: "working",
      since: "2026-05-22T12:30:00.000Z",
    });
  });

  it("reports no start for a thread with no live background work", () => {
    const liveness = ThreadBackgroundLiveness.make();
    // What every thread looks like after a restart: the registry is empty, so
    // there is no elapsed time to show rather than a made-up one.
    expect(liveness.getThreadBackgroundLivenessState("thread")).toEqual({
      liveness: null,
      since: null,
    });
  });

  it("reports liveness without a start when the stretch had no timestamp", () => {
    const liveness = ThreadBackgroundLiveness.make();
    liveness.recordTaskLiveness({
      threadId: "thread",
      taskId: "task-1",
      taskType: "subagent",
      status: "running",
      kind: "started",
    });
    expect(liveness.getThreadBackgroundLivenessState("thread")).toEqual({
      liveness: "working",
      since: null,
    });
  });
});
