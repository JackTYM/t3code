import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { decodeJsonReply, fromRunner } from "./textGenerationOperations.ts";

// regression: #23726 a reply that echoes the schema key replaced the seed title with "title"
it.effect("fails a thread title reply that is only the schema key", () =>
  Effect.gen(function* () {
    const textGeneration = fromRunner("Stub", (request) =>
      decodeJsonReply(request, "Stub", '{"title":"title","needsRefinement":false}'),
    );

    const outcome = yield* textGeneration
      .generateThreadTitle({
        cwd: process.cwd(),
        message: "$implement Issue #140",
        modelSelection: {
          instanceId: ProviderInstanceId.make("pi"),
          model: "anthropic/claude-haiku-4-5",
        },
      })
      .pipe(Effect.match({ onFailure: (error) => error, onSuccess: (result) => result }));

    assert.instanceOf(outcome, TextGenerationError);
    assert.strictEqual(outcome.operation, "generateThreadTitle");
  }),
);

const reviewInput = {
  cwd: process.cwd(),
  name: "github",
  purpose: "Report new GitHub notifications.",
  runtime: "sh" as const,
  mode: "events" as const,
  intervalSeconds: 300,
  source: "gh api notifications",
  tag: "review-0f3a",
  modelSelection: {
    instanceId: ProviderInstanceId.make("pi"),
    model: "anthropic/claude-haiku-4-5",
  },
};

it.effect("trims and caps a watcher review reason at 300 characters", () =>
  Effect.gen(function* () {
    const textGeneration = fromRunner("Stub", (request) =>
      decodeJsonReply(
        request,
        "Stub",
        JSON.stringify({ verdict: "reject", reason: ` ${"x".repeat(400)} ` }),
      ),
    );

    const result = yield* textGeneration.reviewWatcher(reviewInput);

    assert.strictEqual(result.verdict, "reject");
    assert.strictEqual(result.reason.length, 300);
  }),
);

it.effect("fails a watcher review reply that has no verdict", () =>
  Effect.gen(function* () {
    const textGeneration = fromRunner("Stub", (request) =>
      decodeJsonReply(request, "Stub", '{"verdict":"maybe","reason":"unsure"}'),
    );

    const outcome = yield* textGeneration
      .reviewWatcher(reviewInput)
      .pipe(Effect.match({ onFailure: (error) => error, onSuccess: (result) => result }));

    assert.instanceOf(outcome, TextGenerationError);
    assert.strictEqual(outcome.operation, "reviewWatcher");
  }),
);
