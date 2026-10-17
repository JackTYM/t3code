import type {
  EnvironmentId,
  ExecutionEnvironmentPlatformOs,
  FileManagerRevealKind,
  ServerConfig,
} from "@t3tools/contracts";

export function revealInFileExplorerLabel(platform: string): string {
  const normalized = platform.toLowerCase();
  if (normalized.includes("mac")) return "Reveal in Finder";
  if (normalized.includes("win")) return "Reveal in File Explorer";
  return "Reveal in Files";
}

export function revealInFileExplorerLabelForOs(os: ExecutionEnvironmentPlatformOs): string {
  if (os === "darwin") return "Reveal in Finder";
  if (os === "windows") return "Reveal in File Explorer";
  return "Reveal in Files";
}

export function revealInFileExplorerLabelForKind(kind: FileManagerRevealKind): string {
  if (kind === "finder") return "Reveal in Finder";
  if (kind === "file-explorer") return "Reveal in File Explorer";
  return "Reveal in Files";
}

/**
 * Undefined when the environment cannot reveal at all: the server must
 * advertise `shellRevealInFileManager` and ship `file-manager` among its
 * editors. Doubles as the capability check so the menu item and the "Open
 * files in" setting cannot disagree.
 */
export function revealInFileManagerLabelForEnvironment(
  environmentId: EnvironmentId | null,
  serverConfig: ServerConfig | null | undefined,
): string | undefined {
  if (environmentId === null || serverConfig == null) return undefined;
  if (serverConfig.shellRevealInFileManager !== true) return undefined;
  if (!serverConfig.availableEditors.includes("file-manager")) return undefined;
  return serverConfig.shellRevealInFileManagerKind === undefined
    ? revealInFileExplorerLabelForOs(serverConfig.environment.platform.os)
    : revealInFileExplorerLabelForKind(serverConfig.shellRevealInFileManagerKind);
}
