/**
 * Where a file clicked inside the app should open.
 *
 * Settings → Integrations → Files lets the user choose between T3's files
 * panel, the preferred editor, and the file manager. This module turns that
 * preference plus the click plus what the connected server can actually do
 * into one answer, so chat markdown, diffs, and the file browser make the same
 * decision and offer the same escape hatch.
 *
 * @module fileOpenTarget
 */
import type { EnvironmentId, FileOpenTarget } from "@t3tools/contracts";

import type { RemoteOpenMode } from "./remoteOpen";
import { isTerminalLinkActivation } from "./terminal-links";

/**
 * Whether `shell.openInEditor` is worth offering at all. The RPC always acts on
 * the machine hosting the server, so it is only useful when the user is sitting
 * at that machine; a remote connection gets deep links or nothing instead.
 * Unresolved counts as unavailable so the first paint does not offer an action
 * that is about to disappear.
 */
export function canUseFileShellActions(
  environmentId: EnvironmentId | null,
  remoteOpenMode: RemoteOpenMode,
  isRemoteOpenResolved: boolean,
): boolean {
  return environmentId !== null && isRemoteOpenResolved && remoteOpenMode === "local-exec";
}

export interface ResolveFileOpenTargetInput {
  /** Cmd (macOS) / Ctrl (elsewhere) picks the destination the default did not. */
  readonly event: { readonly metaKey: boolean; readonly ctrlKey: boolean };
  readonly preference: FileOpenTarget;
  /**
   * Whether this client can run `shell.openInEditor` against the server *and*
   * an editor resolved from its `availableEditors`. False on a remote
   * connection, where the editor would open on a machine nobody is sitting at.
   */
  readonly canOpenInEditor: boolean;
  /**
   * Whether the server advertises `shellRevealInFileManager` and ships
   * `file-manager` among its editors. Callers pass the value they already
   * derived for the reveal menu item rather than re-deriving it.
   */
  readonly canRevealInFileManager: boolean;
  /** Defaults to `navigator.platform`; injected by tests. */
  readonly platform?: string;
}

function isTargetAvailable(target: FileOpenTarget, input: ResolveFileOpenTargetInput): boolean {
  if (target === "editor") return input.canOpenInEditor;
  if (target === "file-manager") return input.canRevealInFileManager;
  return true;
}

/**
 * The target a click resolves to.
 *
 * The modifier always picks the destination the preference did not, because a
 * modifier that lands where a plain click already lands is a dead gesture.
 * With the default preference ("panel") that reproduces the shipped rule
 * exactly — plain click opens the panel, Cmd/Ctrl-click opens the preferred
 * editor — and when the default is external the one-gesture way back is the
 * panel. File manager is not offered as an escape: it reveals rather than
 * opens, so it is a destination someone chooses, not one they fall back to.
 *
 * Anything the client cannot reach degrades to the panel instead of failing.
 * The panel is always reachable, so the ladder always terminates.
 */
export function resolveFileOpenTarget(input: ResolveFileOpenTargetInput): FileOpenTarget {
  const preferred = isTargetAvailable(input.preference, input) ? input.preference : "panel";
  const chosen = isTerminalLinkActivation(input.event, input.platform)
    ? preferred === "panel"
      ? "editor"
      : "panel"
    : preferred;
  return isTargetAvailable(chosen, input) ? chosen : "panel";
}
