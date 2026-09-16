import type { StatusTone } from "../../components/StatusPill";
import { resolveThreadStatusKind } from "@t3tools/shared/threadStatus";
import { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

export type ThreadStatusKind =
  | "pending-approval"
  | "awaiting-input"
  | "working"
  | "connecting"
  | "error"
  | "plan-ready"
  | "monitoring";

export interface ThreadStatusPresentation extends StatusTone {
  readonly kind: ThreadStatusKind;
  /** Foreground color for the leading status icon. */
  readonly iconColor: string;
  /** Background color for the leading status icon circle. */
  readonly iconBackground: string;
  /** Whether the indicator represents in-flight activity. */
  readonly pulse: boolean;
}

/**
 * Presentation for the shared status ladder. Returns `null` for quiescent
 * threads, and for the kinds this list has no chip for, so rows stay free of
 * "Idle"-style noise.
 */
export function resolveThreadStatus(
  thread: EnvironmentThreadShell,
): ThreadStatusPresentation | null {
  switch (resolveThreadStatusKind(thread)) {
    case "pending-approval":
      return {
        kind: "pending-approval",
        label: "Needs Approval",
        pillClassName: "bg-warning",
        textClassName: "text-warning-foreground",
        iconColor: "#ff9f0a",
        iconBackground: "rgba(255,159,10,0.22)",
        pulse: false,
      };
    case "awaiting-input":
      return {
        kind: "awaiting-input",
        label: "Awaiting Input",
        pillClassName: "bg-primary/10",
        textClassName: "text-foreground-secondary",
        iconColor: "#5e5ce6",
        iconBackground: "rgba(94,92,230,0.22)",
        pulse: false,
      };
    case "working":
    // The turn has settled and only background work (subagents, workflows)
    // is alive. Same chip as a live turn, as on web.
    case "background-working":
      return {
        kind: "working",
        label: "Working",
        pillClassName: "bg-primary/10",
        textClassName: "text-adaptive-sky-600-400",
        iconColor: "#0a84ff",
        iconBackground: "rgba(10,132,255,0.22)",
        pulse: true,
      };
    case "connecting":
      return {
        kind: "connecting",
        label: "Connecting",
        pillClassName: "bg-primary/10",
        textClassName: "text-foreground-secondary",
        iconColor: "#0a84ff",
        iconBackground: "rgba(10,132,255,0.22)",
        pulse: true,
      };
    case "failed":
      return {
        kind: "error",
        label: "Error",
        pillClassName: "bg-danger",
        textClassName: "text-danger-foreground",
        iconColor: "#ff453a",
        iconBackground: "rgba(255,69,58,0.22)",
        pulse: false,
      };
    case "plan-ready":
      return {
        kind: "plan-ready",
        label: "Plan Ready",
        pillClassName: "bg-primary/10",
        textClassName: "text-foreground-secondary",
        iconColor: "#bf5af2",
        iconBackground: "rgba(191,90,242,0.22)",
        pulse: false,
      };
    // Watch loops are the only live work: reported, but not in motion, so it
    // shares working's hue without the pulse.
    case "monitoring":
      return {
        kind: "monitoring",
        label: "Monitoring",
        pillClassName: "bg-primary/10",
        textClassName: "text-adaptive-sky-600-400",
        iconColor: "#0a84ff",
        iconBackground: "rgba(10,132,255,0.22)",
        pulse: false,
      };
    // Completion has no chip on this list.
    default:
      return null;
  }
}
