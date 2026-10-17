import {
  ThreadId,
  type OrchestrationV2ProviderThread,
  type UsageProviderKind,
  type UsageThreadCosts,
  type UsageThreadCostsInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as UsageService from "./UsageService.ts";

// Claude's native thread id is its session id and Codex's is the id its rollout
// file name ends with, so both locate a transcript by path. Other providers
// either write no per-thread transcript or name files in ways not verified.
const TRANSCRIPT_PROVIDERS: Readonly<Record<string, UsageProviderKind>> = {
  claudeAgent: "claude",
  codex: "codex",
};

/** Ids end up in a path match, so reject anything that could match broadly. */
const USABLE_SESSION_ID = /^[A-Za-z0-9-]{8,}$/;

export function transcriptSessionOf(
  providerThread: Pick<OrchestrationV2ProviderThread, "driver" | "nativeThreadRef">,
): { readonly provider: UsageProviderKind; readonly sessionId: string } | null {
  const provider = TRANSCRIPT_PROVIDERS[providerThread.driver];
  const sessionId = providerThread.nativeThreadRef?.nativeId;
  if (provider === undefined || sessionId == null || !USABLE_SESSION_ID.test(sessionId)) {
    return null;
  }
  return { provider, sessionId };
}

export class UsageThreadCostsService extends Context.Service<
  UsageThreadCostsService,
  {
    /**
     * What each thread's provider sessions have cost. A thread that switched
     * providers sums every session it ran. Threads with no readable transcript
     * are omitted.
     */
    readonly read: (input: UsageThreadCostsInput) => Effect.Effect<UsageThreadCosts>;
  }
>()("t3/usage/UsageThreadCosts/UsageThreadCostsService") {}

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const usage = yield* UsageService.UsageService;

  const read = Effect.fn("UsageThreadCosts.read")(function* (input: UsageThreadCostsInput) {
    const requests = yield* Effect.forEach(
      new Set(input.threadIds),
      (threadId) =>
        projections.getThreadRecords(threadId, ["providerThreads"]).pipe(
          Effect.map(({ providerThreads }) =>
            providerThreads.flatMap((providerThread) => {
              const session = transcriptSessionOf(providerThread);
              return session === null ? [] : [{ key: threadId, ...session }];
            }),
          ),
          // A thread that cannot be loaded just has no figure.
          Effect.orElseSucceed(() => []),
        ),
      { concurrency: 8 },
    );
    const costs = yield* usage.readSessionCosts(requests.flat());
    return {
      costs: costs.map(({ key, costUsd, costSource }) => ({
        threadId: ThreadId.make(key),
        costUsd,
        costSource,
      })),
    };
  });

  return UsageThreadCostsService.of({ read });
});

export const layer = Layer.effect(UsageThreadCostsService, make);
