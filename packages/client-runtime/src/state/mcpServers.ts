import {
  type EnvironmentId,
  type McpServerList,
  type ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import type { Atom, AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { request } from "../rpc/client.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentQueryAtomFamily,
  createEnvironmentRpcCommand,
} from "./runtime.ts";

/** Adds what only a client can know: the server predates the MCP server RPCs. */
export type SessionMcpServerList =
  | McpServerList
  | { readonly status: "unavailable"; readonly reason: "server-outdated" };

/** The RPC server answers a method it does not know with this defect. */
function isUnknownRpcDefect(defect: unknown): boolean {
  const message =
    typeof defect === "string"
      ? defect
      : Predicate.hasProperty(defect, "message") && typeof defect.message === "string"
        ? defect.message
        : "";
  return message.startsWith("Unknown request tag");
}

// Only a server still connecting changes without anyone acting on it, so the
// list re-reads on its own only while one is pending.
export const isSettledMcpServerList = (list: SessionMcpServerList) =>
  list.status !== "available" || !list.servers.some((server) => server.state === "pending");

export function createMcpServerEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const list = createEnvironmentQueryAtomFamily(runtime, {
    label: "environment-data:mcp-servers:list",
    execute: (input: { readonly threadId: ThreadId }) =>
      request(WS_METHODS.mcpServersList, input).pipe(
        Effect.map((result): SessionMcpServerList => result),
        // An older server must read as unsupported, never as an error toast.
        Effect.catchDefect((defect) =>
          isUnknownRpcDefect(defect)
            ? Effect.succeed<SessionMcpServerList>({
                status: "unavailable",
                reason: "server-outdated",
              })
            : Effect.die(defect),
        ),
      ),
    staleTimeMs: 3_000,
    refreshIntervalMs: 2_000,
    isFinal: isSettledMcpServerList,
  });

  const refreshList = (
    target: {
      readonly environmentId: EnvironmentId;
      readonly input: { readonly threadId: ThreadId };
    },
    registry: AtomRegistry.AtomRegistry,
  ) =>
    Effect.sync(() =>
      registry.refresh(
        list({ environmentId: target.environmentId, input: { threadId: target.input.threadId } }),
      ),
    );

  // Repairs on one session run one at a time: reconnecting and toggling at once
  // races the provider's own connection state.
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: (target: {
      readonly environmentId: EnvironmentId;
      readonly input: { readonly threadId: ThreadId };
    }) => JSON.stringify([target.environmentId, target.input.threadId]),
  };

  return {
    list,
    // Re-read after either outcome: a failed repair still moves the server, and
    // the panel should show where it landed.
    reconnect: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mcp-servers:reconnect",
      tag: WS_METHODS.mcpServersReconnect,
      scheduler,
      concurrency,
      onSettled: refreshList,
    }),
    setEnabled: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:mcp-servers:set-enabled",
      tag: WS_METHODS.mcpServersSetEnabled,
      scheduler,
      concurrency,
      onSettled: refreshList,
    }),
  };
}
