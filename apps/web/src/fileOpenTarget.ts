/**
 * Where a file clicked inside the app should open: the user's preference, the click, and
 * what the connected server can do resolve to one answer, so chat markdown, diffs, and the
 * file browser decide identically.
 */
import type { EnvironmentId, FileOpenTarget } from "@t3tools/contracts";

import type { RemoteOpenMode } from "./remoteOpen";
import { isTerminalLinkActivation } from "./terminal-links";

/**
 * `shell.openInEditor` acts on the machine hosting the server, so offer it only when the user
 * is at that machine; remote connections get deep links or nothing. Unresolved counts as
 * unavailable so the first paint does not offer an action that is about to disappear.
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
 * The modifier always picks the destination the preference did not, so it is never a dead
 * gesture. The file manager is never an escape: it reveals rather than opens. Anything the
 * client cannot reach degrades to the panel, which is always reachable.
 */
export function resolveFileOpenTarget(input: ResolveFileOpenTargetInput): FileOpenTarget {
  const preferred = isTargetAvailable(input.preference, input) ? input.preference : "panel";
  const modified =
    (input.event.metaKey || input.event.ctrlKey) &&
    isTerminalLinkActivation(input.event, input.platform);
  const chosen = modified ? (preferred === "panel" ? "editor" : "panel") : preferred;
  return isTargetAvailable(chosen, input) ? chosen : "panel";
}
