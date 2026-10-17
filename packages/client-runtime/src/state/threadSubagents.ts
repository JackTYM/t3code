import * as DateTime from "effect/DateTime";
import type { OrchestrationV2Subagent, OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import { copySorted } from "@t3tools/shared/Array";

import {
  compareAgentsNewestFirst,
  isActiveSubagentStatus,
  isTerminalSubagentStatus,
  type AgentOrderKeys,
} from "./subagentRuntime.ts";
import { resolveActiveThreadRun } from "./threadWorkflows.ts";

type Projection = OrchestrationV2ThreadProjection;
type Subagent = OrchestrationV2Subagent;
type Run = Projection["runs"][number];
type RunId = Run["id"];

export interface ThreadTurnSubagents {
  readonly runId: RunId | null;
  readonly turnActive: boolean;
  readonly subagents: ReadonlyArray<Subagent>;
  readonly liveCount: number;
  readonly settledCount: number;
}

export interface ThreadSubagentRunGroup {
  readonly runId: RunId | null;
  /** The turn the live pill describes: the active run, else the thread's latest. */
  readonly isCurrentRun: boolean;
  readonly requestedAt: Run["requestedAt"] | null;
  readonly subagents: ReadonlyArray<Subagent>;
  readonly liveCount: number;
}

export interface SubagentPillSegment {
  readonly label: string;
  readonly accessibilityLabel: string;
}

function orderKeys(subagent: Subagent): AgentOrderKeys {
  return {
    id: subagent.id,
    status: subagent.status,
    firstSeenAt: DateTime.formatIso(subagent.startedAt ?? subagent.updatedAt),
    updatedAt: DateTime.formatIso(subagent.updatedAt),
    completedAt: subagent.completedAt === null ? null : DateTime.formatIso(subagent.completedAt),
  };
}

export function deriveThreadTurnSubagents(
  projection: Pick<Projection, "runs" | "subagents">,
): ThreadTurnSubagents | null {
  if (projection.subagents.length === 0) return null;
  const activeRun = resolveActiveThreadRun(projection);
  const latestUpdated = projection.subagents.reduce((latest, subagent) =>
    DateTime.toEpochMillis(subagent.updatedAt) > DateTime.toEpochMillis(latest.updatedAt)
      ? subagent
      : latest,
  );
  const runId = activeRun?.id ?? latestUpdated.runId;
  const subagents = copySorted(
    projection.subagents.filter((subagent) => subagent.runId === runId),
    (left, right) => compareAgentsNewestFirst(orderKeys(left), orderKeys(right)),
  );
  if (subagents.length === 0) return null;

  let liveCount = 0;
  let settledCount = 0;
  for (const subagent of subagents) {
    if (isActiveSubagentStatus(subagent.status)) liveCount += 1;
    else if (isTerminalSubagentStatus(subagent.status)) settledCount += 1;
  }
  return { runId, turnActive: activeRun !== null, subagents, liveCount, settledCount };
}

/**
 * Every agent the thread has spawned, grouped by run with the newest run first.
 * Unlike `deriveThreadTurnSubagents` this is not scoped to one turn, so settled
 * agents from earlier runs stay reachable.
 */
export function deriveThreadSubagentRunGroups(
  projection: Pick<Projection, "runs" | "subagents">,
): ReadonlyArray<ThreadSubagentRunGroup> {
  if (projection.subagents.length === 0) return [];
  const runsById = new Map(projection.runs.map((run) => [run.id, run]));
  const currentRunId = (
    resolveActiveThreadRun(projection) ??
    projection.runs.reduce<Run | null>(
      (latest, run) => (latest === null || run.ordinal > latest.ordinal ? run : latest),
      null,
    )
  )?.id;

  const runOf = (runId: RunId | null) => (runId === null ? undefined : runsById.get(runId));
  const byRun = new Map<RunId | null, Subagent[]>();
  for (const subagent of projection.subagents) {
    const group = byRun.get(subagent.runId);
    if (group === undefined) byRun.set(subagent.runId, [subagent]);
    else group.push(subagent);
  }

  return copySorted(
    [...byRun.entries()],
    // An agent with no known run sorts last rather than being dropped.
    ([left], [right]) => (runOf(right)?.ordinal ?? 0) - (runOf(left)?.ordinal ?? 0),
  ).map(([runId, agents]) => {
    const subagents = copySorted(agents, (left, right) =>
      compareAgentsNewestFirst(orderKeys(left), orderKeys(right)),
    );
    return {
      runId,
      isCurrentRun: runId !== null && runId === currentRunId,
      requestedAt: runOf(runId)?.requestedAt ?? null,
      subagents,
      liveCount: subagents.filter((subagent) => isActiveSubagentStatus(subagent.status)).length,
    };
  });
}

export function resolveSubagentPillSegment(
  turn: ThreadTurnSubagents | null,
): SubagentPillSegment | null {
  if (turn === null) return null;
  if (!turn.turnActive && turn.liveCount === 0) return null;
  const total = turn.subagents.length;
  if (turn.liveCount > 0) {
    return {
      label: `${turn.liveCount}/${total}`,
      accessibilityLabel: `${turn.liveCount} of ${total} agents working`,
    };
  }
  return {
    label: `${total} done`,
    accessibilityLabel: `${total} ${total === 1 ? "agent" : "agents"} done`,
  };
}
