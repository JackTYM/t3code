import {
  McpServerError,
  type McpServerList,
  type McpServerListInput,
  type McpServerReconnectInput,
  type McpServerSetEnabledInput,
  type McpServerUnavailableReason,
  type OrchestrationV2ProviderThread,
  type ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

/**
 * The MCP servers of a thread's live provider session. A stopped session is
 * reported, never started: looking at MCP servers must not spend a turn.
 */
export class SessionMcpServers extends Context.Service<
  SessionMcpServers,
  {
    readonly list: (input: McpServerListInput) => Effect.Effect<McpServerList, McpServerError>;
    readonly reconnect: (input: McpServerReconnectInput) => Effect.Effect<void, McpServerError>;
    readonly setEnabled: (input: McpServerSetEnabledInput) => Effect.Effect<void, McpServerError>;
  }
>()("t3/mcpServers/SessionMcpServers") {}

type Operation = McpServerError["operation"];

const make = Effect.gen(function* () {
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;

  const resolve = Effect.fn("SessionMcpServers.resolve")(function* (
    threadId: ThreadId,
    operation: Operation,
  ) {
    const requestFailed = (cause: unknown) =>
      new McpServerError({ threadId, operation, reason: "request-failed", cause });
    const projection = yield* threadManagement
      .getThreadRecords(threadId, ["providerThreads"])
      .pipe(Effect.mapError(requestFailed));
    const providerThread =
      projection.providerThreads.find(
        (candidate) => candidate.id === projection.thread.activeProviderThreadId,
      ) ?? projection.providerThreads.at(-1);
    const unavailable = (reason: McpServerUnavailableReason) => ({ reason }) as const;
    if (providerThread?.providerSessionId == null) return unavailable("session-stopped");
    const runtime = Option.getOrUndefined(
      yield* providerSessions
        .get(providerThread.providerSessionId)
        .pipe(Effect.mapError(requestFailed)),
    );
    if (runtime === undefined) return unavailable("session-stopped");
    const control: ProviderAdapter.ProviderAdapterV2McpServers | undefined = runtime.mcpServers;
    if (control === undefined) return unavailable("provider-unsupported");
    return { control, providerThread } as const;
  });

  const list = Effect.fn("SessionMcpServers.list")(function* (input: McpServerListInput) {
    const resolved = yield* resolve(input.threadId, "list");
    if ("reason" in resolved) return { status: "unavailable", reason: resolved.reason } as const;
    return yield* resolved.control.list({ providerThread: resolved.providerThread }).pipe(
      Effect.mapError(
        (cause) =>
          new McpServerError({
            threadId: input.threadId,
            operation: "list",
            reason: "request-failed",
            cause,
          }),
      ),
    );
  });

  const act = Effect.fn("SessionMcpServers.act")(function* (
    input: { readonly threadId: ThreadId; readonly server: string },
    operation: Exclude<Operation, "list">,
    run: (
      control: ProviderAdapter.ProviderAdapterV2McpServers,
      providerThread: OrchestrationV2ProviderThread,
    ) => Effect.Effect<void, ProviderAdapter.ProviderAdapterV2Error>,
  ) {
    const fail = (reason: McpServerError["reason"], cause?: unknown) =>
      new McpServerError({
        threadId: input.threadId,
        operation,
        server: input.server,
        reason,
        ...(cause === undefined ? {} : { cause }),
      });
    const resolved = yield* resolve(input.threadId, operation);
    if ("reason" in resolved) return yield* fail(resolved.reason);
    const { control, providerThread } = resolved;
    const servers = yield* control
      .list({ providerThread })
      .pipe(Effect.mapError((cause) => fail("request-failed", cause)));
    if (servers.status === "unavailable") return yield* fail(servers.reason);
    if (!servers.servers.some((server) => server.name === input.server)) {
      return yield* fail("not-configured");
    }
    yield* run(control, providerThread).pipe(
      Effect.catch((cause) =>
        Effect.gen(function* () {
          // The message comes from where the server landed rather than the
          // provider's error text, which can echo request headers.
          const after = yield* control
            .list({ providerThread })
            .pipe(Effect.orElseSucceed(() => null));
          const state =
            after?.status === "available"
              ? after.servers.find((server) => server.name === input.server)?.state
              : undefined;
          return yield* fail(state === "needs-auth" ? "needs-auth" : "request-failed", cause);
        }),
      ),
    );
  });

  const reconnect = (input: McpServerReconnectInput) =>
    act(input, "reconnect", (control, providerThread) =>
      control.reconnect({ providerThread, server: input.server }),
    );

  const setEnabled = (input: McpServerSetEnabledInput) =>
    act(input, input.enabled ? "enable" : "disable", (control, providerThread) =>
      control.setEnabled({ providerThread, server: input.server, enabled: input.enabled }),
    );

  return SessionMcpServers.of({ list, reconnect, setEnabled });
});

export const layer = Layer.effect(SessionMcpServers, make);
