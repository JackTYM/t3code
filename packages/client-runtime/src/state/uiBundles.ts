import { type EnvironmentId, type UiBundleState, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { Atom, AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { request } from "../rpc/client.ts";
import { isUnknownRpcDefect } from "./mcpServers.ts";
import { createEnvironmentQueryAtomFamily, createEnvironmentRpcCommand } from "./runtime.ts";

export function createUiBundleEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const state = createEnvironmentQueryAtomFamily(runtime, {
    label: "environment-data:ui-bundles:state",
    execute: (input: Record<string, never>) =>
      request(WS_METHODS.uiBundlesState, input).pipe(
        Effect.map((result): UiBundleState | null => result),
        // An older server must read as "no UI updates", never as an error toast.
        Effect.catchDefect((defect) =>
          isUnknownRpcDefect(defect) ? Effect.succeed(null) : Effect.die(defect),
        ),
      ),
    staleTimeMs: 30_000,
    refreshIntervalMs: 60_000,
  });

  // Re-read after either outcome: a failed apply or check can still move the
  // server's state (`lastError`, `bootPending`).
  const refreshState = (
    target: { readonly environmentId: EnvironmentId },
    registry: AtomRegistry.AtomRegistry,
  ) =>
    Effect.sync(() => registry.refresh(state({ environmentId: target.environmentId, input: {} })));

  return {
    state,
    check: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:ui-bundles:check",
      tag: WS_METHODS.uiBundlesCheck,
      onSettled: refreshState,
    }),
    apply: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:ui-bundles:apply",
      tag: WS_METHODS.uiBundlesApply,
      onSettled: refreshState,
    }),
    revert: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:ui-bundles:revert",
      tag: WS_METHODS.uiBundlesRevert,
      onSettled: refreshState,
    }),
    confirmBoot: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:ui-bundles:confirm-boot",
      tag: WS_METHODS.uiBundlesConfirmBoot,
    }),
  };
}
