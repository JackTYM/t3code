import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  type BotSecretGrant,
  type BotWatcher,
  type BotWatcherRunsOn,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import { ChevronRightIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import { newMessageId } from "~/lib/utils";
import { m } from "~/i18n/messages";
import { botFilesEnvironment } from "~/state/botFiles";
import { useThreadShell } from "~/state/entities";
import { useLinkedEnvironments } from "~/state/peerLinks";
import { useEnvironmentQuery } from "~/state/query";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { RelativeTime } from "../RelativeTime";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import {
  botWatcherControls,
  botWatcherDryRunOf,
  botWatcherInterval,
  botWatcherKind,
  botWatcherPlaces,
  botWatcherReviseMessage,
  botWatcherSecretStatus,
  botWatcherState,
  botWatcherToolCall,
  botWatchersUsingTool,
  groupBotWatchers,
  latestReview,
  parseBotWatcherDiff,
  shortBotWatcherHash,
  type BotWatcherBlock,
  type BotWatcherControl,
  type BotWatcherGroup,
  type BotWatcherState,
} from "./BotWatchersView.logic";

const STATE_BADGE = {
  reviewing: "info",
  revising: "info",
  invalid: "error",
  paused: "outline",
  waiting: "warning",
  failing: "error",
  running: "success",
  ready: "success",
} as const satisfies Record<BotWatcherState, "warning" | "error" | "outline" | "success" | "info">;

function StateBadge(props: { state: BotWatcherState }) {
  switch (props.state) {
    case "reviewing":
      return (
        <Badge variant={STATE_BADGE.reviewing}>
          <T>in review</T>
        </Badge>
      );
    case "revising":
      return (
        <Badge variant={STATE_BADGE.revising}>
          <T>new version in review</T>
        </Badge>
      );
    case "invalid":
      return (
        <Badge variant={STATE_BADGE.invalid}>
          <T>invalid</T>
        </Badge>
      );
    case "paused":
      return (
        <Badge variant={STATE_BADGE.paused}>
          <T>paused</T>
        </Badge>
      );
    case "waiting":
      return (
        <Badge variant={STATE_BADGE.waiting}>
          <T>waiting</T>
        </Badge>
      );
    case "failing":
      return (
        <Badge variant={STATE_BADGE.failing}>
          <T>failing</T>
        </Badge>
      );
    case "running":
      return (
        <Badge variant={STATE_BADGE.running}>
          <T>running</T>
        </Badge>
      );
    case "ready":
      return (
        <Badge variant={STATE_BADGE.ready}>
          <T>ready</T>
        </Badge>
      );
  }
}

/** Every sentence that names a row says what it is, so a tool is never called a watcher. */
function useKindWords(kind: "watch" | "tool") {
  const gt = useGT();
  const tool = kind === "tool";
  return {
    kind: tool ? gt("tool") : gt("watcher"),
    failedRun: tool ? gt("Failed to run the tool") : gt("Failed to run the watcher"),
    failedPause: tool ? gt("Failed to pause the tool") : gt("Failed to pause the watcher"),
    failedResume: tool ? gt("Failed to resume the tool") : gt("Failed to resume the watcher"),
    failedRemove: tool ? gt("Failed to remove the tool") : gt("Failed to remove the watcher"),
    inReview: tool
      ? gt("The Bot proposed this. It can call it once a reviewer model has approved it.")
      : gt("The Bot proposed this. It runs once a reviewer model has approved it."),
    paused: tool
      ? gt("Paused by you. The approved version is kept and the Bot cannot call it.")
      : gt("Paused by you. The approved version is kept and does not run."),
    removeBody: tool
      ? gt(
          "This deletes the tool and its versions. The Bot can propose it again, and the reviewer would check it again.",
        )
      : gt(
          "This deletes the watcher and its versions. The Bot can propose it again, and the reviewer would check it again.",
        ),
  };
}

function useBlockedReason() {
  const gt = useGT();
  return (block: BotWatcherBlock): string => {
    switch (block) {
      case "needs_terminal_access":
        return gt("This connection cannot run code on this environment.");
      case "no_source":
        return gt("The files for this version are missing or were changed on disk.");
      case "not_reviewed":
        return gt("The reviewer has not approved this version yet, so it cannot be run.");
    }
  };
}

function useIntervalLabel() {
  const gt = useGT();
  return (seconds: number): string => {
    const { count, unit } = botWatcherInterval(seconds);
    switch (unit) {
      case "second":
        return gt("every {count} s", { count });
      case "minute":
        return gt("every {count} min", { count });
      case "hour":
        return gt("every {count} h", { count });
      case "day":
        return gt("every {count} d", { count });
    }
  };
}

function useModeLabel() {
  const gt = useGT();
  return (mode: BotWatcher["mode"]): string =>
    mode === "events" ? gt("reports news") : gt("health check");
}

function ScriptOutput(props: { label: string; text: string }) {
  if (props.text.length === 0) return null;
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-muted-foreground text-xs">{props.label}</span>
      <pre className="max-h-40 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-xs whitespace-pre-wrap break-all">
        {props.text}
      </pre>
    </div>
  );
}

