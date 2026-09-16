import { describe, expect, it } from "@effect/vitest";

import type { OrchestrationThreadShell, ThreadId, TurnId } from "@t3tools/contracts";

import { resolveThreadStatusKind, type ThreadStatusShell } from "./threadStatus.ts";

const NOW = "2026-05-22T12:00:00.000Z";

const runningSession = {
  threadId: "thread-1" as ThreadId,
  status: "running" as const,
  providerName: "Claude",
  runtimeMode: "full-access" as const,
  activeTurnId: "turn-1" as TurnId,
  lastError: null,
  updatedAt: NOW,
};

const readySession = { ...runningSession, status: "ready" as const, activeTurnId: null };

const settledTurn = {
  turnId: "turn-1" as TurnId,
  state: "completed" as const,
  requestedAt: NOW,
  startedAt: NOW,
  completedAt: NOW,
  assistantMessageId: null,
};

function thread(overrides: Partial<ThreadStatusShell> = {}): ThreadStatusShell {
  return {
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    interactionMode: "default" as OrchestrationThreadShell["interactionMode"],
    latestTurn: null,
    session: null,
    ...overrides,
  };
}

describe("resolveThreadStatusKind", () => {
  it("returns null for a quiescent thread", () => {
    expect(resolveThreadStatusKind(thread())).toBeNull();
  });

  it("ranks an approval above everything else", () => {
    expect(
      resolveThreadStatusKind(
        thread({ hasPendingApprovals: true, hasPendingUserInput: true, session: runningSession }),
      ),
    ).toBe("pending-approval");
  });

  it("keeps a blocking question above a running session", () => {
    // The provider raises it from inside a callback mid-turn, so the session is
    // still running while the agent waits. Ranking running first would delete
    // the awaiting-input state for every provider.
    expect(
      resolveThreadStatusKind(
        thread({
          hasPendingUserInput: true,
          hasBlockingUserInput: true,
          session: runningSession,
        }),
      ),
    ).toBe("awaiting-input");
  });

  it("reports a live run over an async question the agent did not stop for", () => {
    expect(
      resolveThreadStatusKind(
        thread({
          hasPendingUserInput: true,
          hasBlockingUserInput: false,
          session: runningSession,
        }),
      ),
    ).toBe("working");
  });

  it("still surfaces an async question once the run settles", () => {
    // It remains answerable by sending a message, so it must not vanish.
    expect(
      resolveThreadStatusKind(
        thread({
          hasPendingUserInput: true,
          hasBlockingUserInput: false,
          session: readySession,
          latestTurn: settledTurn,
        }),
      ),
    ).toBe("awaiting-input");
  });

  it("treats every pending question as blocking when the server does not report the split", () => {
    expect(
      resolveThreadStatusKind(thread({ hasPendingUserInput: true, session: runningSession })),
    ).toBe("awaiting-input");
  });

  it("separates background work from a live turn", () => {
    // Same label on most surfaces today, but a settled turn with a subagent
    // still alive is the user's move, not the agent's.
    expect(
      resolveThreadStatusKind(
        thread({
          session: readySession,
          latestTurn: settledTurn,
          backgroundLiveness: "working",
        }),
      ),
    ).toBe("background-working");
    expect(
      resolveThreadStatusKind(thread({ session: runningSession, backgroundLiveness: "working" })),
    ).toBe("working");
  });

  it("does not report a failed previous turn while a new run is live", () => {
    expect(
      resolveThreadStatusKind(
        thread({ session: runningSession, latestTurn: { ...settledTurn, state: "error" } }),
      ),
    ).toBe("working");
  });

  // The mirror of the case above, and the one that decides whether a thread
  // whose session died mid-turn still alerts: the turn row keeps reading
  // "running" forever, so an errored session has to outrank working.
  it("reports a failed session even while its turn row still reads running", () => {
    expect(
      resolveThreadStatusKind(
        thread({
          session: { ...runningSession, status: "error" as const },
          latestTurn: { ...settledTurn, state: "running", completedAt: null },
        }),
      ),
    ).toBe("failed");
  });

  it("falls through a suppressed rung instead of stopping the walk", () => {
    const planReady = thread({
      interactionMode: "plan" as OrchestrationThreadShell["interactionMode"],
      hasActionableProposedPlan: true,
      session: readySession,
      latestTurn: settledTurn,
    });

    expect(resolveThreadStatusKind(planReady)).toBe("plan-ready");
    // The widget has no plan vocabulary, so it must keep reading this as Done.
    expect(resolveThreadStatusKind(planReady, { suppress: new Set(["plan-ready"]) })).toBe(
      "completed",
    );
  });

  it("reads a ready session with no materialized turn as completed", () => {
    expect(resolveThreadStatusKind(thread({ session: readySession }))).toBe("completed");
  });

  it("reads a turn that teardown settled as interrupted as completed", () => {
    expect(
      resolveThreadStatusKind(thread({ latestTurn: { ...settledTurn, state: "interrupted" } })),
    ).toBe("completed");
    expect(
      resolveThreadStatusKind(
        thread({ latestTurn: { ...settledTurn, state: "interrupted", completedAt: null } }),
      ),
    ).toBeNull();
  });
});
