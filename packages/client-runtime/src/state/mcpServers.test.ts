import { EnvironmentId, ThreadId, WS_METHODS } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createMcpServerEnvironmentAtoms, isSettledMcpServerList } from "./mcpServers.ts";
import { executeAtomQuery } from "./runtime.ts";

const target = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-mcp"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});
const threadId = ThreadId.make("thread-mcp");

const rpcSession = (client: Partial<WsRpcProtocolClient>): RpcSession => ({
  client: client as WsRpcProtocolClient,
  initialConfig: Effect.never,
  subscribeServerConfig: () => Stream.never,
  ready: Effect.void,
  probe: Effect.void,
  closed: Effect.never,
});

const readList = Effect.fn("readList")(function* (client: Partial<WsRpcProtocolClient>) {
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target,
    state: yield* SubscriptionRef.make<SupervisorConnectionState>({
      ...AVAILABLE_CONNECTION_STATE,
      desired: true,
      network: "online",
      phase: "connected",
      attempt: 1,
      generation: 1,
    }),
    session: yield* SubscriptionRef.make(Option.some(rpcSession(client))),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
    entries: yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
      new Map([[target.environmentId, { target, profile: Option.none(), enabled: true }]]),
    ),
    run: (_environmentId, effect) =>
      Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    runStream: (_environmentId, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    followStream: (_environmentId, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
  } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
  const runtime = Atom.runtime(
    Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
  );
  const atoms = createMcpServerEnvironmentAtoms(runtime);
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
    Effect.sync(() => registry.dispose()),
  );
  return yield* Effect.promise(() =>
    executeAtomQuery(
      registry,
      atoms.list({ environmentId: target.environmentId, input: { threadId } }),
    ),
  );
});

describe("MCP server atoms", () => {
  it.effect("reads a server without the MCP server RPCs as outdated, not as a failure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const result = yield* readList({
          [WS_METHODS.mcpServersList]: () =>
            Effect.die(`Unknown request tag: ${WS_METHODS.mcpServersList}`),
        } as Partial<WsRpcProtocolClient>);
        expect(AsyncResult.isSuccess(result) && result.value).toEqual({
          status: "unavailable",
          reason: "server-outdated",
        });
      }),
    ),
  );

  it.effect("still surfaces other defects", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const result = yield* readList({
          [WS_METHODS.mcpServersList]: () => Effect.die("socket closed"),
        } as Partial<WsRpcProtocolClient>);
        expect(AsyncResult.isFailure(result)).toBe(true);
      }),
    ),
  );

  it("re-reads on its own only while a server is still connecting", () => {
    const server = (state: "pending" | "failed") => ({
      name: "docs",
      state,
      scope: null,
      version: null,
      error: null,
      host: null,
    });
    expect(isSettledMcpServerList({ status: "available", servers: [server("pending")] })).toBe(
      false,
    );
    expect(isSettledMcpServerList({ status: "available", servers: [server("failed")] })).toBe(true);
    expect(isSettledMcpServerList({ status: "unavailable", reason: "session-stopped" })).toBe(true);
  });
});
