import { useAtomValue } from "@effect/atom-react";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  type BotSecretGrant,
  type EnvironmentId,
  type SecretReference,
  ThreadId,
} from "@t3tools/contracts";
import { useLocation } from "@tanstack/react-router";
import * as Redacted from "effect/Redacted";
import { T, useGT } from "gt-react";
import { useState } from "react";

import { m } from "~/i18n/messages";
import { botFilesEnvironment } from "~/state/botFiles";
import { useQuietThreadShells } from "~/state/entities";
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
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import {
  botGrantTargets,
  validateBotSecretGrantDraft,
  type BotSecretGrantDraftResult,
} from "./BotSecretGrantsSettings.logic";
import { SecretSourceInput, useSecretSources } from "./SecretSourceInput";
import { useSearchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/** What a grant's dialog is for. Hosts and the value are saved together, so each edit asks for the value again. */
type Editing =
  | { readonly mode: "add" }
  | { readonly mode: "hosts" | "value"; readonly grant: BotSecretGrant };

const EXAMPLE_NAME = "GITHUB_TOKEN";
const REFERENCE_PROBE = { value: { type: "reference" } };

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

function GrantDialog(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  editing: Editing;
  onClose: () => void;
}) {
  const gt = useGT();
  const { environmentId, editing } = props;
  const grant = editing.mode === "add" ? null : editing.grant;
  const reportFailure = useFailureToast();
  const set = useAtomCommand(botFilesEnvironment.secretGrantSet, { reportFailure: false });
  const canStore = useAtomValue(botFilesEnvironment.secretGrantSet.permissionAtom(environmentId));
  const canReference = useAtomValue(
    botFilesEnvironment.secretGrantSet.permissionAtom(environmentId, REFERENCE_PROBE),
  );
  const sources = useSecretSources(environmentId);
  const [name, setName] = useState(grant?.name ?? "");
  const [hostsText, setHostsText] = useState(grant?.hosts.join("\n") ?? "");
  const [value, setValue] = useState<string | SecretReference>("");
  const [valueValid, setValueValid] = useState(true);
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);

  const draft = validateBotSecretGrantDraft({
    name,
    // Replacing the value keeps the hosts the grant already has.
    hostsText: editing.mode === "value" ? editing.grant.hosts.join(" ") : hostsText,
  });
  const valueReady = typeof value === "string" ? value.trim() !== "" : true;
  const allowed = typeof value === "string" ? canStore : canReference;
  const problem = (result: BotSecretGrantDraftResult) => {
    if (result.ok) return null;
    switch (result.issue) {
      case "name":
        return gt(
          "A name is capital letters, digits and underscores, and starts with a letter, such as GITHUB_TOKEN.",
        );
      case "hosts_required":
        return gt("Add at least one host.");
      case "hosts_too_many":
        return gt("A grant can allow at most 8 hosts.");
      case "host":
        return gt("{host} is not a host name such as api.example.com.", { host: result.host });
    }
  };

  const save = async () => {
    setAttempted(true);
    if (!draft.ok || !valueReady || !valueValid || !allowed || busy) return;
    setBusy(true);
    const result = await set({
      environmentId,
      input: {
        threadId: props.threadId,
        name: draft.name,
        hosts: draft.hosts,
        value:
          typeof value === "string"
            ? { type: "stored", secret: Redacted.make(value) }
            : { type: "reference", reference: value },
      },
    });
    setBusy(false);
    if (result._tag === "Success") {
      setValue("");
      props.onClose();
      return;
    }
    reportFailure(gt("Failed to save the secret grant"), result);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) props.onClose();
      }}
    >
      <DialogPopup showCloseButton={!busy}>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {editing.mode === "add"
                ? gt("Add a secret grant")
                : editing.mode === "hosts"
                  ? gt("Edit hosts of {name}", { name: editing.grant.name })
                  : gt("Replace the value of {name}", { name: editing.grant.name })}
            </DialogTitle>
            <DialogDescription>
              {editing.mode === "add" ? (
                <T>
                  The Bot's watchers can use this secret for requests to these hosts only. The Bot
                  never sees the value.
                </T>
              ) : (
                <T>
                  The value is never shown again, so saving asks for it once more. Hosts and value
                  are saved together.
                </T>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <label className="block space-y-1.5 text-sm">
              <span>
                <T>Name</T>
              </span>
              <Input
                autoFocus={editing.mode === "add"}
                value={name}
                disabled={busy || editing.mode !== "add"}
                placeholder={EXAMPLE_NAME}
                spellCheck={false}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            {editing.mode === "value" ? null : (
              <label className="block space-y-1.5 text-sm">
                <span>
                  <T>Hosts</T>
                </span>
                <Textarea
                  size="sm"
                  rows={3}
                  value={hostsText}
                  disabled={busy}
                  placeholder="api.github.com"
                  spellCheck={false}
                  onChange={(event) => setHostsText(event.target.value)}
                />
                <span className="block text-muted-foreground text-xs">
                  <T>One per line, up to 8. Requests to any other host get no secret.</T>
                </span>
              </label>
            )}
            <div className="space-y-1.5 text-sm">
              <label htmlFor="bot-secret-grant-value" className="block">
                <T>Value</T>
              </label>
              <SecretSourceInput
                id="bot-secret-grant-value"
                aria-label={gt("Secret value")}
                value={value}
                // A reference needs the permission to manage providers, so without it only a value is offered.
                sources={canReference ? sources : []}
                environmentId={environmentId}
                disabled={busy}
                autoFocus={editing.mode !== "add"}
                placeholder={gt("Paste the secret")}
                onChange={(event) => setValue(event.target.value)}
                onSecretChange={(secret) => setValue(secret ?? "")}
                onValidityChange={setValueValid}
              />
              {!canReference && sources.length > 0 ? (
                <p className="text-muted-foreground text-xs">
                  <T>Reading the secret from a provider needs permission to manage providers.</T>
                </p>
              ) : null}
            </div>
            {attempted && problem(draft) !== null ? (
              <p className="text-destructive text-xs" role="alert">
                {problem(draft)}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={busy} onClick={props.onClose}>
              <T>Cancel</T>
            </Button>
            <Button type="submit" disabled={busy || !valueReady || !valueValid || !allowed}>
              {busy ? <Spinner size="xs" /> : null} <T>Save</T>
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

function GrantRow(props: {
  grant: BotSecretGrant;
  canStore: boolean;
  canRemove: boolean;
  busy: boolean;
  onEdit: (editing: Editing) => void;
  onRemove: () => void;
}) {
  const gt = useGT();
  const { grant } = props;
  return (
    <SettingsRow
      title={<span className="font-mono">{grant.name}</span>}
      description={
        <span className="block space-y-0.5">
          <span className="block break-all">{grant.hosts.join(", ")}</span>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <Badge variant="outline" size="sm">
              {grant.source === "stored" ? <T>stored value</T> : <T>reference</T>}
            </Badge>
            {grant.lastUsedAt === undefined ? (
              <T>Not used yet</T>
            ) : (
              <span>
                <T>Last used</T> <RelativeTime timestamp={grant.lastUsedAt} />
              </span>
            )}
          </span>
        </span>
      }
      control={
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <Button
            size="xs"
            variant="outline"
            disabled={!props.canStore || props.busy}
            aria-label={gt("Edit hosts of {name}", { name: grant.name })}
            onClick={() => props.onEdit({ mode: "hosts", grant })}
          >
            <T>Edit hosts</T>
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={!props.canStore || props.busy}
            aria-label={gt("Replace the value of {name}", { name: grant.name })}
            onClick={() => props.onEdit({ mode: "value", grant })}
          >
            <T>Replace value</T>
          </Button>
          <Button
            size="xs"
            variant="ghost-destructive"
            disabled={!props.canRemove || props.busy}
            aria-label={gt("Remove {name}", { name: grant.name })}
            onClick={props.onRemove}
          >
            <T>Remove</T>
          </Button>
        </div>
      }
    />
  );
}

function BotGrants(props: { environmentId: EnvironmentId; threadId: ThreadId }) {
  const gt = useGT();
  const { environmentId, threadId } = props;
  const grants = useEnvironmentQuery(
    botFilesEnvironment.secretGrants({ environmentId, input: { threadId } }),
  );
  const canStore = useAtomValue(botFilesEnvironment.secretGrantSet.permissionAtom(environmentId));
  const canRemove = useAtomValue(
    botFilesEnvironment.secretGrantRemove.permissionAtom(environmentId),
  );
  const remove = useAtomCommand(botFilesEnvironment.secretGrantRemove, { reportFailure: false });
  const reportFailure = useFailureToast();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [removing, setRemoving] = useState<BotSecretGrant | null>(null);
  const [busy, setBusy] = useState(false);

  const removeGrant = async (grant: BotSecretGrant) => {
    setRemoving(null);
    setBusy(true);
    const result = await remove({ environmentId, input: { threadId, name: grant.name } });
    setBusy(false);
    reportFailure(gt("Failed to remove the secret grant"), result);
  };

  return (
    <>
      {grants.data === null ? (
        <SettingsRow
          title={grants.error ?? <T>Loading…</T>}
          control={
            grants.error === null ? null : (
              <Button size="xs" variant="outline" onClick={grants.refresh}>
                <T>Retry</T>
              </Button>
            )
          }
        />
      ) : (
        <>
          {grants.data.approvals === "unverified" ? (
            <div className="px-3 py-2 sm:px-4">
              <Alert variant="warning">
                <AlertTitle>
                  <T>Saved grants could not be verified</T>
                </AlertTitle>
                <AlertDescription>
                  <T>
                    The saved grants failed their check, so none of them is in effect. Enter each
                    one again.
                  </T>
                </AlertDescription>
              </Alert>
            </div>
          ) : null}
          {grants.data.grants.length === 0 ? (
            <SettingsRow
              title={<T>No secrets granted</T>}
              description={
                <T>A watcher that declares a secret cannot use it until you grant it here.</T>
              }
              control={
                <Button
                  size="xs"
                  variant="outline"
                  disabled={!canStore}
                  onClick={() => setEditing({ mode: "add" })}
                >
                  <T>Add grant</T>
                </Button>
              }
            />
          ) : (
            <>
              {grants.data.grants.map((grant) => (
                <GrantRow
                  key={grant.name}
                  grant={grant}
                  canStore={canStore}
                  canRemove={canRemove}
                  busy={busy}
                  onEdit={setEditing}
                  onRemove={() => setRemoving(grant)}
                />
              ))}
              <SettingsRow
                title={<T>Add a secret</T>}
                control={
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={!canStore}
                    onClick={() => setEditing({ mode: "add" })}
                  >
                    <T>Add grant</T>
                  </Button>
                }
              />
            </>
          )}
        </>
      )}
      {editing === null ? null : (
        <GrantDialog
          environmentId={environmentId}
          threadId={threadId}
          editing={editing}
          onClose={() => setEditing(null)}
        />
      )}
      <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {gt("Remove {name}?", { name: removing?.name ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              <T>
                Its stored value is deleted. Watchers that declare it stop getting it until you
                grant it again.
              </T>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              <T>Cancel</T>
            </AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => removing !== null && void removeGrant(removing)}
            >
              <T>Remove</T>
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

/**
 * The secrets the user lets a Bot's watchers use, and the hosts each may be sent to. The Bot is
 * Home unless the user came from another Bot's watchers, which pass theirs along.
 */
export function BotSecretGrantsSettings(props: {
  environmentId: EnvironmentId;
  homeThreadId: ThreadId | null;
}) {
  const gt = useGT();
  const setting = useSearchableSetting();
  const shells = useQuietThreadShells();
  const targets = botGrantTargets(shells, props.environmentId, props.homeThreadId);
  const requested = useLocation({ select: (location) => location.state.botSecretGrantsThreadId });
  // Read once: the settings page replaces the location state after it scrolls to the section.
  const [picked, setPicked] = useState<ThreadId | null>(
    requested === undefined ? null : ThreadId.make(requested),
  );
  const target = targets.find((candidate) => candidate.threadId === picked) ?? targets[0];
  if (target === undefined) return null;
  const nameOf = (candidate: (typeof targets)[number]) =>
    candidate.isHome ? gt("Home") : (candidate.title ?? gt("Bot"));

  return (
    <SettingsSection {...setting("bot-secret-grants")}>
      {targets.length > 1 ? (
        <SettingsRow
          title={<T>Bot</T>}
          description={<T>Each Bot has its own grants.</T>}
          control={
            <Select<ThreadId, false>
              value={target.threadId}
              onValueChange={(value) => {
                if (value !== null) setPicked(value);
              }}
            >
              <SelectTrigger size="sm" className="w-full min-w-0 sm:w-56" aria-label={gt("Bot")}>
                <SelectValue>
                  {(value: ThreadId) => {
                    const chosen = targets.find((candidate) => candidate.threadId === value);
                    return chosen === undefined ? value : nameOf(chosen);
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {targets.map((candidate) => (
                  <SelectItem key={candidate.threadId} value={candidate.threadId}>
                    <span className="block truncate">{nameOf(candidate)}</span>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      ) : null}
      <BotGrants
        key={target.threadId}
        environmentId={props.environmentId}
        threadId={target.threadId}
      />
    </SettingsSection>
  );
}
