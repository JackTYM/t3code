import type {
  OrchestrationLatestTurn,
  OrchestrationSession,
  OrchestrationThreadShell,
} from "@t3tools/contracts";

/**
 * What a thread is doing, in one vocabulary. Surfaces choose their own labels,
 * colors and icons, and skip the kinds they have no vocabulary for, but the
 * ranking itself lives here once: web, mobile and the widget/awareness path
 * had drifted into five ladders with five different answers.
 */
export type ThreadStatusKind =
  | "pending-approval"
  | "awaiting-input"
  | "working"
  | "connecting"
  | "failed"
  | "plan-ready"
  | "background-working"
  | "monitoring"
  | "completed";

/**
 * Only the signals every surface carries are required. A surface that has no
 * plan or background vocabulary simply omits those fields, and the rungs that
 * read them cannot match.
 */
export type ThreadStatusShell = Pick<
  OrchestrationThreadShell,
  "hasPendingApprovals" | "hasPendingUserInput" | "latestTurn" | "session"
> &
  Partial<
    Pick<
      OrchestrationThreadShell,
      | "hasBlockingUserInput"
      | "backgroundLiveness"
      | "hasActionableProposedPlan"
      | "interactionMode"
    >
  >;

export interface ResolveThreadStatusOptions {
  /**
   * Kinds this surface has no vocabulary for. A suppressed rung falls through
   * to the next one rather than ending the walk, which is how the widget keeps
   * reading a settled plan-ready thread as Done.
   */
  readonly suppress?: ReadonlySet<ThreadStatusKind>;
}

/**
 * A turn that started, finished, and is not being superseded by a live run.
 */
export function isLatestTurnSettled(
  latestTurn: Partial<OrchestrationLatestTurn> | null,
  session: Partial<OrchestrationSession> | null,
): boolean {
  if (!latestTurn?.startedAt) return false;
  if (!latestTurn.completedAt) return false;
  if (!session) return true;
  return session.status !== "running";
}

/**
 * A question the agent is blocked on, as opposed to one it asked while
 * carrying on. Servers that predate the distinction only report the combined
 * count, and there every question blocks.
 */
function hasBlockingUserInput(thread: ThreadStatusShell): boolean {
  return thread.hasBlockingUserInput ?? thread.hasPendingUserInput;
}

function isThreadCompleted(thread: ThreadStatusShell): boolean {
  if (thread.latestTurn?.state === "completed") return true;
  // A turn that finished can still read as "interrupted": session teardown
  // settles still-running turns by session status, and that write can race
  // turn.completed. completedAt survives the race.
  if (thread.latestTurn?.state === "interrupted" && thread.latestTurn.completedAt !== null) {
    return true;
  }
  // Threads whose turns never produce a checkpoint have no materialized
  // latestTurn at all, and the session-set projection clears latest_turn_id
  // once the session settles. A live session at ready/idle with nothing
  // pending and nothing running is then the only completion signal left.
  return thread.session?.status === "ready" || thread.session?.status === "idle";
}

/**
 * The single status ladder. Presentation stays per-surface; this decides which
 * rung a thread is on.
 */
export function resolveThreadStatusKind(
  thread: ThreadStatusShell,
  options: ResolveThreadStatusOptions = {},
): ThreadStatusKind | null {
  const suppressed = options.suppress;
  const rung = (kind: ThreadStatusKind, applies: boolean): ThreadStatusKind | null =>
    applies && suppressed?.has(kind) !== true ? kind : null;

  return (
    rung("pending-approval", thread.hasPendingApprovals) ??
    // A blocking question is raised mid-turn from inside a provider callback,
    // so the session is still "running" while the agent waits. It has to
    // outrank working or it would never be visible at all.
    rung("awaiting-input", hasBlockingUserInput(thread)) ??
    rung(
      "working",
      thread.session?.status === "running" || thread.latestTurn?.state === "running",
    ) ??
    rung("connecting", thread.session?.status === "starting") ??
    // An async question does not block the agent. It still needs somewhere to
    // show, but reporting it over a live run is the lie that made a working
    // thread read as "needs input".
    rung("awaiting-input", thread.hasPendingUserInput) ??
    rung("failed", thread.session?.status === "error" || thread.latestTurn?.state === "error") ??
    // An actionable plan prompt outranks lingering background work: it needs
    // the user's decision, while liveness merely reports.
    rung(
      "plan-ready",
      thread.interactionMode === "plan" &&
        isLatestTurnSettled(thread.latestTurn, thread.session) &&
        thread.hasActionableProposedPlan === true,
    ) ??
    // Reaching these rungs means the session is not running, so the turn has
    // settled and the work still alive is background (subagent fleets,
    // workflow runs, watch loops). That is a different claim from "the agent
    // is mid-turn": here the user is usually the one being waited on, and the
    // elapsed time belongs to the background agent, not to a turn. Surfaces
    // may still render both as "Working", but the ladder keeps them apart so
    // the distinction is available rather than flattened away.
    rung("background-working", thread.backgroundLiveness === "working") ??
    rung("monitoring", thread.backgroundLiveness === "monitoring") ??
    rung("completed", isThreadCompleted(thread))
  );
}
