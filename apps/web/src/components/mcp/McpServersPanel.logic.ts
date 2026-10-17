import type { McpServerState, McpServerStatus } from "@t3tools/contracts";
import type { SessionMcpServerList } from "@t3tools/client-runtime/state/mcp-servers";

export const MCP_SERVER_STATE_LABEL: Record<McpServerState, string> = {
  connected: "Connected",
  failed: "Failed",
  "needs-auth": "Needs sign-in",
  pending: "Connecting",
  disabled: "Disabled",
};

export const MCP_SERVER_STATE_BADGE: Record<
  McpServerState,
  "success" | "error" | "warning" | "info" | "secondary"
> = {
  connected: "success",
  failed: "error",
  "needs-auth": "warning",
  pending: "info",
  disabled: "secondary",
};

/**
 * Reconnect cannot sign a server in: the provider refuses rather than starting
 * a sign-in flow, so the row says where sign-in happens and that reconnect is
 * what picks it up afterwards.
 */
export const MCP_NEEDS_AUTH_HINT =
  "Sign in to this server from the provider's own CLI, then reconnect to pick it up.";

export function mcpServerActions(server: Pick<McpServerStatus, "state">): {
  readonly reconnect: boolean;
  readonly toggle: "enable" | "disable" | null;
} {
  switch (server.state) {
    case "disabled":
      return { reconnect: false, toggle: "enable" };
    // Already connecting; a second attempt would only race the first.
    case "pending":
      return { reconnect: false, toggle: null };
    case "connected":
    case "failed":
    case "needs-auth":
      return { reconnect: true, toggle: "disable" };
  }
}

/** Each says why the servers cannot be shown, which an empty list never would. */
export function mcpServersUnavailableCopy(
  reason: Extract<SessionMcpServerList, { status: "unavailable" }>["reason"],
): { readonly title: string; readonly description: string } {
  switch (reason) {
    case "session-stopped":
      return {
        title: "No running session",
        description:
          "MCP servers connect when this thread's provider session starts. Send a message to start one.",
      };
    case "session-unsupported":
      return {
        title: "This session cannot report MCP servers",
        description: "Its provider CLI is too old to answer. Updating it may help.",
      };
    case "provider-unsupported":
      return {
        title: "MCP servers are not available here",
        description: "This thread's provider cannot show or repair its MCP servers from T3.",
      };
    case "server-outdated":
      return {
        title: "MCP servers are not available here",
        description: "Update T3 Code on this environment to see its MCP servers.",
      };
  }
}
