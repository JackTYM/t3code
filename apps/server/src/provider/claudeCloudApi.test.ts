import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/unstable/http";

import { CloudApiError, makeClaudeCloudApi } from "./claudeCloudApi.ts";
import type { ClaudeCloudCredentialsReader } from "./claudeCloudCredentials.ts";

const TOKEN = "sk-ant-oat01-test-token";
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

const bodyOf = (request: HttpClientRequest.HttpClientRequest): unknown =>
  request.body._tag === "Uint8Array"
    ? decodeJson(new TextDecoder().decode(request.body.body))
    : undefined;

/** A fake transport: `route` answers each request and every request is recorded. */
const makeFakeApi = (
  route: (request: Recorded) => { status?: number; body?: string; contentType?: string },
  invalidations?: Ref.Ref<number>,
) =>
  Effect.gen(function* () {
    const recorded: Recorded[] = [];
    const httpClient = HttpClient.make((request) =>
      Effect.sync(() => {
        const url = new URL(request.url);
        const entry: Recorded = {
          method: request.method,
          path: url.pathname + url.search,
          headers: { ...request.headers },
          body: bodyOf(request),
        };
        recorded.push(entry);
        const answer = route(entry);
        return HttpClientResponse.fromWeb(
          request,
          new Response(answer.body ?? "{}", {
            status: answer.status ?? 200,
            headers: { "content-type": answer.contentType ?? "application/json" },
          }),
        );
      }),
    );
    const credentials: ClaudeCloudCredentialsReader = {
      read: Effect.succeed({
        accessToken: Redacted.make(TOKEN),
        expiresAtMs: null,
        scopes: ["user:sessions:claude_code"],
      }),
      invalidate: invalidations ? Ref.update(invalidations, (n) => n + 1) : Effect.void,
    };
    const api = yield* makeClaudeCloudApi({ httpClient, credentials });
    return { api, recorded };
  });

const happyRoute = (request: Recorded) => {
  if (request.path === "/api/oauth/profile") {
    return {
      body: '{"account":{"email":"a@b.c"},"organization":{"uuid":"org-1"}}',
    };
  }
  if (request.path === "/v1/environment_providers") {
    return {
      body: '{"environments":[{"kind":"byoc","environment_id":"env_x"},{"kind":"anthropic_cloud","environment_id":"env_cloud"}]}',
    };
  }
  if (request.path === "/v1/code/sessions") {
    return { body: '{"session":{"id":"cse_1","session_url":"https://claude.ai/code/cshk_1"}}' };
  }
  return { body: "{}" };
};

