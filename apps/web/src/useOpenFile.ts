/**
 * Opening a workspace file where the "Open files in" setting says.
 *
 * Every surface that opens a file without the user naming a destination —
 * a diff title, the file tree, a mention chip, the file palette — goes through
 * this hook, so the preference, the capability gating, and the modifier escape
 * are decided in one place instead of drifting per surface.
 *
 * Surfaces where the user *did* name a destination (`OpenInPicker`, the
 * "Open in <editor>" and "Reveal in <file manager>" context-menu items) call
 * the underlying commands directly and must not come through here.
 *
 * @module useOpenFile
 */
import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useCallback } from "react";

import { revealInFileManagerLabelForEnvironment } from "./components/preview/fileExplorerLabel";
import { toastManager } from "./components/ui/toast";
import { useOpenInPreferredEditor, usePreferredEditor } from "./editorPreferences";
import { canUseFileShellActions, resolveFileOpenTarget } from "./fileOpenTarget";
import { useClientSettings } from "./hooks/useSettings";
import { useRemoteOpenResolution } from "./remoteOpen";
import { useRightPanelStore } from "./rightPanelStore";
import { serverEnvironment } from "./state/server";
import { shellEnvironment } from "./state/shell";
import { useAtomCommand } from "./state/use-atom-command";
import { resolvePathLinkTarget } from "./terminal-links";

export interface OpenFileRequest {
  /** Workspace-relative path, which is what the files panel indexes by. */
  readonly workspacePath: string;
  readonly line?: number | undefined;
  /** The originating click, when there was one; palettes open without it. */
  readonly event?: { readonly metaKey: boolean; readonly ctrlKey: boolean } | undefined;
}

const NO_MODIFIER = { metaKey: false, ctrlKey: false } as const;

function reportOpenFailure(title: string, result: AtomCommandResult<unknown, unknown>): void {
  if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : "An error occurred.",
  });
}

/**
 * `cwd` is the workspace root the paths are relative to. Without it there is no
 * absolute path to hand the server, so editor and file-manager targets are
 * treated as unavailable and the file opens in the panel.
 */
export function useOpenFile(input: {
  readonly threadRef: ScopedThreadRef | null | undefined;
  readonly cwd: string | undefined;
}): (request: OpenFileRequest) => void {
  const { threadRef, cwd } = input;
  const environmentId = threadRef?.environmentId ?? null;
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const remoteOpen = useRemoteOpenResolution(environmentId);
  const availableEditors = serverConfig?.availableEditors ?? [];
  const [preferredEditor] = usePreferredEditor(availableEditors);
  const openInPreferredEditor = useOpenInPreferredEditor(environmentId, availableEditors);
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, { reportFailure: false });
  const preference = useClientSettings((settings) => settings.fileOpenTarget);

  const canUseShellActions =
    canUseFileShellActions(environmentId, remoteOpen.state.mode, remoteOpen.isResolved) &&
    cwd !== undefined;
  const canOpenInEditor = canUseShellActions && preferredEditor !== null;
  const canRevealInFileManager =
    canUseShellActions &&
    revealInFileManagerLabelForEnvironment(environmentId, serverConfig) !== undefined;

  return useCallback(
    (request) => {
      const target = resolveFileOpenTarget({
        event: request.event ?? NO_MODIFIER,
        preference,
        canOpenInEditor,
        canRevealInFileManager,
      });

      if (target === "panel") {
        if (!threadRef) return;
        useRightPanelStore.getState().openFile(threadRef, request.workspacePath, request.line);
        return;
      }

      // Guaranteed by the capability gate above: neither non-panel target is
      // reachable without a cwd to resolve the path against.
      const absolutePath = resolvePathLinkTarget(request.workspacePath, cwd ?? "");
      if (target === "editor") {
        void openInPreferredEditor(absolutePath).then((result) => {
          reportOpenFailure("Unable to open file", result);
        });
        return;
      }
      if (environmentId === null) return;
      void openInEditor({
        environmentId,
        input: { cwd: absolutePath, editor: "file-manager", reveal: true },
      }).then((result) => {
        reportOpenFailure("Unable to reveal file", result);
      });
    },
    [
      canOpenInEditor,
      canRevealInFileManager,
      cwd,
      environmentId,
      openInEditor,
      openInPreferredEditor,
      preference,
      threadRef,
    ],
  );
}