function DiffView(props: { diff: string }) {
  const lines = parseBotWatcherDiff(props.diff);
  return (
    <pre className="max-h-64 overflow-auto rounded-md bg-muted/50 py-1 font-mono text-xs">
      {lines.map((line, index) => (
        <span
          // The same text can repeat, and a patch is never reordered.
          // oxlint-disable-next-line react/no-array-index-key
          key={index}
          className={
            line.kind === "add"
              ? "block bg-success/8 px-2 text-success-foreground"
              : line.kind === "remove"
                ? "block bg-destructive/8 px-2 text-destructive-foreground"
                : line.kind === "hunk"
                  ? "block px-2 text-muted-foreground"
                  : "block px-2"
          }
        >
          {`${line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "} ${line.text}`}
        </span>
      ))}
    </pre>
  );
}

type Busy = "run" | "move" | "pause" | "resume" | "remove" | "revise";

function WatcherCard(props: {
  threadRef: ScopedThreadRef;
  watcher: BotWatcher;
  /** The watchers that declare this row as a tool, which fail while it is paused or gone. */
  usedBy: ReadonlyArray<string>;
  linked: ReadonlyMap<EnvironmentId, string>;
  grants: { readonly runCode: boolean; readonly operate: boolean };
  /** The Bot's secret grants, or null while they load. */
  secretGrants: ReadonlyArray<BotSecretGrant> | null;
}) {
  const gt = useGT();
  const blockedReason = useBlockedReason();
  const intervalLabel = useIntervalLabel();
  const modeLabel = useModeLabel();
  const { watcher } = props;
  const kind = botWatcherKind(watcher);
  const isTool = kind === "tool";
  const words = useKindWords(kind);
  const { environmentId, threadId } = props.threadRef;
  const thread = useThreadShell(props.threadRef);
  const dryRun = useAtomCommand(botFilesEnvironment.watcherDryRun, { reportFailure: false });
  const setRunsOn = useAtomCommand(botFilesEnvironment.watcherSetRunsOn, {
    reportFailure: false,
  });
  const pause = useAtomCommand(botFilesEnvironment.watcherPause, { reportFailure: false });
  const resume = useAtomCommand(botFilesEnvironment.watcherResume, { reportFailure: false });
  const remove = useAtomCommand(botFilesEnvironment.watcherRemove, { reportFailure: false });
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  // Where the user means it to run. It follows the server until they pick a place.
  const [picked, setPicked] = useState<BotWatcherRunsOn | null>(null);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [revising, setRevising] = useState(false);
  const [note, setNote] = useState("");

  const target = picked ?? watcher.runsOn;
  const state = botWatcherState(watcher);
  const controls = botWatcherControls(watcher, target, props.grants);
  const places = botWatcherPlaces(props.linked, watcher.runsOn);
  const placeLabel = (place: BotWatcherRunsOn) =>
    place === "local"
      ? gt("This environment")
      : (props.linked.get(place as EnvironmentId) ?? gt("A linked environment"));
  const dryRunShown = botWatcherDryRunOf(watcher);
  const verdict = latestReview(watcher);
  const secrets = botWatcherSecretStatus(watcher, props.secretGrants);
  const runnableHash = watcher.pendingHash ?? watcher.approvedHash;
  const showsMove =
    controls.choosesPlace && (controls.move || (!controls.pending && target !== watcher.runsOn));

  const settle = async (
    action: Busy,
    failureTitle: string,
    perform: () => Promise<AtomCommandResult<unknown, unknown>>,
  ) => {
    setBusy(action);
    const result = await perform();
    setBusy(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: failureTitle,
        description:
          thrownErrorMessage(squashAtomCommandFailure(result), m) ?? gt("An error occurred."),
      });
      return false;
    }
    return result._tag === "Success";
  };
  const base = { threadId, name: watcher.name };

  const runOnce = () => {
    if (runnableHash === undefined) return;
    void settle("run", words.failedRun, () =>
      dryRun({
        environmentId,
        input: { ...base, hash: runnableHash, runsOn: target },
      }),
    );
  };
  const moveWatcher = async () => {
    const done = await settle("move", gt("Failed to move the watcher"), () =>
      setRunsOn({ environmentId, input: { ...base, runsOn: target } }),
    );
    if (done) setPicked(null);
  };
  const togglePaused = () =>
    void settle(
      watcher.paused ? "resume" : "pause",
      watcher.paused ? words.failedResume : words.failedPause,
      () =>
        watcher.paused
          ? resume({ environmentId, input: base })
          : pause({ environmentId, input: base }),
    );
  const removeWatcher = () => {
    setConfirmingRemove(false);
    void settle("remove", words.failedRemove, () => remove({ environmentId, input: base }));
  };
  const askForRevision = async () => {
    if (thread === null) return;
    const done = await settle("revise", gt("Failed to message the Bot"), () =>
      startTurn({
        environmentId,
        input: {
          threadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: botWatcherReviseMessage(watcher, note),
            attachments: [],
          },
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          // Queued, so the Bot starts a turn from this message instead of steering one a wake
          // began, which could not propose a watcher.
          dispatchMode: "queue",
          createdAt: new Date().toISOString(),
        },
      }),
    );
    if (done) {
      setRevising(false);
      setNote("");
      toastManager.add({
        type: "success",
        title: gt("Asked the Bot to revise {name}", { name: watcher.name }),
        description: gt("A reviewer model checks the new version before it runs."),
      });
    }
  };

  const why = (control: BotWatcherControl) =>
    control.enabled ? undefined : blockedReason(control.reason);
  // A disabled button has no tooltip, so the reason is printed under the row.
  const runOnceReason = why(controls.runOnce);
  const idle = busy === null;

  return (
    <li className="flex flex-col gap-2 py-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium">{watcher.name}</span>
        <Badge variant="outline">{words.kind}</Badge>
        <StateBadge state={state} />
        {watcher.paused && state !== "paused" ? (
          <Badge variant="outline">
            <T>paused</T>
          </Badge>
        ) : null}
        {isTool || watcher.intervalSeconds === undefined ? null : (
          <span className="text-muted-foreground text-xs">
            {intervalLabel(watcher.intervalSeconds)}
          </span>
        )}
        {watcher.runtime === undefined ? null : (
          <span className="text-muted-foreground text-xs">{watcher.runtime}</span>
        )}
        {isTool ? null : (
          <span className="text-muted-foreground text-xs">{modeLabel(watcher.mode)}</span>
        )}
        {controls.choosesPlace ? (
          <label className="ms-auto flex items-center gap-1.5 text-muted-foreground text-xs">
            <T>Runs on</T>
            <Select<BotWatcherRunsOn, false>
              value={target}
              disabled={!props.grants.runCode || controls.pending || !idle}
              onValueChange={(value) => {
                if (value !== null) setPicked(value);
              }}
            >
              <SelectTrigger size="xs" variant="ghost" aria-label={gt("Runs on")}>
                <SelectValue>{(value: BotWatcherRunsOn) => placeLabel(value)}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {places.map((place) => (
                  <SelectItem hideIndicator key={place.value} value={place.value}>
                    {place.name ?? placeLabel(place.value)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </label>
        ) : null}
      </div>

      {watcher.purpose === undefined || watcher.purpose.length === 0 ? null : (
        <p className="text-sm break-words">{watcher.purpose}</p>
      )}

      {watcher.usage === undefined || watcher.usage.length === 0 ? null : (
        <p className="text-muted-foreground text-xs break-words">
          <T>Usage</T> <code className="font-mono">{watcher.usage}</code>
        </p>
      )}

      {watcher.tools === undefined || watcher.tools.length === 0 ? null : (
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
          <span className="text-muted-foreground text-xs">
            <T>Reads tools</T>
          </span>
          {watcher.tools.map((declared) => (
            <Badge key={botWatcherToolCall(declared)} variant="outline">
              {botWatcherToolCall(declared)}
            </Badge>
          ))}
        </div>
      )}

      {props.usedBy.length === 0 ? null : (
        <p className="text-muted-foreground text-xs break-words">
          {gt("Used by {names}. They fail while this tool is paused or removed.", {
            names: props.usedBy.join(", "),
          })}
        </p>
      )}

      {secrets.length === 0 ? null : (
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <span className="text-muted-foreground text-xs">
              <T>Uses secrets</T>
            </span>
            {secrets.map((secret) => (
              <Badge
                key={secret.name}
                variant={
                  secret.granted === null ? "outline" : secret.granted ? "success" : "warning"
                }
              >
                {secret.granted === null
                  ? secret.name
                  : secret.granted
                    ? gt("{name} granted", { name: secret.name })
                    : gt("{name} needs a grant", { name: secret.name })}
              </Badge>
            ))}
            {secrets.some((secret) => secret.granted === false) ? (
              <Button
                size="xs"
                variant="ghost-muted"
                render={
                  <Link
                    to="/settings/home"
                    hash="bot-secret-grants"
                    // The settings page opens on this environment, whose Bot the grants belong to.
                    search={{ machine: environmentId }}
                    state={{ settingsTargetHighlight: true, botSecretGrantsThreadId: threadId }}
                  />
                }
              >
                <T>Grant access</T>
              </Button>
            ) : null}
          </div>
          {watcher.hosts === undefined || watcher.hosts.length === 0 ? null : (
            <p className="text-muted-foreground text-xs break-all">
              {gt("Declared hosts: {hosts}", { hosts: watcher.hosts.join(", ") })}
            </p>
          )}
        </div>
      )}

      {state === "reviewing" ? (
        <p className="text-muted-foreground text-xs">{words.inReview}</p>
      ) : state === "revising" ? (
        <p className="text-muted-foreground text-xs">
          {gt(
            "A new version is being reviewed. Version {hash} keeps running until it is approved.",
            {
              hash: shortBotWatcherHash(watcher.approvedHash ?? ""),
            },
          )}
        </p>
      ) : state === "invalid" ? (
        <p className="text-destructive-foreground text-xs">
          <T>The files for this version are missing or were changed on disk. It does not run.</T>
        </p>
      ) : state === "waiting" && watcher.waiting !== undefined ? (
        <p className="text-muted-foreground text-xs">
          {gt("{place} did not answer: {reason}", {
            place: placeLabel(watcher.runsOn),
            reason: watcher.waiting.reason,
          })}
          {" · "}
          <RelativeTime timestamp={new Date(watcher.waiting.since).toISOString()} />
          {" · "}
          <T>This is not a failure. It runs again when the environment answers.</T>
        </p>
      ) : state === "failing" && watcher.failingSince !== undefined ? (
        <p className="text-muted-foreground text-xs">
          <T>Failing since</T>{" "}
          <RelativeTime timestamp={new Date(watcher.failingSince).toISOString()} />
          {watcher.nextWakeAt === undefined ? null : (
            <>
              {" · "}
              <T>wakes the Bot again</T>{" "}
              <RelativeTime timestamp={new Date(watcher.nextWakeAt).toISOString()} />
            </>
          )}
        </p>
      ) : state === "paused" ? (
        <p className="text-muted-foreground text-xs">{words.paused}</p>
      ) : null}
      {watcher.lastRunAt === undefined ? null : (
        <p className="text-muted-foreground text-xs">
          <T>Last ran</T> <RelativeTime timestamp={new Date(watcher.lastRunAt).toISOString()} />
        </p>
      )}

      {verdict === undefined ? null : (
        <div className="flex flex-col gap-1 rounded-lg border p-2 text-xs">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-medium">
              <T>Reviewer</T>
            </span>
            <Badge variant={verdict.verdict === "reject" ? "error" : "success"}>
              {verdict.verdict === "reject" ? <T>rejected</T> : <T>approved</T>}
            </Badge>
            <span className="text-muted-foreground">
              {gt("version {hash}", { hash: shortBotWatcherHash(verdict.hash) })}
              {" · "}
              {verdict.model}
              {" · "}
              <RelativeTime timestamp={verdict.at} />
            </span>
          </div>
          {/* The reason is derived from a script the Bot wrote, so it is only ever plain text. */}
          <p className="break-words whitespace-pre-wrap">{verdict.reason}</p>
          {verdict.verdict === "reject" ? (
            <p className="text-muted-foreground">
              {watcher.approvedHash === undefined
                ? gt("Nothing runs until the Bot proposes a new version.")
                : gt("This revision was not used. Version {hash} is unchanged and keeps running.", {
                    hash: shortBotWatcherHash(watcher.approvedHash),
                  })}
            </p>
          ) : null}
        </div>
      )}

      {controls.pending && watcher.diff !== undefined ? (
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground text-xs">
            {gt("Changed since the running version ({from} to {to})", {
              from: shortBotWatcherHash(watcher.approvedHash ?? ""),
              to: shortBotWatcherHash(watcher.hash),
            })}
          </span>
          <DiffView diff={watcher.diff} />
        </div>
      ) : null}

      {watcher.source === undefined ? null : (
        <Collapsible defaultOpen={state === "reviewing"}>
          <CollapsibleTrigger
            render={<Button variant="ghost-muted" size="xs" className="group self-start" />}
          >
            <ChevronRightIcon aria-hidden className="group-data-panel-open:rotate-90" />
            {gt("Source {hash}", { hash: shortBotWatcherHash(watcher.hash) })}
          </CollapsibleTrigger>
          <CollapsiblePanel animate={false}>
            <ScrollArea className="max-h-64">
              <pre className="rounded-md bg-muted/50 p-2 font-mono text-xs whitespace-pre-wrap break-all">
                {watcher.source}
              </pre>
            </ScrollArea>
            {watcher.expect === undefined ? null : (
              <p className="mt-1 text-muted-foreground text-xs">
                {gt("Healthy when the output matches {expect}", { expect: watcher.expect })}
              </p>
            )}
          </CollapsiblePanel>
        </Collapsible>
      )}

      {dryRunShown === undefined ? null : (
        <div className="flex flex-col gap-1.5 rounded-lg border p-2">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <span className="font-medium">
              <T>Run once</T>
            </span>
            <Badge variant={dryRunShown.healthy ? "success" : "error"}>
              {gt("exit {exit}", { exit: dryRunShown.exit })}
            </Badge>
            <span className="text-muted-foreground">
              {placeLabel(dryRunShown.runsOn ?? "local")}
              {" · "}
              <RelativeTime timestamp={dryRunShown.ranAt} />
            </span>
          </div>
          <ScriptOutput label={gt("Output")} text={dryRunShown.stdout} />
          <ScriptOutput label={gt("Errors")} text={dryRunShown.stderr} />
          {dryRunShown.stdout.length === 0 && dryRunShown.stderr.length === 0 ? (
            <span className="text-muted-foreground text-xs">
              <T>It printed nothing.</T>
            </span>
          ) : null}
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        {showsMove ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-muted-foreground text-xs">
              {gt("Moving to {place} needs a run there first.", { place: placeLabel(target) })}
            </span>
            <Button
              size="xs"
              variant="outline"
              disabled={!controls.runOnce.enabled || !idle}
              onClick={runOnce}
            >
              {busy === "run" ? <T>Running…</T> : <T>Run once there</T>}
            </Button>
            <Button size="xs" disabled={!controls.move || !idle} onClick={() => void moveWatcher()}>
              <T>Move</T>
            </Button>
            <Button size="xs" variant="ghost" disabled={!idle} onClick={() => setPicked(null)}>
              <T>Cancel</T>
            </Button>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-1.5">
          {controls.pending ? (
            <Button
              size="xs"
              variant="outline"
              disabled={!controls.runOnce.enabled || !idle}
              onClick={runOnce}
            >
              {busy === "run" ? <T>Running…</T> : <T>Run once</T>}
            </Button>
          ) : null}
          {watcher.approvedHash === undefined ? null : watcher.paused ? (
            <Button
              size="xs"
              variant="outline"
              disabled={!controls.resume || !idle}
              onClick={togglePaused}
            >
              <T>Resume</T>
            </Button>
          ) : (
            <Button
              size="xs"
              variant="outline"
              disabled={!controls.pause || !idle}
              onClick={togglePaused}
            >
              <T>Pause</T>
            </Button>
          )}
          <Button
            size="xs"
            variant="ghost"
            disabled={thread === null || !idle}
            onClick={() => setRevising((open) => !open)}
          >
            <T>Ask the Bot to revise</T>
          </Button>
        </div>
        {controls.pending && runOnceReason !== undefined ? (
          <p className="text-muted-foreground text-xs">{runOnceReason}</p>
        ) : null}
        {controls.pending ? (
          <p className="text-muted-foreground text-xs">
            <T>It can be moved once the new version has been reviewed.</T>
          </p>
        ) : null}
      </div>

      {revising ? (
        <form
          className="flex flex-col gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            void askForRevision();
          }}
        >
          <Textarea
            size="sm"
            rows={3}
            value={note}
            aria-label={gt("What should the Bot change?")}
            placeholder={gt("What should the Bot change?")}
            onChange={(event) => setNote(event.target.value)}
          />
          <div className="flex items-center justify-end gap-1.5">
            <Button
              size="xs"
              variant="ghost"
              type="button"
              disabled={!idle}
              onClick={() => setRevising(false)}
            >
              <T>Cancel</T>
            </Button>
            <Button size="xs" type="submit" disabled={note.trim().length === 0 || !idle}>
              {busy === "revise" ? <T>Sending…</T> : <T>Send to the Bot</T>}
            </Button>
          </div>
        </form>
      ) : null}

      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground text-xs">
          {watcher.approvedHash === undefined
            ? gt("No version approved yet.")
            : gt("Approved version {hash}", { hash: shortBotWatcherHash(watcher.approvedHash) })}
        </span>
        <Button
          size="xs"
          variant="ghost-destructive"
          disabled={!controls.remove || !idle}
          onClick={() => setConfirmingRemove(true)}
        >
          <T>Remove</T>
        </Button>
      </div>

      <AlertDialog open={confirmingRemove} onOpenChange={setConfirmingRemove}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{gt("Remove {name}?", { name: watcher.name })}</AlertDialogTitle>
            <AlertDialogDescription>
              {words.removeBody}
              {props.usedBy.length === 0 ? null : (
                <>
                  {" "}
                  {gt("These watchers use it and will fail until it is back: {names}.", {
                    names: props.usedBy.join(", "),
                  })}
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              <T>Cancel</T>
            </AlertDialogClose>
            <Button variant="destructive" onClick={removeWatcher}>
              <T>Remove</T>
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </li>
  );
}

function GroupHeading(props: { group: BotWatcherGroup; count: number }) {
  return (
    <h3 className="pt-2 font-medium text-muted-foreground text-xs">
      {props.group === "attention" ? (
        <T>Needs you</T>
      ) : props.group === "running" ? (
        <T>Active</T>
      ) : (
        <T>Paused</T>
      )}{" "}
      · {props.count}
    </h3>
  );
}

/**
 * The scripts the Bot proposes: watchers that poll on a timer and tools it calls on demand. A
 * reviewer model approves each version; the user can read it, run it once, pause or remove it, and
 * move a watcher. The source is never editable here.
 */
export function BotWatchersView(props: { threadRef: ScopedThreadRef }) {
  const gt = useGT();
  const { environmentId, threadId } = props.threadRef;
  const watchers = useEnvironmentQuery(
    botFilesEnvironment.watchers({ environmentId, input: { threadId } }),
  );
  const secretGrants = useEnvironmentQuery(
    botFilesEnvironment.secretGrants({ environmentId, input: { threadId } }),
  );
  // Run once, move and resume all run code, so each needs terminal access. Every
  // permission is read before any is combined, since a short-circuit would skip a hook.
  const canDryRun = useAtomValue(botFilesEnvironment.watcherDryRun.permissionAtom(environmentId));
  const canMove = useAtomValue(botFilesEnvironment.watcherSetRunsOn.permissionAtom(environmentId));
  const canResume = useAtomValue(botFilesEnvironment.watcherResume.permissionAtom(environmentId));
  const canPause = useAtomValue(botFilesEnvironment.watcherPause.permissionAtom(environmentId));
  const canRemove = useAtomValue(botFilesEnvironment.watcherRemove.permissionAtom(environmentId));
  const firstRemote = watchers.data?.watchers
    .map((watcher) => watcher.runsOn)
    .find((place): place is EnvironmentId => place !== "local");
  const linked = useLinkedEnvironments(environmentId, firstRemote);

  if (watchers.data === null) {
    return <p className="text-muted-foreground text-sm">{watchers.error ?? <T>Loading…</T>}</p>;
  }
  const grants = {
    runCode: canDryRun && canMove && canResume,
    operate: canPause && canRemove,
  };
  const allWatchers = watchers.data.watchers;
  const groups = groupBotWatchers(allWatchers);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <p className="text-muted-foreground text-xs">
          <T>
            The Bot writes these. Watchers check on a timer and tools run when the Bot asks. A
            reviewer model checks each version before it runs; you can run one once, pause or remove
            it, and move a watcher.
          </T>
        </p>
        <Button
          variant="ghost-muted"
          size="icon-xs"
          aria-label={gt("Refresh watchers and tools")}
          disabled={watchers.isPending}
          onClick={() => {
            watchers.refresh();
            secretGrants.refresh();
          }}
        >
          <RefreshCwIcon aria-hidden />
        </Button>
      </div>
      {watchers.data.approvals === "unverified" ? (
        <Alert variant="warning">
          <AlertTitle>
            <T>Approvals could not be verified</T>
          </AlertTitle>
          <AlertDescription>
            <T>
              The saved approvals failed their signature check, so every watcher and tool was
              dropped. The Bot can propose them again.
            </T>
          </AlertDescription>
        </Alert>
      ) : null}
      {secretGrants.data?.approvals === "unreadable" ? (
        <Alert variant="warning">
          <AlertTitle>
            <T>Secret grants could not be read</T>
          </AlertTitle>
          <AlertDescription>
            <T>
              The saved secret grants could not be read, so none of them is in effect for now. Try
              again in a moment.
            </T>
          </AlertDescription>
        </Alert>
      ) : null}
      {secretGrants.data?.approvals === "unverified" ? (
        <Alert variant="warning">
          <AlertTitle>
            <T>Secret grants could not be verified</T>
          </AlertTitle>
          <AlertDescription>
            <T>
              The saved secret grants failed their check, so none of them is in effect. Enter each
              one again in Settings.
            </T>
          </AlertDescription>
        </Alert>
      ) : null}
      {groups.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          <T>
            The Bot has no watchers or tools yet. Ask it to watch something or look something up and
            it will propose one.
          </T>
        </p>
      ) : (
        <ScrollArea className="max-h-[28rem]">
          {groups.map(({ group, watchers: inGroup }) => (
            <section key={group}>
              <GroupHeading group={group} count={inGroup.length} />
              <ul className="flex flex-col divide-y text-sm">
                {inGroup.map((watcher) => (
                  <WatcherCard
                    key={watcher.name}
                    threadRef={props.threadRef}
                    watcher={watcher}
                    usedBy={botWatchersUsingTool(allWatchers, watcher)}
                    linked={linked}
                    grants={grants}
                    secretGrants={secretGrants.data?.grants ?? null}
                  />
                ))}
              </ul>
            </section>
          ))}
        </ScrollArea>
      )}
    </div>
  );
}
