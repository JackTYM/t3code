import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";

import { forkParked } from "../serverActivation.ts";
import * as PeerLinks from "./PeerLinks.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";

/** A link lasts 30 days from its last authenticated use, so a check twice a day is ample. */
const KEEPALIVE_EVERY = Duration.hours(12);

/**
 * Keeps links to machines that are rarely asked for work from expiring: a laptop that is
 * only reached when a task needs it would otherwise lose its link after a month idle.
 */
export class PeerLinkKeepalive extends Context.Service<
  PeerLinkKeepalive,
  { readonly start: () => Effect.Effect<void, never, Scope.Scope> }
>()("t3/peer/PeerLinkKeepalive") {}

const make = Effect.gen(function* () {
  const links = yield* PeerLinks.PeerLinks;
  const peers = yield* PeerMcpClient.PeerMcpClient;

  const renewAll = Effect.gen(function* () {
    if (!(yield* links.enabled)) return;
    // Links already expired cannot be renewed, so only the live ones are asked.
    const live = yield* links.names;
    yield* Effect.forEach(
      live,
      ({ environmentId }) =>
        // A machine that is off now is asked again at the next check, and never holds up the rest.
        peers.touch(environmentId).pipe(Effect.ignoreCause({ log: true })),
      { concurrency: 4, discard: true },
    );
  }).pipe(Effect.ignoreCause({ log: true }));

  const start = Effect.fn("PeerLinkKeepalive.start")(function* () {
    yield* forkParked(renewAll.pipe(Effect.repeat(Schedule.spaced(KEEPALIVE_EVERY))));
  });

  return PeerLinkKeepalive.of({ start });
});

export const layer = Layer.effect(PeerLinkKeepalive, make);
