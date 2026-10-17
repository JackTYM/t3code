import {
  ProviderDriverKind,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
  type McpServerError,
  type McpServerList,
  type McpServerState,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SessionMcpServers from "./SessionMcpServers.ts";

const threadId = ThreadId.make("thread-mcp");
const providerThreadId = ProviderThreadId.make("provider-thread-mcp");
const providerSessionId = ProviderSessionId.make("provider-session-mcp");

const server = (name: string, state: McpServerState) => ({
  name,
  state,
  scope: "user",
  version: null,
  error: null,
  host: null,
});

function makeLayer(input: {
  readonly sessionId?: ProviderSessionId | null;
  readonly live?: boolean;
  readonly control?: ProviderAdapter.ProviderAdapterV2McpServers;
}) {
  return SessionMcpServers.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: () =>
            Effect.succeed({
              thread: { activeProviderThreadId: providerThreadId },
              providerThreads:
                input.sessionId === undefined
                  ? [{ id: providerThreadId, providerSessionId } as OrchestrationV2ProviderThread]
                  : input.sessionId === null
                    ? []
                    : [
                        {
                          id: providerThreadId,
                          providerSessionId: input.sessionId,
                        } as OrchestrationV2ProviderThread,
                      ],
            } as never),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          get: () =>
            Effect.succeed(
              input.live === false
                ? Option.none()
                : Option.some(
                    (input.control === undefined
                      ? {}
                      : {
                          mcpServers: input.control,
                        }) as ProviderAdapter.ProviderAdapterV2SessionRuntime,
                  ),
            ),
        }),
      ),
    ),
  );
}

/** A control whose servers move like a CLI's would, with reconnect scripted per test. */
function makeControl(options: {
  readonly listed: McpServerList;
  readonly afterFailure?: McpServerList;
  readonly reconnect?: Effect.Effect<void, ProviderAdapter.ProviderAdapterV2Error>;
}) {
  const calls: Array<string> = [];
  let failed = false;
  const control: ProviderAdapter.ProviderAdapterV2McpServers = {
    list: () =>
      Effect.sync(() => (failed && options.afterFailure ? options.afterFailure : options.listed)),
    reconnect: ({ server: name }) =>
      Effect.sync(() => calls.push(`reconnect:${name}`)).pipe(
        Effect.andThen(options.reconnect ?? Effect.void),
        Effect.tapError(() => Effect.sync(() => (failed = true))),
      ),
    setEnabled: ({ server: name, enabled }) =>
      Effect.sync(() => void calls.push(`${enabled ? "enable" : "disable"}:${name}`)),
  };
  return { control, calls };
}

const protocolError = Effect.fail(
  new ProviderAdapter.ProviderAdapterProtocolError({
    driver: ProviderDriverKind.make("claudeAgent"),
    detail: "Claude MCP reconnect request failed",
    cause: new Error("Server status: needs-auth"),
  }),
);

const reason = <A, R>(effect: Effect.Effect<A, McpServerError, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.reason),
  );

describe("SessionMcpServers", () => {
  it.effect("reports a thread that never started a session as stopped, not empty", () =>
    Effect.gen(function* () {
      const servers = yield* SessionMcpServers.SessionMcpServers;
      assert.deepEqual(yield* servers.list({ threadId }), {
        status: "unavailable",
        reason: "session-stopped",
      });
    }).pipe(Effect.provide(makeLayer({ sessionId: null }))),
  );

  it.effect("reports a session that is no longer running as stopped", () =>
    Effect.gen(function* () {
      const servers = yield* SessionMcpServers.SessionMcpServers;
      assert.deepEqual(yield* servers.list({ threadId }), {
        status: "unavailable",
        reason: "session-stopped",
      });
    }).pipe(Effect.provide(makeLayer({ live: false }))),
  );

  it.effect("reports a provider without the control as unsupported", () =>
    Effect.gen(function* () {
      const servers = yield* SessionMcpServers.SessionMcpServers;
      assert.deepEqual(yield* servers.list({ threadId }), {
        status: "unavailable",
        reason: "provider-unsupported",
      });
      assert.equal(
        yield* reason(servers.reconnect({ threadId, server: "docs" })),
        "provider-unsupported",
      );
    }).pipe(Effect.provide(makeLayer({}))),
  );

  it.effect("passes the session's own list through", () => {
    const listed = { status: "available", servers: [server("docs", "connected")] } as const;
    return Effect.gen(function* () {
      const servers = yield* SessionMcpServers.SessionMcpServers;
      assert.deepEqual(yield* servers.list({ threadId }), listed);
    }).pipe(Effect.provide(makeLayer({ control: makeControl({ listed }).control })));
  });

  it.effect("refuses to repair when the session itself cannot answer", () => {
    const { control, calls } = makeControl({
      listed: { status: "unavailable", reason: "session-unsupported" },
    });
    return Effect.gen(function* () {
      const servers = yield* SessionMcpServers.SessionMcpServers;
      assert.equal(
        yield* reason(servers.setEnabled({ threadId, server: "docs", enabled: false })),
        "session-unsupported",
      );
      assert.deepEqual(calls, []);
    }).pipe(Effect.provide(makeLayer({ control })));
  });

  it.effect("refuses a server the session does not have", () => {
    const { control, calls } = makeControl({
      listed: { status: "available", servers: [server("docs", "failed")] },
    });
    return Effect.gen(function* () {
      const servers = yield* SessionMcpServers.SessionMcpServers;
      assert.equal(
        yield* reason(servers.reconnect({ threadId, server: "missing" })),
        "not-configured",
      );
      assert.deepEqual(calls, []);
    }).pipe(Effect.provide(makeLayer({ control })));
  });

  it.effect("forwards reconnect and toggles to the session", () => {
    const { control, calls } = makeControl({
      listed: { status: "available", servers: [server("docs", "failed")] },
    });
    return Effect.gen(function* () {
      const servers = yield* SessionMcpServers.SessionMcpServers;
      yield* servers.reconnect({ threadId, server: "docs" });
      yield* servers.setEnabled({ threadId, server: "docs", enabled: false });
      yield* servers.setEnabled({ threadId, server: "docs", enabled: true });
      assert.deepEqual(calls, ["reconnect:docs", "disable:docs", "enable:docs"]);
    }).pipe(Effect.provide(makeLayer({ control })));
  });

  it.effect("explains a failed reconnect by where the server landed", () => {
    const { control } = makeControl({
      listed: { status: "available", servers: [server("docs", "failed")] },
      afterFailure: { status: "available", servers: [server("docs", "needs-auth")] },
      reconnect: protocolError,
    });
    return Effect.gen(function* () {
      const servers = yield* SessionMcpServers.SessionMcpServers;
      const error = yield* servers.reconnect({ threadId, server: "docs" }).pipe(Effect.flip);
      assert.equal(error.reason, "needs-auth");
      assert.equal(error.operation, "reconnect");
      assert.match(error.message, /docs needs sign-in/);
    }).pipe(Effect.provide(makeLayer({ control })));
  });

  it.effect("says the repair failed when the server is still failing", () => {
    const { control } = makeControl({
      listed: { status: "available", servers: [server("docs", "failed")] },
      reconnect: protocolError,
    });
    return Effect.gen(function* () {
      const servers = yield* SessionMcpServers.SessionMcpServers;
      const error = yield* servers.reconnect({ threadId, server: "docs" }).pipe(Effect.flip);
      assert.equal(error.reason, "request-failed");
      assert.equal(error.message, "Could not reconnect docs.");
    }).pipe(Effect.provide(makeLayer({ control })));
  });
});
