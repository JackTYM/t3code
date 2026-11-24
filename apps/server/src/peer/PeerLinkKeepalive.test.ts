import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as PeerLinkKeepalive from "./PeerLinkKeepalive.ts";
import * as PeerLinks from "./PeerLinks.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";

const laptop = EnvironmentId.make("environment-laptop");
const spare = EnvironmentId.make("environment-spare");

const build = Effect.fn(function* (enabled: boolean, asleep: ReadonlySet<EnvironmentId>) {
  const touched = yield* Ref.make<ReadonlyArray<EnvironmentId>>([]);
  const layer = PeerLinkKeepalive.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(PeerLinks.PeerLinks)({
          enabled: Effect.succeed(enabled),
          names: Effect.succeed([
            { environmentId: laptop, label: "Laptop" },
            { environmentId: spare, label: "Spare" },
          ]),
        }),
        Layer.mock(PeerMcpClient.PeerMcpClient)({
          touch: (environmentId) =>
            Ref.update(touched, (seen) => [...seen, environmentId]).pipe(
              Effect.andThen(
                asleep.has(environmentId)
                  ? Effect.die("a machine that is off must not stop the others")
                  : Effect.void,
              ),
            ),
        }),
      ),
    ),
  );
  const keepalive = yield* PeerLinkKeepalive.PeerLinkKeepalive.pipe(Effect.provide(layer));
  yield* keepalive.start();
  // Lets the first check run.
  yield* Effect.yieldNow.pipe(Effect.repeat({ times: 10 }));
  return touched;
});

it.effect("touches every live link at start and again every 12 hours", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const touched = yield* build(true, new Set());
      expect(yield* Ref.get(touched)).toEqual([laptop, spare]);
      yield* TestClock.adjust("12 hours");
      expect(yield* Ref.get(touched)).toEqual([laptop, spare, laptop, spare]);
    }),
  ),
);

it.effect("a machine that cannot be reached does not keep the others from being touched", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const touched = yield* build(true, new Set([laptop]));
      expect(yield* Ref.get(touched)).toEqual([laptop, spare]);
    }),
  ),
);

it.effect("touches nothing while linked environments is off", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const touched = yield* build(false, new Set());
      expect(yield* Ref.get(touched)).toEqual([]);
    }),
  ),
);
