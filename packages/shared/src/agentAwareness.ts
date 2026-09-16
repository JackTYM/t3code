import type {
  EnvironmentId,
  OrchestrationProjectShell,
  OrchestrationThreadShell,
  ThreadId,
} from "@t3tools/contracts";

import {
  resolveThreadStatusKind,
  type ThreadStatusKind,
  type ThreadStatusShell,
} from "./threadStatus.ts";

export type AgentAwarenessPhase =
  | "starting"
  | "running"
  | "waiting_for_approval"
  | "waiting_for_input"
  | "completed"
  | "failed"
  | "stale";

export interface AgentAwarenessState {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectTitle: string;
  readonly threadTitle: string;
  readonly phase: AgentAwarenessPhase;
  readonly headline: string;
  readonly detail?: string;
  readonly modelTitle: string;
  readonly updatedAt: string;
  readonly deepLink: string;
}

export interface ProjectThreadAwarenessInput {
  readonly environmentId: EnvironmentId;
  readonly project: Pick<OrchestrationProjectShell, "title">;
  readonly thread: ThreadStatusShell &
    Pick<
      OrchestrationThreadShell,
      | "id"
      | "title"
      | "modelSelection"
      | "updatedAt"
      | "archivedAt"
      | "settledOverride"
      | "snoozedUntil"
    >;
  /** Resolves snooze windows. */
  readonly now: string;
}

function buildAgentAwarenessDeepLink(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}): string {
  return `/threads/${encodeURIComponent(input.environmentId)}/${encodeURIComponent(input.threadId)}`;
}

/**
 * The awareness roster is the active inbox, not every thread the environment
 * has ever held. A thread the user has put away has nothing to announce: its
 * session went ready long ago, so without this it resolves to "completed" and
 * the card shows a permanent Done row (and inflates the header counts) for
 * work that was filed away weeks earlier.
 *
 * Snooze is the one reversible case: it hides a thread until its wake time,
 * but an agent blocked ON the user outranks that, matching the raised-hand
 * rule the clients already apply to the inbox.
 */
function isThreadParkedForAwareness(
  thread: ProjectThreadAwarenessInput["thread"],
  phase: AgentAwarenessPhase,
  now: string,
): boolean {
  if (thread.archivedAt !== null) return true;
  if (thread.settledOverride === "settled") return true;
  if (thread.snoozedUntil == null) return false;
  const wakeAtMs = Date.parse(thread.snoozedUntil);
  // Malformed data never hides a thread.
  if (Number.isNaN(wakeAtMs) || wakeAtMs <= Date.parse(now)) return false;
  return phase !== "waiting_for_approval" && phase !== "waiting_for_input";
}

export function projectThreadAwareness(
  input: ProjectThreadAwarenessInput,
): AgentAwarenessState | null {
  const { environmentId, project, thread } = input;
  const phase = resolveThreadAwarenessPhase(thread);
  if (!phase) {
    return null;
  }
  if (isThreadParkedForAwareness(thread, phase, input.now)) {
    return null;
  }

  const detail = detailForPhase(phase, thread);
  return {
    environmentId,
    threadId: thread.id,
    projectTitle: project.title,
    threadTitle: thread.title,
    phase,
    headline: headlineForPhase(phase),
    ...(detail === undefined ? {} : { detail }),
    modelTitle: thread.modelSelection.model,
    updatedAt: thread.updatedAt,
    deepLink: buildAgentAwarenessDeepLink({ environmentId, threadId: thread.id }),
  };
}

// The widget has no vocabulary for plans or background work, so those rungs
// fall through and the thread keeps reading as Done, exactly as before.
const AWARENESS_SUPPRESSED_KINDS: ReadonlySet<ThreadStatusKind> = new Set([
  "plan-ready",
  "background-working",
  "monitoring",
]);

function resolveThreadAwarenessPhase(
  thread: ProjectThreadAwarenessInput["thread"],
): AgentAwarenessPhase | null {
  const kind = resolveThreadStatusKind(thread, { suppress: AWARENESS_SUPPRESSED_KINDS });
  switch (kind) {
    case "pending-approval":
      return "waiting_for_approval";
    case "awaiting-input":
      return "waiting_for_input";
    case "working":
      return "running";
    case "connecting":
      return "starting";
    case "failed":
      return "failed";
    case "completed":
      return "completed";
    default:
      return null;
  }
}

function headlineForPhase(phase: AgentAwarenessPhase): string {
  switch (phase) {
    case "starting":
      return "Starting agent";
    case "running":
      return "Agent is working";
    case "waiting_for_approval":
      return "Approval needed";
    case "waiting_for_input":
      return "Waiting for input";
    case "completed":
      return "Agent finished";
    case "failed":
      return "Agent failed";
    case "stale":
      return "Update delayed";
  }
}

function detailForPhase(
  phase: AgentAwarenessPhase,
  thread: ProjectThreadAwarenessInput["thread"],
): string | undefined {
  if (phase === "failed") {
    return thread.session?.lastError ?? undefined;
  }
  if (phase === "completed") {
    return "Review the completed task.";
  }
  if (phase === "running" && thread.session?.providerName) {
    return `${thread.session.providerName} is active.`;
  }
  return undefined;
}
