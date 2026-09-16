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

/** Same wording keyed by an environment's reported OS rather than a
    navigator platform string, for actions that reveal on the server machine. */
export function revealInFileExplorerLabelForOs(os: ExecutionEnvironmentPlatformOs): string {
  if (os === "darwin") return "Reveal in Finder";
  if (os === "windows") return "Reveal in File Explorer";
  return "Reveal in Files";
}

/** Server-selected wording, including Windows File Explorer reached from WSL. */
export function revealInFileExplorerLabelForKind(kind: FileManagerRevealKind): string {
  if (kind === "finder") return "Reveal in Finder";
  if (kind === "file-explorer") return "Reveal in File Explorer";
  return "Reveal in Files";
}

/**
 * The reveal wording for one environment, or undefined when that environment
 * cannot reveal at all: the server has to advertise `shellRevealInFileManager`
 * and ship `file-manager` among its editors. Doubling as the capability check
 * keeps the menu item and the "Open files in" setting from disagreeing about
 * whether revealing is possible.
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
