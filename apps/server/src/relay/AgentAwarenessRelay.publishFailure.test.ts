import * as NodeServices from "@effect/platform-node/NodeServices";

import type {
  EnvironmentId,
  OrchestrationProjectShell,
  OrchestrationThreadShell,
  ProjectId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { ProviderInstanceId } from "@t3tools/contracts";
import { RelayClientTracer } from "@t3tools/shared/relayTracing";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  PUBLISH_AGENT_ACTIVITY_SECRET,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_ISSUER_SECRET,
  RELAY_URL_SECRET,
} from "../cloud/config.ts";
import * as AgentAwarenessRelay from "./AgentAwarenessRelay.ts";

const encodeSecret = (value: string) => new TextEncoder().encode(value);

function makeMemorySecretStore() {
  const values = new Map<string, Uint8Array>();
  const store = {
    get: (name: string) =>
      Effect.sync(() => {
        const value = values.get(name);
        return value === undefined ? Option.none() : Option.some(Uint8Array.from(value));
      }),
    set: (name: string, value: Uint8Array) =>
      Effect.sync(() => {
        values.set(name, Uint8Array.from(value));
      }),
    create: (name: string, value: Uint8Array) =>
      Effect.sync(() => {
        values.set(name, Uint8Array.from(value));
      }),
    getOrCreateRandom: (name: string, bytes: number) =>
      Effect.sync(() => {
        const existing = values.get(name);
        if (existing) return existing;
        const generated = new Uint8Array(bytes);
        values.set(name, generated);
        return generated;
      }),
    remove: (name: string) =>
      Effect.sync(() => {
        values.delete(name);
      }),
  } as unknown as ServerSecretStore.ServerSecretStore["Service"];
  return {
    store,
    setString: (name: string, value: string) => store.set(name, encodeSecret(value)),
  };
}

describe.sequential("agent activity publish failures", () => {
  // Live clock: the publish retry backs off, which a TestClock never advances.
  it.live("republishes an unchanged state after a failed publish", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const originalFetch = globalThis.fetch;
        const now = "2026-05-25T00:00:00.000Z";
        const projectId = "project-1" as ProjectId;
        const threadId = "thread-1" as ThreadId;
        const environmentId = "env-1" as EnvironmentId;
        const secrets = makeMemorySecretStore();

        const project = {
          id: projectId,
          title: "T3 Code",
          workspaceRoot: "/workspace",
          repositoryIdentity: null,
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        } satisfies OrchestrationProjectShell;

        const baseThread = {
          id: threadId,
          projectId,
          title: "Run remote agent",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          pullRequests: [],
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          latestUserMessageAt: now,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
        } satisfies Omit<OrchestrationThreadShell, "latestTurn" | "session">;

        const runningThread = {
          ...baseThread,
          latestTurn: {
            turnId: "turn-1" as TurnId,
            state: "running",
            requestedAt: now,
            startedAt: now,
            completedAt: null,
            assistantMessageId: null,
          },
          session: {
            threadId,
            status: "running",
            providerName: "Codex",
            runtimeMode: "full-access",
            activeTurnId: "turn-1" as TurnId,
            lastError: null,
            updatedAt: now,
          },
        } satisfies OrchestrationThreadShell;

        // Every completed turn projects the same awareness state: the publish
        // identity deliberately ignores updatedAt, so turn N and turn N+1 are
        // byte-identical.
        const completedThread = {
          ...baseThread,
          latestTurn: {
            turnId: "turn-1" as TurnId,
            state: "completed",
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            assistantMessageId: null,
          },
          session: {
            threadId,
            status: "ready",
            providerName: "Codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        } satisfies OrchestrationThreadShell;

        let currentThread: OrchestrationThreadShell = runningThread;
        let fetchCalls = 0;
        let relayAvailable = true;
        globalThis.fetch = (() => {
          fetchCalls += 1;
          return relayAvailable
            ? Promise.resolve(Response.json({ ok: true, deliveries: [] }))
            : Promise.reject(new Error("relay unavailable"));
        }) as unknown as typeof fetch;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            globalThis.fetch = originalFetch;
          }),
        );

        const layer = Layer.mergeAll(
          Layer.succeed(ServerSecretStore.ServerSecretStore, secrets.store),
          Layer.succeed(ServerEnvironment.ServerEnvironment, {
            getEnvironmentId: Effect.succeed(environmentId),
            getDescriptor: Effect.die("unused descriptor"),
          } as unknown as ServerEnvironment.ServerEnvironment["Service"]),
          Layer.succeed(OrchestrationEngineService, {
            readEvents: () => Stream.empty,
            readThreadEvents: () => Stream.empty,
            getThreadReplayStats: () => Effect.die("unused thread replay stats"),
            dispatch: () => Effect.succeed({ sequence: 1 }),
            streamDomainEvents: Stream.empty,
            subscribeDomainEvents: Effect.succeed(Stream.empty),
            latestSequence: Effect.succeed(0),
          } satisfies OrchestrationEngineShape),
          Layer.succeed(ProjectionSnapshotQuery, {
            getThreadShellById: () => Effect.sync(() => Option.some(currentThread)),
            getProjectShellById: () => Effect.succeed(Option.some(project)),
          } as unknown as ProjectionSnapshotQueryShape),
        );

        yield* Effect.gen(function* () {
          const relay = yield* AgentAwarenessRelay.AgentAwarenessRelay;
          yield* secrets.setString(RELAY_URL_SECRET, "https://transport.example.test");
          yield* secrets.setString(RELAY_ISSUER_SECRET, "https://issuer.example.test");
          yield* secrets.setString(RELAY_ENVIRONMENT_CREDENTIAL_SECRET, "relay-credential");
          yield* secrets.setString(PUBLISH_AGENT_ACTIVITY_SECRET, "true");

          // Turn 1 runs, then finishes. Both land.
          yield* relay.publishThread(threadId);
          currentThread = completedThread;
          yield* relay.publishThread(threadId);
          const afterTurnOne = fetchCalls;
          expect(afterTurnOne).toBe(2);

          // Turn 2 starts and its single running publish is dropped. Nothing
          // mid-turn republishes, so this is the only chance it gets.
          currentThread = runningThread;
          relayAvailable = false;
          yield* relay.publishThread(threadId);
          expect(fetchCalls).toBeGreaterThan(afterTurnOne);
          const afterDroppedRunning = fetchCalls;

          // Turn 2 finishes. Its completed state is byte-identical to turn 1's,
          // so before the fix the dedupe skipped it and the card stayed frozen
          // on the running state the relay never received.
          relayAvailable = true;
          currentThread = completedThread;
          yield* relay.publishThread(threadId);
          expect(fetchCalls).toBeGreaterThan(afterDroppedRunning);

          // The dedupe still suppresses a genuinely unchanged republish.
          const afterRepair = fetchCalls;
          yield* relay.publishThread(threadId);
          expect(fetchCalls).toBe(afterRepair);
        }).pipe(
          Effect.provide(
            AgentAwarenessRelay.layer.pipe(
              Layer.provide(layer),
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
          Effect.provideService(RelayClientTracer, Option.none()),
        );
      }),
    ),
  );
});
