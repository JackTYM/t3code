import type {
  RelayAgentActivityAggregateRow,
  RelayAgentActivityAggregateState,
  RelayAgentActivityState,
} from "@t3tools/contracts/relay";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import {
  isAbandonedAgentActivityState,
  isExpiredAgentActivityState,
  isTerminalPhase,
  MAX_ACTIVITY_ROWS,
  sanitizeAgentActivityAggregateState,
} from "./agentActivityPayloads.ts";

export function statusForPhase(phase: RelayAgentActivityState["phase"]): string {
  switch (phase) {
    case "waiting_for_approval":
      return "Approval";
    case "waiting_for_input":
      return "Input";
    case "completed":
      return "Done";
    case "failed":
      return "Failed";
    case "starting":
      // Matches the web sidebar's pill wording (Sidebar.logic.ts) so the same
      // thread reads the same across surfaces.
      return "Connecting";
    case "running":
      return "Working";
    case "stale":
      return "Waiting";
  }
}

function aggregateRowForState(state: RelayAgentActivityState) {
  return {
    environmentId: state.environmentId,
    threadId: state.threadId,
    projectTitle: state.projectTitle,
    threadTitle: state.threadTitle,
    modelTitle: state.modelTitle,
    phase: state.phase,
    status: statusForPhase(state.phase),
    updatedAt: state.updatedAt,
    deepLink: state.deepLink,
  };
}

function terminalAggregateState(
  state: RelayAgentActivityState,
  trailingRows: ReadonlyArray<RelayAgentActivityAggregateRow> = [],
): RelayAgentActivityAggregateState {
  return sanitizeAgentActivityAggregateState({
    title: "T3 Code",
    subtitle: state.phase === "failed" ? "Agent work failed" : "Agent work completed",
    activeCount: 0,
    updatedAt: state.updatedAt,
    activities: [aggregateRowForState(state), ...trailingRows],
  });
}

// How long a finished thread keeps its Done/Failed row in the aggregate while
// other agents are still active. Long enough to be seen on the lock screen,
// short enough that the activity list stays about live work.
export const TERMINAL_AGENT_ACTIVITY_DISPLAY_TTL_MS = 15 * 60 * 1_000;

function isRecentTerminalState(state: RelayAgentActivityState, nowMs: number): boolean {
  if (!isTerminalPhase(state)) {
    return false;
  }
  const updatedAtMs = Option.match(DateTime.make(state.updatedAt), {
    onNone: () => Number.NaN,
    onSome: (dt) => dt.epochMilliseconds,
  });
  if (Number.isNaN(updatedAtMs)) {
    return false;
  }
  return nowMs - updatedAtMs <= TERMINAL_AGENT_ACTIVITY_DISPLAY_TTL_MS;
}

// Past its TTL a row no longer counts as live work, but until it is abandoned
// outright it is still shown, as `stale`. Its own phase is left alone in
// storage; staleness is a property of how long ago we heard from the
// environment, not of what the environment last said.
function staleAggregateRowForState(state: RelayAgentActivityState) {
  return {
    ...aggregateRowForState(state),
    phase: "stale" as const,
    status: statusForPhase("stale"),
  };
}

export function makeAggregateState(input: {
  readonly activeStates: ReadonlyArray<RelayAgentActivityState>;
  readonly terminalState: RelayAgentActivityState | null;
  readonly nowMs: number;
}): RelayAgentActivityAggregateState | null {
  const nonTerminalStates = input.activeStates.filter((state) => !isTerminalPhase(state));
  const activeStates = nonTerminalStates.filter(
    (state) => !isExpiredAgentActivityState(state, input.nowMs),
  );
  // Aged-out rows ride along behind whatever else the card has to say. They
  // never lead: a row we have merely lost touch with must not displace a fresh
  // completion, whose position drives the notification and alert paths.
  const staleRows = nonTerminalStates
    .filter(
      (state) =>
        isExpiredAgentActivityState(state, input.nowMs) &&
        !isAbandonedAgentActivityState(state, input.nowMs),
    )
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(staleAggregateRowForState);
  const recentTerminalStates = input.activeStates
    .filter((state) => isRecentTerminalState(state, input.nowMs))
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  if (activeStates.length === 0) {
    if (input.terminalState !== null) {
      return terminalAggregateState(input.terminalState, staleRows);
    }
    // With no live work, recently finished threads keep the card showing
    // Done/Failed content (an armed card never renders an empty state). The
    // newly-terminal alert rules key off the previously delivered aggregate,
    // so replays repaint this without buzzing. Once the terminal rows age
    // out, the aggregate is null and the delivery layer ends the card.
    const newest = recentTerminalStates[0];
    if (!newest) {
      const newestStale = staleRows[0];
      if (!newestStale) {
        return null;
      }
      // Nothing is provably live, but a thread we have only lost contact with
      // is not a finished one. Saying so keeps the card honest instead of
      // ending it, or handing it to an unrelated terminal row as a confident
      // "Done" laid over work that may well still be running.
      return sanitizeAgentActivityAggregateState({
        title: "T3 Code",
        subtitle: "Waiting for an update",
        activeCount: 0,
        updatedAt: newestStale.updatedAt,
        activities: staleRows,
      });
    }
    return sanitizeAgentActivityAggregateState({
      title: "T3 Code",
      subtitle: newest.phase === "failed" ? "Agent work failed" : "Agent work completed",
      activeCount: 0,
      updatedAt: newest.updatedAt,
      activities: [...recentTerminalStates.map(aggregateRowForState), ...staleRows],
    });
  }
  // Recently finished threads ride along after the active ones (display slots
  // permitting) so a completion is visible as Done/Failed instead of the row
  // silently vanishing while other agents keep the activity alive.
  const displayedRows = [
    ...activeStates
      .toSorted((a, b) => activityPhasePriority(a.phase) - activityPhasePriority(b.phase))
      .slice(0, MAX_ACTIVITY_ROWS)
      .map(aggregateRowForState),
    ...recentTerminalStates.map(aggregateRowForState),
    ...staleRows,
  ];
  const updatedAt = [...activeStates, ...recentTerminalStates].reduce((latest, state) =>
    state.updatedAt.localeCompare(latest.updatedAt) > 0 ? state : latest,
  ).updatedAt;
  return sanitizeAgentActivityAggregateState({
    title: "T3 Code",
    subtitle: "Agent work in progress",
    activeCount: activeStates.length,
    updatedAt,
    activities: displayedRows,
  });
}

export function activityPhasePriority(phase: RelayAgentActivityState["phase"]): number {
  if (phase === "waiting_for_approval" || phase === "waiting_for_input") return 0;
  if (phase === "failed") return 1;
  if (phase === "starting" || phase === "running") return 2;
  return 3;
}
