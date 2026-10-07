import { type EnvironmentId, type ThreadId, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

/**
 * MCP servers of one thread's live session.
 *
 * Keyed by thread rather than environment because the connections belong to the
 * session: the CLI reads MCP config when it spawns, so two threads on one
 * machine can legitimately disagree about whether a server is up.
 */
export function createMcpEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const actionScheduler = createAtomCommandScheduler();
  // Serialized per thread: reconnecting and toggling the same session
  // concurrently races the CLI's own connection state.
  const actionConcurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { threadId: string } }) =>
      JSON.stringify([environmentId, input.threadId]),
  };

  const list = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:mcp:list",
    tag: WS_METHODS.mcpList,
    // Connection state changes without T3 doing anything — a server can drop
    // or finish authenticating on its own — so this goes stale quickly.
    staleTimeMs: 3_000,
  });

  const invalidateList = (
    target: {
      readonly environmentId: EnvironmentId;
      readonly input: { readonly threadId: ThreadId };
    },
    registry: AtomRegistry.AtomRegistry,
  ) =>
    Effect.sync(() => {
      registry.refresh(
        list({ environmentId: target.environmentId, input: { threadId: target.input.threadId } }),
      );
    });

  return {
    list,
    reconnect: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:mcp:reconnect",
      tag: WS_METHODS.mcpReconnect,
      scheduler: actionScheduler,
      concurrency: actionConcurrency,
      // Re-read after either outcome: a failed reconnect still moves the
      // server's state, and the panel should show where it actually landed.
      onSettled: invalidateList,
    }),
    setEnabled: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:mcp:set-enabled",
      tag: WS_METHODS.mcpSetEnabled,
      scheduler: actionScheduler,
      concurrency: actionConcurrency,
      onSettled: invalidateList,
    }),
  };
}
