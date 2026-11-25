import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  BOT_MAIL_MAX_DIGEST_WINDOW_MINUTES,
  BOT_MAIL_MAX_RETENTION_DAYS,
  type BotMailBackfillStatus,
  type BotMailHookSetup,
  type BotMailStatus,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { CheckIcon, CopyIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useLiveRefresh } from "~/hooks/useLiveRefresh";
import { m } from "~/i18n/messages";
import { botFilesEnvironment } from "~/state/botFiles";
import { useLinkedEnvironments } from "~/state/peerLinks";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
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
import {
  ANCHORED_COPY_TOAST_TIMEOUT_MS,
  showAnchoredCopyErrorToast,
} from "../ui/anchoredCopyToast";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import {
  BOT_MAIL_BACKFILL_DAYS,
  botMailCountRows,
  botMailDroppedMailboxes,
  botMailDeliveryOutcome,
  botMailHookControls,
  botMailHookProblem,
  botMailImportControl,
  botMailImportDays,
  botMailImportKind,
  botMailImportTarget,
  botMailSaveControl,
  botMailSettingsPlan,
  botMailTotals,
  botMailUnknownAccounts,
  EMPTY_BOT_MAIL_SETTINGS_DRAFT,
  parseBotMailMailbox,
  type BotMailBackfillDays,
  type BotMailBlock,
  type BotMailMailboxProblem,
  type BotMailSettingsDraft,
} from "./BotMailView.logic";

// The names the mail Worker reads these from; they are not translated.
const BOX_URL = "BOX_URL";
const WEBHOOK_SECRET = "WEBHOOK_SECRET";

type Grants = { readonly operate: boolean };

function useBlockedReason() {
  const gt = useGT();
  return (block: BotMailBlock): string => {
    switch (block) {
      case "needs_operate_access":
        return gt("This connection cannot change threads on this environment.");
      case "hook_exists":
        return gt("This Bot already has a mail hook.");
      case "no_hook":
        return gt("Create the mail hook first.");
      case "no_linked_environment":
        return gt("No machine is linked to this environment.");
      case "import_running":
        return gt("An import is already running.");
      case "nothing_to_save":
        return gt("Nothing has changed.");
    }
  };
}

function useFailureToast() {
  const gt = useGT();
  return (title: string, result: AtomCommandResult<unknown, unknown>) => {
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    toastManager.add({
      type: "error",
      title,
      description:
        thrownErrorMessage(squashAtomCommandFailure(result), m) ?? gt("An error occurred."),
    });
  };
}

function CopyRow(props: { label: string; value: string }) {
  const gt = useGT();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({
    onError: (error) => showAnchoredCopyErrorToast(buttonRef, error),
    timeout: ANCHORED_COPY_TOAST_TIMEOUT_MS * 2,
  });
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs">{props.label}</span>
      <div className="flex items-start gap-1.5">
        <code className="min-w-0 flex-1 select-all rounded-md bg-muted/50 p-2 font-mono text-foreground text-xs break-all">
          {props.value}
        </code>
        <Button
          ref={buttonRef}
          size="xs"
          variant="outline"
          aria-label={gt("Copy {label}", { label: props.label })}
          onClick={() => copyToClipboard(props.value, undefined)}
        >
          {isCopied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
          {isCopied ? <T>Copied</T> : <T>Copy</T>}
        </Button>
      </div>
    </div>
  );
}

type Reveal = { readonly setup: BotMailHookSetup; readonly via: "create" | "rotate" };

