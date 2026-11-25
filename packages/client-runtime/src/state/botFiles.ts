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

type BotMailCommandTag =
  | typeof WS_METHODS.botMailSetMailboxes
  | typeof WS_METHODS.botMailForget
  | typeof WS_METHODS.botMailClearDropped
  | typeof WS_METHODS.botMailBackfill
  | typeof WS_METHODS.botMailCreateHook
  | typeof WS_METHODS.botMailRotateHook;

type BotWatcherDecisionTag =
  | typeof WS_METHODS.botWatcherDryRun
  | typeof WS_METHODS.botWatcherApprove
  | typeof WS_METHODS.botWatcherReject
  | typeof WS_METHODS.botWatcherSetRunsOn
  | typeof WS_METHODS.botWatcherPause
  | typeof WS_METHODS.botWatcherResume
  | typeof WS_METHODS.botWatcherRemove;

type BotHoldDecisionTag = typeof WS_METHODS.botHoldAllow | typeof WS_METHODS.botHoldReject;

/**
 * A Bot's notes.md and preferences.md (a save refreshes the read), its tasks.md as a task list,
 * starting a Bot, the watchers it proposes (the user reads each version here and decides on it),
 * and the calls it held because email influenced its turn.
 */
export function createBotFilesEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Persistence.EnvironmentCacheStore | R, E>,
) {
  const files = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:bot-files:read",
    tag: WS_METHODS.botFilesRead,
  });
  const tasks = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:bot-tasks:read",
    tag: WS_METHODS.botTasksRead,
  });
  const mailStatus = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:bot-mail:status",
    tag: WS_METHODS.botMailStatus,
  });
  // Each of these changes what the status shows.
  const mailCommand = <TTag extends BotMailCommandTag>(label: string, tag: TTag) =>
    createEnvironmentRpcCommand(runtime, {
      label: `environment-data:bot-mail:${label}`,
      tag,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.threadId]),
      },
      onSettled: ({ environmentId, input }, registry) =>
        Effect.sync(() =>
          registry.refresh(mailStatus({ environmentId, input: { threadId: input.threadId } })),
        ),
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
  const holds = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:bot-holds:list",
    tag: WS_METHODS.botHoldList,
  });
  // A decision removes the held action, so it takes turns per Bot with the list it changes.
  const holdDecision = <TTag extends BotHoldDecisionTag>(label: string, tag: TTag) =>
    createEnvironmentRpcCommand(runtime, {
      label: `environment-data:bot-holds:${label}`,
      tag,
      scheduler: createAtomCommandScheduler(),
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.threadId]),
      },
      onSettled: ({ environmentId, input }, registry) =>
        Effect.sync(() =>
          registry.refresh(holds({ environmentId, input: { threadId: input.threadId } })),
        ),
    });
  return {
    files,
    tasks,
    watchers,
    holds,
    holdAllow: holdDecision("allow", WS_METHODS.botHoldAllow),
    holdReject: holdDecision("reject", WS_METHODS.botHoldReject),
    mailStatus,
    mailSetMailboxes: mailCommand("set-mailboxes", WS_METHODS.botMailSetMailboxes),
    mailForget: mailCommand("forget", WS_METHODS.botMailForget),
    mailClearDropped: mailCommand("clear-dropped", WS_METHODS.botMailClearDropped),
    mailBackfill: mailCommand("backfill", WS_METHODS.botMailBackfill),
    mailCreateHook: mailCommand("create-hook", WS_METHODS.botMailCreateHook),
    mailRotateHook: mailCommand("rotate-hook", WS_METHODS.botMailRotateHook),
    watcherDryRun: watcherDecision("dry-run", WS_METHODS.botWatcherDryRun),
    watcherApprove: watcherDecision("approve", WS_METHODS.botWatcherApprove),
    watcherReject: watcherDecision("reject", WS_METHODS.botWatcherReject),
    watcherSetRunsOn: watcherDecision("set-runs-on", WS_METHODS.botWatcherSetRunsOn),
    watcherPause: watcherDecision("pause", WS_METHODS.botWatcherPause),
    watcherResume: watcherDecision("resume", WS_METHODS.botWatcherResume),
    watcherRemove: watcherDecision("remove", WS_METHODS.botWatcherRemove),
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
    // Marking done and reopening both rewrite one line of the file, so they take turns per Bot.
    setTaskStatus: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:bot-tasks:set-status",
      tag: WS_METHODS.botTasksSetStatus,
      scheduler: createAtomCommandScheduler(),
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.threadId]),
      },
      onSettled: ({ environmentId, input }, registry) =>
        Effect.sync(() =>
          registry.refresh(tasks({ environmentId, input: { threadId: input.threadId } })),
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
