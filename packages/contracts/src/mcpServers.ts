import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * The MCP servers of one thread's live provider session. Scoped to the session
 * because that is where the connections live: a provider reads its MCP config
 * when its process starts, so two threads can disagree about the same server.
 */

export const McpServerState = Schema.Literals([
  "connected",
  "failed",
  "needs-auth",
  "pending",
  "disabled",
]);
export type McpServerState = typeof McpServerState.Type;

export const McpServerStatus = Schema.Struct({
  name: Schema.String,
  state: McpServerState,
  /** Where the server is configured, for example project, user, or local. */
  scope: Schema.NullOr(Schema.String),
  version: Schema.NullOr(Schema.String),
  /** The server's own failure text, because it is usually what says what to fix. */
  error: Schema.NullOr(Schema.String),
  /**
   * Only the host of a remote server: its path and query can carry credentials,
   * and the host is enough to tell servers apart.
   */
  host: Schema.NullOr(Schema.String),
});
export type McpServerStatus = typeof McpServerStatus.Type;

export const McpServerUnavailableReason = Schema.Literals([
  "provider-unsupported",
  "session-stopped",
  "session-unsupported",
]);
export type McpServerUnavailableReason = typeof McpServerUnavailableReason.Type;

/**
 * "unavailable" is distinct from an empty list: a session that could not be
 * asked must never read as a session with no servers configured.
 */
export const McpServerList = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("available"),
    servers: Schema.Array(McpServerStatus),
  }),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    reason: McpServerUnavailableReason,
  }),
]);
export type McpServerList = typeof McpServerList.Type;

export const McpServerListInput = Schema.Struct({ threadId: ThreadId });
export type McpServerListInput = typeof McpServerListInput.Type;

export const McpServerReconnectInput = Schema.Struct({
  threadId: ThreadId,
  server: TrimmedNonEmptyString,
});
export type McpServerReconnectInput = typeof McpServerReconnectInput.Type;

export const McpServerSetEnabledInput = Schema.Struct({
  threadId: ThreadId,
  server: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
});
export type McpServerSetEnabledInput = typeof McpServerSetEnabledInput.Type;

export const McpServerErrorReason = Schema.Literals([
  ...McpServerUnavailableReason.literals,
  "not-configured",
  "needs-auth",
  "request-failed",
]);
export type McpServerErrorReason = typeof McpServerErrorReason.Type;

export class McpServerError extends Schema.TaggedError<McpServerError>()("McpServerError", {
  threadId: ThreadId,
  operation: Schema.Literals(["list", "reconnect", "enable", "disable"]),
  server: Schema.optional(Schema.String),
  reason: McpServerErrorReason,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    const server = this.server ?? "the MCP server";
    switch (this.reason) {
      case "provider-unsupported":
        return "This thread's provider cannot manage MCP servers from T3.";
      case "session-stopped":
        return "This thread has no running session. Send a message to start one.";
      case "session-unsupported":
        return "This session cannot manage MCP servers. Updating the provider's CLI may help.";
      case "not-configured":
        return `This session has no MCP server named ${server}.`;
      case "needs-auth":
        // Reconnecting never starts a sign-in flow, so say where sign-in happens.
        return `${server} needs sign-in. Sign in from the provider's own CLI, then reconnect.`;
      case "request-failed":
        return this.operation === "list"
          ? "Could not read this session's MCP servers."
          : `Could not ${this.operation} ${server}.`;
    }
  }
}