/** The delivery address and the secret, shown once and gone when dismissed. */
function HookReveal(props: { reveal: Reveal; onDismiss: () => void }) {
  const gt = useGT();
  const { setup, via } = props.reveal;
  const hasSecret = setup.secret !== undefined;
  return (
    <Alert variant={hasSecret ? "warning" : "info"}>
      <AlertTitle>
        {hasSecret ? (
          via === "rotate" ? (
            <T>New secret: copy it now</T>
          ) : (
            <T>Copy these now</T>
          )
        ) : (
          <T>This Bot already had a mail hook</T>
        )}
      </AlertTitle>
      <AlertDescription>
        {setup.url === null ? (
          <>
            <p>
              <T>
                The hook exists but has no public address, because T3 Connect is off for this
                environment. A mail Worker on Cloudflare cannot reach it until it has one: turn on
                T3 Connect and rotate the secret to get the address, or put your own public address
                in front of this path.
              </T>
            </p>
            <CopyRow label={gt("Path on this server")} value={setup.path} />
          </>
        ) : (
          <CopyRow label={BOX_URL} value={setup.url} />
        )}
        {setup.secret === undefined ? (
          <p>
            <T>
              Its secret was shown when it was made and is not kept anywhere you can read it. Rotate
              the secret if you need a new one.
            </T>
          </p>
        ) : (
          <>
            <CopyRow label={WEBHOOK_SECRET} value={setup.secret} />
            <p>
              <T>
                The secret will not be shown again, and closing this popover hides it too. Set these
                as BOX_URL and WEBHOOK_SECRET on your mail Worker; see the mail Worker guide.
              </T>
            </p>
          </>
        )}
        <p className="text-xs">
          {gt(
            "The Worker signs each request body with HMAC-SHA256 and sends it in the {header} header, as {prefix} followed by the hex digest.",
            {
              header: setup.signatureHeader,
              prefix: setup.signaturePrefix,
            },
          )}
        </p>
        <Button size="xs" variant="outline" className="self-end" onClick={props.onDismiss}>
          {hasSecret ? <T>I have copied them</T> : <T>Dismiss</T>}
        </Button>
      </AlertDescription>
    </Alert>
  );
}

function DeliveryLine(props: { hook: NonNullable<BotMailStatus["hook"]> }) {
  const gt = useGT();
  const { lastDeliveryAt, lastOutcome } = props.hook;
  if (lastDeliveryAt === undefined) {
    return (
      <p className="text-muted-foreground text-xs">
        <T>Nothing has been delivered yet.</T>
      </p>
    );
  }
  const outcome = botMailDeliveryOutcome(lastOutcome ?? "");
  const label =
    outcome.kind === "accepted"
      ? gt("accepted")
      : outcome.kind === "rejected_signature"
        ? gt("rejected: wrong secret")
        : outcome.kind === "dispatch_failed"
          ? gt("failed to store")
          : outcome.kind === "rate_limited"
            ? gt("rate limited")
            : outcome.kind === "disabled"
              ? gt("hook was off")
              : outcome.kind === "expired"
                ? gt("expired")
                : outcome.raw;
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-xs">
      <T>Last delivery</T> <RelativeTime timestamp={lastDeliveryAt} />
      {lastOutcome === undefined ? null : (
        <Badge
          variant={
            outcome.tone === "good" ? "success" : outcome.tone === "bad" ? "error" : "outline"
          }
        >
          {label}
        </Badge>
      )}
    </p>
  );
}

