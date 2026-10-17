import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as UsageService from "./UsageService.ts";
import * as UsageThreadCosts from "./UsageThreadCosts.ts";

const claudeSession = "623dde97-20fd-4920-93d5-e216a8861377";
const codexSession = "01a0f087-e1c1-7500-8184-6db10ed70fac";

const providerThread = (driver: string, nativeId: string | null) => ({
  driver: ProviderDriverKind.make(driver),
  nativeThreadRef:
    nativeId === null
      ? null
      : { driver: ProviderDriverKind.make(driver), nativeId, strength: "strong" as const },
});

describe("transcriptSessionOf", () => {
  it("reads Claude's and Codex's native thread ids", () => {
    assert.deepStrictEqual(
      UsageThreadCosts.transcriptSessionOf(providerThread("claudeAgent", claudeSession)),
      { provider: "claude", sessionId: claudeSession },
    );
    assert.deepStrictEqual(
      UsageThreadCosts.transcriptSessionOf(providerThread("codex", codexSession)),
      { provider: "codex", sessionId: codexSession },
    );
  });

  it("has no session without a usable id or for other providers", () => {
    assert.isNull(UsageThreadCosts.transcriptSessionOf(providerThread("claudeAgent", null)));
    assert.isNull(UsageThreadCosts.transcriptSessionOf(providerThread("claudeAgent", "../x")));
    assert.isNull(UsageThreadCosts.transcriptSessionOf(providerThread("opencode", claudeSession)));
  });
});

describe("UsageThreadCostsService", () => {
  it.effect("sums a thread's sessions and omits threads it cannot price or load", () =>
    Effect.gen(function* () {
      const priced = ThreadId.make("thread-priced");
      const unreadable = ThreadId.make("thread-unreadable");
      const requested: Array<ReadonlyArray<UsageService.SessionCostRequest>> = [];
      const layer = UsageThreadCosts.layer.pipe(
        Layer.provide(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadRecords: (threadId: ThreadId) =>
              threadId === priced
                ? Effect.succeed({
                    providerThreads: [
                      providerThread("claudeAgent", claudeSession),
                      providerThread("codex", codexSession),
                    ],
                  } as never)
                : Effect.fail(new ProjectionStore.ProjectionStoreThreadNotFoundError({ threadId })),
          }),
        ),
        Layer.provide(
          Layer.mock(UsageService.UsageService)({
            readSessionCosts: (sessions) => {
              requested.push(sessions);
              return Effect.succeed([{ key: priced, costUsd: 1.5, costSource: "modelPriced" }]);
            },
          }),
        ),
      );

      const result = yield* UsageThreadCosts.UsageThreadCostsService.use((service) =>
        service.read({ threadIds: [priced, unreadable, priced] }),
      ).pipe(Effect.provide(layer));

      assert.deepStrictEqual(result.costs, [
        { threadId: priced, costUsd: 1.5, costSource: "modelPriced" },
      ]);
      assert.deepStrictEqual(requested[0], [
        { key: priced, provider: "claude", sessionId: claudeSession },
        { key: priced, provider: "codex", sessionId: codexSession },
      ]);
    }),
  );
});
