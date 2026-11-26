import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as MilestoneHub from "../milestones/MilestoneHub.ts";
import { forkParked } from "../serverActivation.ts";
import * as BotService from "./BotService.ts";
import * as RepairService from "./RepairService.ts";

/**
 * Wakes a Bot when its crew, or a thread or workflow run it watches, reaches a milestone, and
 * tells it when one of its own runs fails.
 */
export class BotWakeReactor extends Context.Service<
  BotWakeReactor,
  { readonly start: () => Effect.Effect<void, never, Scope.Scope> }
>()("t3/bots/BotWakeReactor") {}

const quietly = (effect: Effect.Effect<void>) => effect.pipe(Effect.ignoreCause({ log: true }));

const make = Effect.gen(function* () {
  const hub = yield* MilestoneHub.MilestoneHub;
  const bots = yield* BotService.BotService;
  const repair = yield* RepairService.RepairService;
  const start: BotWakeReactor["Service"]["start"] = Effect.fn("BotWakeReactor.start")(function* () {
    const events = yield* hub.subscribe({
      types: BotService.BOT_WAKING_MILESTONES,
      includeSubagentChildren: false,
    });
    yield* forkParked(
      Stream.runForEach(events, (event) =>
        // Each alone, so one that dies never costs the other its milestone.
        quietly(bots.handleMilestone(event)).pipe(
          Effect.andThen(quietly(repair.handleMilestone(event))),
        ),
      ),
    );
  });
  return BotWakeReactor.of({ start });
});

export const layer = Layer.effect(BotWakeReactor, make);