function HookSection(props: {
  threadRef: ScopedThreadRef;
  hook: BotMailStatus["hook"];
  grants: Grants;
}) {
  const gt = useGT();
  const blockedReason = useBlockedReason();
  const failed = useFailureToast();
  const { environmentId, threadId } = props.threadRef;
  const createHook = useAtomCommand(botFilesEnvironment.mailCreateHook, { reportFailure: false });
  const rotateHook = useAtomCommand(botFilesEnvironment.mailRotateHook, { reportFailure: false });
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [busy, setBusy] = useState<"create" | "rotate" | null>(null);
  const [confirmingRotate, setConfirmingRotate] = useState(false);

  const controls = botMailHookControls(props.hook, props.grants);
  const problem = props.hook === undefined ? null : botMailHookProblem(props.hook);
  const relevant = props.hook === undefined ? controls.create : controls.rotate;
  const reason = relevant.enabled ? null : blockedReason(relevant.reason);

  const create = async () => {
    setBusy("create");
    const result = await createHook({ environmentId, input: { threadId } });
    setBusy(null);
    if (result._tag === "Success") setReveal({ setup: result.value, via: "create" });
    else failed(gt("Failed to create the mail hook"), result);
  };
  const rotate = async () => {
    setConfirmingRotate(false);
    setBusy("rotate");
    const result = await rotateHook({ environmentId, input: { threadId } });
    setBusy(null);
    if (result._tag === "Success") setReveal({ setup: result.value, via: "rotate" });
    else failed(gt("Failed to rotate the secret"), result);
  };

  return (
    <section className="flex flex-col gap-2">
      <h3 className="font-medium text-sm">
        <T>1. Mail hook</T>
      </h3>
      {props.hook === undefined ? (
        <p className="text-muted-foreground text-xs">
          <T>
            Your mail Worker posts each forwarded email to a hook on this environment, signed with a
            secret. Create the hook to get its address and secret.
          </T>
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant={props.hook.enabled ? "success" : "warning"}>
              {props.hook.enabled ? <T>on</T> : <T>off</T>}
            </Badge>
            <Badge variant={props.hook.signed ? "success" : "warning"}>
              {props.hook.signed ? <T>signed</T> : <T>not signed</T>}
            </Badge>
          </div>
          <DeliveryLine hook={props.hook} />
        </div>
      )}
      {problem === "disabled" ? (
        <p className="text-warning-foreground text-xs">
          <T>The hook is turned off, so forwarded mail is refused.</T>
        </p>
      ) : problem === "unsigned" ? (
        <p className="text-warning-foreground text-xs">
          <T>
            This hook has no secret, so anyone with its address can post mail to it. Rotate the
            secret to add one.
          </T>
        </p>
      ) : problem === "signature_rejected" ? (
        <p className="text-warning-foreground text-xs">
          <T>
            The last delivery was refused because its signature did not match. Set the current
            secret as WEBHOOK_SECRET on your mail Worker, or rotate it to get a new one.
          </T>
        </p>
      ) : null}
      {reveal === null ? null : <HookReveal reveal={reveal} onDismiss={() => setReveal(null)} />}
      <div className="flex flex-wrap items-center gap-1.5">
        {props.hook === undefined ? (
          <Button
            size="xs"
            disabled={!controls.create.enabled || busy !== null}
            onClick={() => void create()}
          >
            {busy === "create" ? <T>Creating…</T> : <T>Create the mail hook</T>}
          </Button>
        ) : (
          <Button
            size="xs"
            variant="outline"
            disabled={!controls.rotate.enabled || busy !== null}
            onClick={() => setConfirmingRotate(true)}
          >
            {busy === "rotate" ? <T>Rotating…</T> : <T>Rotate secret</T>}
          </Button>
        )}
      </div>
      {reason === null ? null : <p className="text-muted-foreground text-xs">{reason}</p>}

      <AlertDialog open={confirmingRotate} onOpenChange={setConfirmingRotate}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <T>Rotate the mail secret?</T>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <T>
                Mail signed with the old secret is refused immediately, and the Worker drops it,
                until you set the new secret as WEBHOOK_SECRET on your mail Worker. The new secret
                is shown once.
              </T>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              <T>Cancel</T>
            </AlertDialogClose>
            <Button variant="destructive" onClick={() => void rotate()}>
              <T>Rotate secret</T>
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </section>
  );
}

function useMailboxProblem() {
  const gt = useGT();
  return (problem: BotMailMailboxProblem): string | null => {
    switch (problem) {
      case "empty":
        return null;
      case "invalid":
        return gt("That does not look like an address, such as name@example.com.");
      case "too_long":
        return gt("That address is too long.");
      case "duplicate":
        return gt("That address is already on the list.");
      case "too_many":
        return gt("The list is full.");
    }
  };
}

