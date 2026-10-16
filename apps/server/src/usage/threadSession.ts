/**
 * Maps a thread's provider binding to the transcript session it is writing,
 * so thread costs can be read from the same transcripts the usage page scans.
 *
 * @module threadSession
 */
import type { UsageProviderKind } from "@t3tools/contracts";

export interface TranscriptSessionRef {
  readonly provider: UsageProviderKind;
  readonly sessionId: string;
}

/** Ids end up in a path match, so reject anything that could match broadly. */
function usableSessionId(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9-]{8,}$/.test(value) ? value : null;
}

/**
 * Claude keeps its session id in the resume cursor's `resume`; Codex rollout
 * files end with the thread id the cursor carries. Other providers write no
 * transcripts the usage scan reads per thread, so they have no cost here.
 */
export function transcriptSessionOf(binding: {
  readonly provider: string;
  readonly resumeCursor?: unknown;
}): TranscriptSessionRef | null {
  const cursor =
    typeof binding.resumeCursor === "object" && binding.resumeCursor !== null
      ? (binding.resumeCursor as Record<string, unknown>)
      : null;
  if (cursor === null) return null;
  if (binding.provider === "claudeAgent") {
    const sessionId = usableSessionId(cursor.resume);
    return sessionId === null ? null : { provider: "claude", sessionId };
  }
  if (binding.provider === "codex") {
    const sessionId = usableSessionId(cursor.threadId);
    return sessionId === null ? null : { provider: "codex", sessionId };
  }
  return null;
}
