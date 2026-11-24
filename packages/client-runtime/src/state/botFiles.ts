import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import type * as Persistence from "../platform/persistence.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

type BotWatcherDecisionTag =
  | typeof WS_METHODS.botWatcherDryRun
  | typeof WS_METHODS.botWatcherApprove
  | typeof WS_METHODS.botWatcherReject
  | typeof WS_METHODS.botWatcherSetRunsOn;

/**
 * A Bot's notes.md and preferences.md (a save refreshes the read), starting a Bot, and the
 * watchers it proposes: the user reads each version here and decides on it.
 */
export function createBotFilesEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Persistence.EnvironmentCacheStore | R, E>,
) {
  const files = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:bot-files:read",
    tag: WS_METHODS.botFilesRead,
  });
  const watchers = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:bot-watchers:list",
    tag: WS_METHODS.botWatcherList,
  });
  // Each decision changes what the list shows, and an approval or dry run takes a while, so
  // they take turns per Bot rather than overlap.
  const watcherDecision = <TTag extends BotWatcherDecisionTag>(label: string, tag: TTag) =>
    createEnvironmentRpcCommand(runtime, {
      label: `environment-data:bot-watchers:${label}`,
      tag,
      scheduler: createAtomCommandScheduler(),
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.threadId]),
      },
      onSettled: ({ environmentId, input }, registry) =>
        Effect.sync(() =>
          registry.refresh(watchers({ environmentId, input: { threadId: input.threadId } })),
        ),
    });
  return {
    files,
    watchers,
    watcherDryRun: watcherDecision("dry-run", WS_METHODS.botWatcherDryRun),
    watcherApprove: watcherDecision("approve", WS_METHODS.botWatcherApprove),
    watcherReject: watcherDecision("reject", WS_METHODS.botWatcherReject),
    watcherSetRunsOn: watcherDecision("set-runs-on", WS_METHODS.botWatcherSetRunsOn),
    write: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:bot-files:write",
      tag: WS_METHODS.botFilesWrite,
      scheduler: createAtomCommandScheduler(),
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.threadId]),
      },
      onSettled: ({ environmentId, input }, registry) =>
        Effect.sync(() =>
          registry.refresh(files({ environmentId, input: { threadId: input.threadId } })),
        ),
    }),
    // Launches a thread, so a double click must not start two Bots.
    start: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:bot:start",
      tag: WS_METHODS.botStart,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.threadId]),
      },
    }),
  };
}
