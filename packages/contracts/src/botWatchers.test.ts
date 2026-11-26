import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { BotWatcher, BotWatcherError } from "./botWatchers.ts";

const decodeWatcher = Schema.decodeUnknownEffect(BotWatcher);

// A server from before the reviewer existed sends no `reviews`.
it.effect("decodes a watcher from an older server that sends no reviews", () =>
  Effect.gen(function* () {
    const watcher = yield* decodeWatcher({
      name: "deadlines",
      status: "healthy",
      hash: "aaaaaaaaaaaaaaaaaaaa",
      runsOn: "local",
      paused: false,
      history: [],
    });
    assert.deepStrictEqual(watcher.reviews, []);
  }),
);

it("says a version with nothing to review is under review, not waiting for approval", () => {
  const message = new BotWatcherError({
    threadId: "thread-1" as never,
    watcher: "deadlines",
    reason: "no_pending",
  }).message;
  assert.include(message, "under review");
});
