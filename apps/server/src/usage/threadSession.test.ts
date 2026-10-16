import { describe, expect, it } from "vite-plus/test";

import { transcriptSessionOf } from "./threadSession.ts";

describe("transcriptSessionOf", () => {
  it("reads Claude's resume id and Codex's thread id", () => {
    expect(
      transcriptSessionOf({
        provider: "claudeAgent",
        resumeCursor: { threadId: "t", resume: "623dde97-20fd-4920-93d5-e216a8861377" },
      }),
    ).toEqual({ provider: "claude", sessionId: "623dde97-20fd-4920-93d5-e216a8861377" });
    expect(
      transcriptSessionOf({
        provider: "codex",
        resumeCursor: { threadId: "01a0f087-e1c1-7500-8184-6db10ed70fac" },
      }),
    ).toEqual({ provider: "codex", sessionId: "01a0f087-e1c1-7500-8184-6db10ed70fac" });
  });

  it("has no session without a usable id or for other providers", () => {
    expect(transcriptSessionOf({ provider: "claudeAgent", resumeCursor: { threadId: "t" } })).toBe(
      null,
    );
    expect(transcriptSessionOf({ provider: "claudeAgent", resumeCursor: { resume: "../x" } })).toBe(
      null,
    );
    expect(transcriptSessionOf({ provider: "claudeAgent" })).toBe(null);
    expect(
      transcriptSessionOf({ provider: "grok", resumeCursor: { resume: "abcdef12-3456" } }),
    ).toBe(null);
  });
});
