import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../serverActivation.ts";
import * as BotSecretGrantService from "./BotSecretGrantService.ts";

/**
 * Takes a deleted Bot's secret grants with it. This sits above the orchestration runtime, whose
 * deletion effects (the outbox) cannot reach the Bot services, so it follows the deletion event.
 */
export class BotDeletionReactor extends Context.Service<
  BotDeletionReactor,
  { readonly start: () => Effect.Effect<void, never, Scope.Scope> }
>()("t3/bots/BotDeletionReactor") {}

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const grants = yield* BotSecretGrantService.BotSecretGrantService;
  const start: BotDeletionReactor["Service"]["start"] = Effect.fn("BotDeletionReactor.start")(
    function* () {
      yield* forkParked(
        Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
          event.type === "thread.deleted"
            ? grants
                .removeAll({ botThreadId: event.threadId })
                // One that fails never ends the stream, or costs the next Bot its cleanup.
                .pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("A deleted Bot's secret grants could not be removed.", {
                      threadId: event.threadId,
                      cause,
                    }),
                  ),
                )
            : Effect.void,
        ),
      );
    },
  );
  return BotDeletionReactor.of({ start });
});

export const layer = Layer.effect(BotDeletionReactor, make);
