import type { McpServerStatus as ClaudeMcpServerStatus } from "@anthropic-ai/claude-agent-sdk";
import type { McpServerState, McpServerStatus } from "@t3tools/contracts";

const MAX_ERROR_LENGTH = 2_000;

const KNOWN_STATES: ReadonlySet<string> = new Set<McpServerState>([
  "connected",
  "failed",
  "needs-auth",
  "pending",
  "disabled",
]);

function remoteHost(config: ClaudeMcpServerStatus["config"]): string | null {
  const url = config !== undefined && "url" in config ? config.url : undefined;
  if (typeof url !== "string") return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

/**
 * Never forwards `config` itself: for remote servers it carries the request
 * headers, which are often credentials.
 */
export function toMcpServerStatus(status: ClaudeMcpServerStatus): McpServerStatus {
  return {
    name: status.name,
    // A newer CLI may add states; reading one as failed keeps the server listed
    // with its error text instead of dropping it from the panel.
    state: KNOWN_STATES.has(status.status) ? status.status : "failed",
    scope: status.scope ?? null,
    version: status.serverInfo?.version ?? null,
    error: status.error === undefined ? null : status.error.slice(0, MAX_ERROR_LENGTH),
    host: remoteHost(status.config),
  };
}
