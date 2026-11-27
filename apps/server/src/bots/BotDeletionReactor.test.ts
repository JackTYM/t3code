import { assert, it } from "@effect/vitest";
import type { ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as BotDeletionReactor from "./BotDeletionReactor.ts";
import * as BotSecretGrantService from "./BotSecretGrantService.ts";
import * as WatcherService from "./WatcherService.ts";

const reactorOver = (
  events: ReadonlyArray<{ type: string; threadId: string }>,
  failing: "grants" | "watchers" | undefined,
) =>
  Effect.gen(function* () {
    const removed: Array<string> = [];
    const done = yield* Deferred.make<void>();
    const reactor = yield* BotDeletionReactor.BotDeletionReactor.pipe(
      Effect.provide(
        BotDeletionReactor.layer.pipe(
          Layer.provide(
            Layer.mock(Orchestrator.OrchestratorV2)({
              streamDomainEvents: Stream.fromIterable(events).pipe(
                Stream.ensuring(Deferred.succeed(done, undefined)),
              ) as never,
            }),
          ),
          Layer.provide(
            Layer.mock(BotSecretGrantService.BotSecretGrantService)({
              removeAll: ({ botThreadId }: { botThreadId: ThreadId }) =>
                failing === "grants"
                  ? Effect.die("grants failed")
                  : Effect.sync(() => void removed.push(`grants:${botThreadId}`)),
            }),
          ),
          Layer.provide(
            Layer.mock(WatcherService.WatcherService)({
              removeAllFor: ({ botThreadId }: { botThreadId: ThreadId }) =>
                failing === "watchers"
                  ? Effect.die("watchers failed")
                  : Effect.sync(() => void removed.push(`watchers:${botThreadId}`)),
            }),
          ),
        ),
      ),
    );
    yield* reactor.start();
    yield* Deferred.await(done);
    return removed.toSorted();
  }).pipe(Effect.scoped);

it.effect("a deleted thread has its grants and its watchers removed, and nothing else does", () =>
  Effect.gen(function* () {
    const removed = yield* reactorOver(
      [
        { type: "thread.archived", threadId: "a" },
        { type: "thread.deleted", threadId: "b" },
      ],
      undefined,
    );
    assert.deepStrictEqual(removed, ["grants:b", "watchers:b"]);
  }),
);

it.effect.each(["grants", "watchers"] as const)(
  "a failure removing a deleted Bot's %s costs neither the other nor the next Bot",
  (failing) =>
    Effect.gen(function* () {
      const removed = yield* reactorOver(
        [
          { type: "thread.deleted", threadId: "b" },
          { type: "thread.deleted", threadId: "c" },
        ],
        failing,
      );
      const other = failing === "grants" ? "watchers" : "grants";
      assert.deepStrictEqual(removed, [`${other}:b`, `${other}:c`]);
    }),
);