describe("claudeCloudApi", () => {
  it.effect("sends the OAuth headers and fetches the organization only once", () =>
    Effect.gen(function* () {
      const { api, recorded } = yield* makeFakeApi(happyRoute);
      const first = yield* api.createSession({ title: "t", sources: [] });
      yield* api.createSession({ title: "t2", sources: [] });
      assert.strictEqual(first.id, "cse_1");
      assert.strictEqual(first.sessionUrl, "https://claude.ai/code/cshk_1");
      assert.strictEqual(recorded.filter((r) => r.path === "/api/oauth/profile").length, 1);
      assert.strictEqual(recorded.filter((r) => r.path === "/v1/environment_providers").length, 1);

      const profile = recorded[0]!;
      assert.strictEqual(profile.headers["x-organization-uuid"], undefined);
      const create = recorded.find((r) => r.path === "/v1/code/sessions")!;
      assert.strictEqual(create.headers.authorization, `Bearer ${TOKEN}`);
      assert.strictEqual(create.headers["anthropic-version"], "2023-06-01");
      assert.strictEqual(create.headers["anthropic-beta"], "oauth-2025-04-20");
      assert.strictEqual(create.headers["x-organization-uuid"], "org-1");
    }),
  );

  it.effect("creates a session in the cloud environment with sources, model and effort", () =>
    Effect.gen(function* () {
      const { api, recorded } = yield* makeFakeApi(happyRoute);
      yield* api.createSession({
        title: "Fix bug",
        sources: [{ url: "https://github.com/o/r" }],
        model: "claude-haiku-5-5",
        effort: "low",
      });
      const create = recorded.find((r) => r.path === "/v1/code/sessions")!;
      assert.deepStrictEqual(create.body, {
        title: "Fix bug",
        environment_id: "env_cloud",
        events: [],
        config: {
          sources: [{ type: "git_repository", url: "https://github.com/o/r" }],
          outcomes: [],
          model: "claude-haiku-5-5",
          effort_level: "low",
        },
      });
    }),
  );

  it.effect("sends events in the cloud wire shape", () =>
    Effect.gen(function* () {
      const { api, recorded } = yield* makeFakeApi(happyRoute);
      yield* api.sendEvents("cse_1", [
        { eventId: "e1", eventType: "user", payload: { type: "user", uuid: "e1" } },
      ]);
      const send = recorded.find((r) => r.path === "/v1/code/sessions/cse_1/events")!;
      assert.strictEqual(send.method, "POST");
      assert.deepStrictEqual(send.body, {
        events: [
          {
            event_id: "e1",
            event_type: "user",
            source: "client",
            payload: { type: "user", uuid: "e1" },
          },
        ],
      });
    }),
  );

  it.effect("decodes stream frames, skipping keepalives and unknown events", () =>
    Effect.gen(function* () {
      const sse = [
        ":keepalive\n\n",
        'event: session_update\ndata: {"connection_status":"connected"}\n\n',
        'event: client_event\nid: 7\ndata: {"event_id":"e7","sequence_num":"7","event_type":"assistant","source":"worker","payload":{"type":"assistant"}}\n\n',
        'event: delivery_update\ndata: {"event_id":"e7","status":"DELIVERY_STATUS_PROCESSED"}\n\n',
        'event: ephemeral_event\ndata: {"event_type":"system","payload":{"subtype":"thinking_tokens"}}\n\n',
        'event: something_new\ndata: {"x":1}\n\n',
        "event: client_event\ndata: not-json\n\n",
      ].join("");
      const { api, recorded } = yield* makeFakeApi((request) =>
        request.path.endsWith("/events/stream")
          ? { body: sse, contentType: "text/event-stream" }
          : happyRoute(request),
      );
      const frames = yield* Stream.runCollect(api.streamFrames("cse_1", { lastEventId: 6 }));
      assert.deepStrictEqual(
        frames.map((frame) => frame._tag),
        ["session_update", "client_event", "delivery_update", "ephemeral_event"],
      );
      const clientEvent = frames[1]!;
      assert.isTrue(clientEvent._tag === "client_event" && clientEvent.sequenceNum === 7);
      const stream = recorded.find((r) => r.path.endsWith("/events/stream"))!;
      assert.strictEqual(stream.headers["last-event-id"], "6");
      assert.strictEqual(stream.headers.accept, "text/event-stream");
    }),
  );

  it.effect("drops the cached login and retries once after a 401", () =>
    Effect.gen(function* () {
      const invalidations = yield* Ref.make(0);
      let attempts = 0;
      const { api } = yield* makeFakeApi((request) => {
        if (request.path === "/v1/code/sessions/cse_1/archive") {
          attempts += 1;
          return attempts === 1 ? { status: 401, body: "expired" } : { body: "{}" };
        }
        return happyRoute(request);
      }, invalidations);
      yield* api.archive("cse_1");
      assert.strictEqual(attempts, 2);
      assert.strictEqual(yield* Ref.get(invalidations), 1);
    }),
  );

  it.effect("maps statuses to error kinds and never echoes the token", () =>
    Effect.gen(function* () {
      const statuses = new Map([
        [401, "auth"],
        [404, "not_found"],
        [429, "rate_limit"],
        [500, "transport"],
      ]);
      for (const [status, kind] of statuses) {
        const { api } = yield* makeFakeApi((request) =>
          request.path === "/v1/code/sessions/cse_1"
            ? { status, body: `boom ${TOKEN}` }
            : happyRoute(request),
        );
        const exit = yield* Effect.exit(api.getSession("cse_1"));
        assert.isTrue(Exit.isFailure(exit));
        const error = Exit.isFailure(exit) ? Exit.findErrorOption(exit) : undefined;
        assert.isTrue(error?._tag === "Some" && Schema.is(CloudApiError)(error.value));
        if (error?._tag === "Some" && Schema.is(CloudApiError)(error.value)) {
          assert.strictEqual(error.value.kind, kind);
          assert.notInclude(error.value.message, TOKEN);
        }
      }
    }),
  );

  it.effect("reads archived status and recent events", () =>
    Effect.gen(function* () {
      const { api } = yield* makeFakeApi((request) =>
        request.path === "/v1/code/sessions/cse_1"
          ? { body: '{"response_shape":{"id":"cse_1","status":"archived"}}' }
          : request.path.startsWith("/v1/code/sessions/cse_1/events")
            ? {
                body: '{"data":[{"sequence_num":"12","event_type":"result","source":"worker"},{"sequence_num":"11","event_type":"user","source":"client"}]}',
              }
            : happyRoute(request),
      );
      assert.isTrue((yield* api.getSession("cse_1")).archived);
      assert.deepStrictEqual(yield* api.latestEvents("cse_1", 50), [
        { sequenceNum: 12, eventType: "result", source: "worker" },
        { sequenceNum: 11, eventType: "user", source: "client" },
      ]);
    }),
  );
});