function MailboxesSection(props: {
  threadRef: ScopedThreadRef;
  status: BotMailStatus;
  grants: Grants;
}) {
  const gt = useGT();
  const blockedReason = useBlockedReason();
  const mailboxProblem = useMailboxProblem();
  const failed = useFailureToast();
  const { environmentId, threadId } = props.threadRef;
  const setMailboxes = useAtomCommand(botFilesEnvironment.mailSetMailboxes, {
    reportFailure: false,
  });
  // The draft follows the server until the user changes a field, so a refresh never loses it.
  const [draft, setDraft] = useState<BotMailSettingsDraft>(EMPTY_BOT_MAIL_SETTINGS_DRAFT);
  const [address, setAddress] = useState("");
  const [problem, setProblem] = useState<BotMailMailboxProblem | null>(null);
  const [busy, setBusy] = useState(false);

  const plan = botMailSettingsPlan(props.status, draft);
  const saveControl = botMailSaveControl(plan, props.grants);
  const counts = new Map(botMailCountRows(props.status).map((row) => [row.mailbox, row]));
  const unlisted = botMailCountRows(props.status).filter((row) => !row.listed);
  const unknown = botMailUnknownAccounts(props.status);
  const dropped = botMailDroppedMailboxes(props.status);
  const clearDropped = useAtomCommand(botFilesEnvironment.mailClearDropped, {
    reportFailure: false,
  });
  const editable = props.grants.operate && !busy;
  const problemText = problem === null ? null : mailboxProblem(problem);

  const add = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = parseBotMailMailbox(address, plan.mailboxes);
    if (!parsed.ok) {
      setProblem(parsed.problem);
      return;
    }
    setProblem(null);
    setAddress("");
    setDraft({ ...draft, mailboxes: [...plan.mailboxes, parsed.address] });
  };
  const remove = (mailbox: string) =>
    setDraft({ ...draft, mailboxes: plan.mailboxes.filter((entry) => entry !== mailbox) });

  const save = async () => {
    if (plan.save === undefined) return;
    setBusy(true);
    const result = await setMailboxes({ environmentId, input: { threadId, ...plan.save } });
    setBusy(false);
    if (result._tag === "Success") setDraft(EMPTY_BOT_MAIL_SETTINGS_DRAFT);
    else failed(gt("Failed to save the mailboxes"), result);
  };
  // Only the list is sent, so a number being edited stays as typed.
  const allow = async (mailbox: string) => {
    setBusy(true);
    const result = await setMailboxes({
      environmentId,
      input: { threadId, mailboxes: [...plan.mailboxes, mailbox] },
    });
    setBusy(false);
    if (result._tag === "Success") setDraft({ ...draft, mailboxes: null });
    else failed(gt("Failed to allow the account"), result);
  };

  const clear = async () => {
    setBusy(true);
    const result = await clearDropped({ environmentId, input: { threadId } });
    setBusy(false);
    failed(gt("Failed to clear the dropped mail"), result);
  };

  return (
    <section className="flex min-w-0 flex-col gap-2">
      <h3 className="font-medium text-sm">
        <T>2. Mailboxes</T>
      </h3>
      <p className="text-muted-foreground text-xs">
        <T>
          The Bot keeps mail only for your own addresses listed here, spelled as mail arrives at
          them (Gmail dots and +tags count as different addresses). Your mail Worker's MAILBOXES
          must list the same ones. Nothing is kept until you add one.
        </T>
      </p>
      {plan.mailboxes.length === 0 ? (
        <p className="text-sm">
          <T>No addresses yet. The Bot keeps no mail.</T>
        </p>
      ) : (
        <ul className="flex flex-col divide-y text-sm">
          {plan.mailboxes.map((mailbox) => {
            const row = counts.get(mailbox);
            return (
              <li key={mailbox} className="flex items-center gap-2 py-1.5">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{mailbox}</span>
                  <span className="text-muted-foreground text-xs">
                    {gt("{forward} forwarded · {backfill} imported", {
                      forward: row?.forward ?? 0,
                      backfill: row?.backfill ?? 0,
                    })}
                  </span>
                </div>
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label={gt("Remove {address}", { address: mailbox })}
                  disabled={!editable}
                  onClick={() => remove(mailbox)}
                >
                  <XIcon aria-hidden />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      <form className="flex flex-col gap-1" onSubmit={add}>
        <div className="flex items-center gap-1.5">
          <Input
            size="sm"
            type="email"
            autoComplete="off"
            spellCheck={false}
            value={address}
            disabled={!editable}
            aria-invalid={problemText === null ? undefined : true}
            aria-label={gt("Add an address")}
            placeholder={gt("name@example.com")}
            onChange={(event) => {
              setAddress(event.target.value);
              setProblem(null);
            }}
          />
          <Button
            size="xs"
            variant="outline"
            type="submit"
            disabled={!editable || address.trim().length === 0}
          >
            <T>Add</T>
          </Button>
        </div>
        {problemText === null ? null : (
          <p className="text-destructive-foreground text-xs">{problemText}</p>
        )}
      </form>
      {unlisted.length === 0 ? null : (
        <ul className="flex flex-col text-muted-foreground text-xs">
          {unlisted.map((row) => (
            <li key={row.mailbox}>
              {gt(
                "{mailbox} is not on the list; its {count, plural, one {# kept email} other {# kept emails}} age out with the retention.",
                { mailbox: row.mailbox, count: row.forward + row.backfill },
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="bot-mail-retention">
            <T>Keep mail for (days)</T>
          </Label>
          <Input
            id="bot-mail-retention"
            size="sm"
            inputMode="numeric"
            value={plan.retentionText}
            disabled={!editable}
            aria-invalid={plan.retentionValid ? undefined : true}
            onChange={(event) => setDraft({ ...draft, retention: event.target.value })}
          />
          <span className="text-muted-foreground text-xs">
            {gt("1 to {max}", { max: BOT_MAIL_MAX_RETENTION_DAYS })}
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="bot-mail-digest">
            <T>Tell the Bot at most every (minutes)</T>
          </Label>
          <Input
            id="bot-mail-digest"
            size="sm"
            inputMode="numeric"
            value={plan.digestText}
            disabled={!editable}
            aria-invalid={plan.digestValid ? undefined : true}
            onChange={(event) => setDraft({ ...draft, digest: event.target.value })}
          />
          <span className="text-muted-foreground text-xs">
            {gt("1 to {max}", { max: BOT_MAIL_MAX_DIGEST_WINDOW_MINUTES })}
          </span>
        </div>
      </div>
      <div className="flex items-center justify-end gap-1.5">
        {plan.changed ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={() => setDraft(EMPTY_BOT_MAIL_SETTINGS_DRAFT)}
          >
            <T>Discard changes</T>
          </Button>
        ) : null}
        <Button size="xs" disabled={!saveControl.enabled || busy} onClick={() => void save()}>
          {busy ? <T>Saving…</T> : <T>Save</T>}
        </Button>
      </div>
      {!saveControl.enabled && saveControl.reason === "needs_operate_access" ? (
        <p className="text-muted-foreground text-xs">{blockedReason(saveControl.reason)}</p>
      ) : !plan.retentionValid || !plan.digestValid ? (
        <p className="text-destructive-foreground text-xs">
          <T>Use whole numbers within the ranges shown.</T>
        </p>
      ) : null}

      {props.status.dropped === undefined ? null : (
        <div className="flex flex-col gap-1.5 rounded-lg border p-2">
          <p className="text-muted-foreground text-xs">
            {gt(
              "{count, plural, one {# email was} other {# emails were}} dropped because the address it was sent to is not on your list. Apple Hide My Email addresses arrive like this.",
              { count: props.status.dropped.count },
            )}
          </p>
          {dropped.length === 0 ? null : (
            <ul className="flex flex-col divide-y text-sm">
              {dropped.map((entry) => (
                <li key={entry.mailbox} className="flex items-center gap-2 py-1.5">
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-mono text-xs">{entry.mailbox}</span>
                    <span className="text-muted-foreground text-xs">
                      {gt("{count, plural, one {# email} other {# emails}} dropped", {
                        count: entry.count,
                      })}
                    </span>
                  </div>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={!editable}
                    onClick={() => void allow(entry.mailbox)}
                  >
                    <T>Add to my addresses</T>
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <Button
            size="xs"
            variant="ghost"
            className="self-end"
            disabled={!editable}
            onClick={() => void clear()}
          >
            <T>Clear</T>
          </Button>
        </div>
      )}

      {unknown.length === 0 ? null : (
        <div className="flex flex-col gap-1.5 rounded-lg border p-2">
          <p className="text-muted-foreground text-xs">
            <T>
              The import found mail in Mail accounts whose address it could not work out. None of it
              is kept unless you allow that exact placeholder.
            </T>
          </p>
          <ul className="flex flex-col divide-y text-sm">
            {unknown.map((account) => (
              <li key={account.mailbox} className="flex items-center gap-2 py-1.5">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span>
                    {gt(
                      "unknown account ({count, plural, one {# message} other {# messages}} seen)",
                      { count: account.seen },
                    )}
                  </span>
                  <span className="truncate font-mono text-muted-foreground text-xs">
                    {account.mailbox}
                  </span>
                </div>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={!editable}
                  onClick={() => void allow(account.mailbox)}
                >
                  <T>Allow</T>
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function BackfillSummary(props: { backfill: BotMailBackfillStatus; machine: string | undefined }) {
  const gt = useGT();
  const { backfill } = props;
  const machine = props.machine ?? gt("A linked environment");
  return (
    <div className="flex flex-col gap-1 rounded-lg border p-2 text-xs">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Badge
          variant={
            backfill.state === "done"
              ? "success"
              : backfill.state === "failed"
                ? "error"
                : backfill.state === "waiting"
                  ? "warning"
                  : "info"
          }
        >
          {backfill.state === "done" ? (
            <T>done</T>
          ) : backfill.state === "failed" ? (
            <T>failed</T>
          ) : backfill.state === "waiting" ? (
            <T>waiting</T>
          ) : (
            <T>running</T>
          )}
        </Badge>
        <span className="text-muted-foreground">
          {gt(
            "{machine} · last {days} days · {count, plural, one {# email} other {# emails}} kept",
            {
              machine,
              days: backfill.sinceDays,
              count: backfill.stored,
            },
          )}
        </span>
        <span className="text-muted-foreground">
          <RelativeTime timestamp={backfill.updatedAt} />
        </span>
      </div>
      {backfill.state === "running" ? (
        <p className="text-muted-foreground">
          <T>Importing in the background. Refresh to see how far it got.</T>
        </p>
      ) : null}
      {backfill.state === "waiting" ? (
        <p className="text-muted-foreground">
          <T>
            The machine did not answer, so the import stopped where it was. This is not a failure:
            import again when it is awake and connected.
          </T>
        </p>
      ) : null}
      {backfill.reason === undefined ? null : (
        <p className={backfill.state === "failed" ? "text-destructive-foreground" : undefined}>
          {backfill.reason}
        </p>
      )}
    </div>
  );
}

function ImportSection(props: {
  threadRef: ScopedThreadRef;
  status: BotMailStatus;
  grants: Grants;
}) {
  const gt = useGT();
  const blockedReason = useBlockedReason();
  const failed = useFailureToast();
  const { environmentId, threadId } = props.threadRef;
  const backfillCommand = useAtomCommand(botFilesEnvironment.mailBackfill, {
    reportFailure: false,
  });
  const { backfill } = props.status;
  const linked = useLinkedEnvironments(environmentId, backfill?.environmentId);
  const [pickedEnvironment, setPickedEnvironment] = useState<EnvironmentId | null>(null);
  const [pickedDays, setPickedDays] = useState<BotMailBackfillDays | null>(null);
  const [busy, setBusy] = useState(false);

  const target = botMailImportTarget(linked, pickedEnvironment, backfill?.environmentId);
  const days = botMailImportDays(pickedDays, backfill?.sinceDays);
  const control = botMailImportControl({ backfill, environmentId: target, grants: props.grants });
  const kind = botMailImportKind(backfill, target, days);

  const start = async () => {
    if (target === null) return;
    setBusy(true);
    const result = await backfillCommand({
      environmentId,
      input: { threadId, environmentId: target, sinceDays: days },
    });
    setBusy(false);
    failed(gt("Failed to start the import"), result);
  };

  return (
    <section className="flex flex-col gap-2">
      <h3 className="font-medium text-sm">
        <T>3. History import</T>
      </h3>
      <p className="text-muted-foreground text-xs">
        <T>
          Pull mail the Mail app already holds on a linked Mac. It never wakes the Bot, and only the
          addresses above are kept. macOS must allow the T3 Code server on that Mac to read Mail
          (System Settings → Privacy & Security → Full Disk Access).
        </T>
      </p>
      {linked.size === 0 ? (
        <p className="text-muted-foreground text-sm">
          <T>
            No machine is linked to this environment. Link your Mac with full access first (Settings
            → Environments → Linked environments).
          </T>
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          <Select<EnvironmentId, false>
            value={target}
            disabled={busy}
            onValueChange={(value) => {
              if (value !== null) setPickedEnvironment(value);
            }}
          >
            <SelectTrigger size="xs" variant="ghost" aria-label={gt("Machine to import from")}>
              <SelectValue>
                {(value: EnvironmentId) => linked.get(value) ?? gt("A linked environment")}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="start" alignItemWithTrigger={false}>
              {[...linked].map(([id, name]) => (
                <SelectItem hideIndicator key={id} value={id}>
                  {name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <Select<BotMailBackfillDays, false>
            value={days}
            disabled={busy}
            onValueChange={(value) => {
              if (value !== null) setPickedDays(value);
            }}
          >
            <SelectTrigger size="xs" variant="ghost" aria-label={gt("How far back")}>
              <SelectValue>
                {(value: BotMailBackfillDays) => gt("Last {days} days", { days: value })}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="start" alignItemWithTrigger={false}>
              {BOT_MAIL_BACKFILL_DAYS.map((option) => (
                <SelectItem hideIndicator key={option} value={option}>
                  {gt("Last {days} days", { days: option })}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <Button size="xs" disabled={!control.enabled || busy} onClick={() => void start()}>
            {kind === "resume" ? (
              <T>Resume import</T>
            ) : kind === "again" ? (
              <T>Import again</T>
            ) : (
              <T>Import history</T>
            )}
          </Button>
        </div>
      )}
      {!control.enabled && linked.size > 0 ? (
        <p className="text-muted-foreground text-xs">{blockedReason(control.reason)}</p>
      ) : null}
      {backfill === undefined ? null : (
        <BackfillSummary backfill={backfill} machine={linked.get(backfill.environmentId)} />
      )}
    </section>
  );
}

/**
 * The Bot's mail inbox: the hook the Worker posts to, which addresses are kept, and the history
 * import. There is no list of emails to forget from, because no call returns the user one.
 */
export function BotMailView(props: { threadRef: ScopedThreadRef }) {
  const gt = useGT();
  const { environmentId, threadId } = props.threadRef;
  const status = useEnvironmentQuery(
    botFilesEnvironment.mailStatus({ environmentId, input: { threadId } }),
  );
  // Every permission is read before any is combined, since a short-circuit would skip a hook.
  const canSetMailboxes = useAtomValue(
    botFilesEnvironment.mailSetMailboxes.permissionAtom(environmentId),
  );
  const canBackfill = useAtomValue(botFilesEnvironment.mailBackfill.permissionAtom(environmentId));
  const canCreateHook = useAtomValue(
    botFilesEnvironment.mailCreateHook.permissionAtom(environmentId),
  );
  const canRotateHook = useAtomValue(
    botFilesEnvironment.mailRotateHook.permissionAtom(environmentId),
  );
  const canClearDropped = useAtomValue(
    botFilesEnvironment.mailClearDropped.permissionAtom(environmentId),
  );
  const grants = {
    operate: canSetMailboxes && canBackfill && canCreateHook && canRotateHook && canClearDropped,
  };

  // Nothing pushes mail changes, so opening the tab and coming back to the window ask again; a
  // read already in flight stands for the new one.
  const refreshIfIdle = () => {
    if (!status.isPending) status.refresh();
  };
  useLiveRefresh(refreshIfIdle, {
    key: `bot-mail:${environmentId}:${threadId}`,
    intervalMs: null,
    refreshOnShow: true,
  });

  if (status.data === null) {
    return <p className="text-muted-foreground text-sm">{status.error ?? <T>Loading…</T>}</p>;
  }
  const { data } = status;
  const totals = botMailTotals(data);

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <p className="text-muted-foreground text-xs">
          {data.lastReceivedAt === undefined ? (
            <T>No mail received yet.</T>
          ) : (
            <>
              <T>Last mail received</T> <RelativeTime timestamp={data.lastReceivedAt} />
            </>
          )}
          {data.forgotten === 0 ? null : ` · ${gt("{count} forgotten", { count: data.forgotten })}`}
        </p>
        <Button
          variant="ghost-muted"
          size="icon-xs"
          aria-label={gt("Refresh mail")}
          disabled={status.isPending}
          onClick={status.refresh}
        >
          <RefreshCwIcon aria-hidden />
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">
        {gt("{stored} stored · {bulk} bulk (never wakes the Bot) · {dropped} dropped", {
          stored: totals.stored,
          bulk: totals.bulk,
          dropped: totals.dropped,
        })}
      </p>
      <ScrollArea className="max-h-[28rem]">
        <div className="flex min-w-0 flex-col gap-5">
          <HookSection threadRef={props.threadRef} hook={data.hook} grants={grants} />
          <MailboxesSection threadRef={props.threadRef} status={data} grants={grants} />
          <ImportSection threadRef={props.threadRef} status={data} grants={grants} />
        </div>
      </ScrollArea>
    </div>
  );
}
