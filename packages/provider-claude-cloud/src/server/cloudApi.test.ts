import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/http";

import { ClaudeCloudApiError, makeClaudeCloudApi } from "./cloudApi.ts";
import type { ClaudeCloudCredentialStore } from "./credentials.ts";

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

const harness = (
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
    const credentials: ClaudeCloudCredentialStore = {
      read: Effect.succeed({ accessToken: Redacted.make(TOKEN) }),
      invalidate: invalidations ? Ref.update(invalidations, (n) => n + 1) : Effect.void,
    };
    return { api: yield* makeClaudeCloudApi({ httpClient, credentials }), recorded };
  });

const happy = (request: Recorded) => {
  if (request.path === "/api/oauth/profile") {
    return { body: '{"account":{"email":"a@b.c"},"organization":{"uuid":"org-1"}}' };
  }
  if (request.path === "/v1/environment_providers") {
    return {
      body: '{"environments":[{"kind":"byoc","environment_id":"env_x"},{"kind":"anthropic_cloud","environment_id":"env_cloud"}]}',
    };
  }
  if (request.path === "/v1/code/sessions") {
    return { body: '{"session":{"id":"cse_1","session_url":"https://claude.ai/code/x"}}' };
  }
  return { body: "{}" };
};

describe("claude cloud api", () => {
  it.effect("signs every request and resolves the organization once", () =>
    Effect.gen(function* () {
      const { api, recorded } = yield* harness(happy);
      yield* api.createSession({ title: "one", sources: [] });
      yield* api.createSession({ title: "two", sources: [] });
      assert.strictEqual(recorded.filter((r) => r.path === "/api/oauth/profile").length, 1);
      assert.strictEqual(recorded.filter((r) => r.path === "/v1/environment_providers").length, 1);
      const create = recorded.find((r) => r.path === "/v1/code/sessions")!;
      assert.strictEqual(create.headers.authorization, `Bearer ${TOKEN}`);
      assert.strictEqual(create.headers["anthropic-beta"], "oauth-2025-04-20");
      assert.strictEqual(create.headers["x-organization-uuid"], "org-1");
      // The profile call itself cannot be org-scoped: it is what resolves the org.
      assert.isUndefined(recorded[0]!.headers["x-organization-uuid"]);
    }),
  );

  it.effect("creates a session in the cloud environment with its repo, model and effort", () =>
    Effect.gen(function* () {
      const { api, recorded } = yield* harness(happy);
      const created = yield* api.createSession({
        title: "Fix the bug",
        sources: [{ url: "https://github.com/o/r" }],
        model: "claude-sonnet-5",
        effort: "low",
      });
      assert.strictEqual(created.id, "cse_1");
      assert.deepStrictEqual(recorded.find((r) => r.path === "/v1/code/sessions")!.body, {
        title: "Fix the bug",
        environment_id: "env_cloud",
        events: [],
        config: {
          sources: [{ type: "git_repository", url: "https://github.com/o/r" }],
          outcomes: [],
          model: "claude-sonnet-5",
          effort_level: "low",
        },
      });
    }),
  );

  it.effect("sends a message in the cloud's event shape", () =>
    Effect.gen(function* () {
      const { api, recorded } = yield* harness(happy);
      yield* api.sendEvents("cse_1", [
        { eventId: "e1", eventType: "user", payload: { type: "user", uuid: "e1" } },
      ]);
      const sent = recorded.find((r) => r.path === "/v1/code/sessions/cse_1/events")!;
      assert.strictEqual(sent.method, "POST");
      assert.deepStrictEqual(sent.body, {
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

  it.effect("decodes the frames it understands and skips the rest", () =>
    Effect.gen(function* () {
      const sse = [
        ":keepalive\n\n",
        'event: session_update\ndata: {"status":"archived"}\n\n',
        'event: client_event\nid: 7\ndata: {"event_id":"e7","sequence_num":"7","event_type":"assistant","source":"worker","payload":{"type":"assistant"}}\n\n',
        'event: delivery_update\ndata: {"event_id":"e7","status":"DELIVERY_STATUS_PROCESSED"}\n\n',
        'event: something_new\ndata: {"x":1}\n\n',
        "event: client_event\ndata: not-json\n\n",
      ].join("");
      const { api, recorded } = yield* harness((request) =>
        request.path.endsWith("/events/stream")
          ? { body: sse, contentType: "text/event-stream" }
          : happy(request),
      );
      const frames = yield* Stream.runCollect(api.streamFrames("cse_1", { lastEventId: 6 }));
      assert.deepStrictEqual(
        frames.map((frame) => frame._tag),
        ["sessionUpdate", "sessionEvent", "deliveryUpdate"],
      );
      const event = frames[1]!;
      assert.isTrue(event._tag === "sessionEvent" && event.sequenceNum === 7);
      const stream = recorded.find((r) => r.path.endsWith("/events/stream"))!;
      assert.strictEqual(stream.headers["last-event-id"], "6");
      assert.strictEqual(stream.headers.accept, "text/event-stream");
    }),
  );

  it.effect("drops a rejected login and retries the request once", () =>
    Effect.gen(function* () {
      const invalidations = yield* Ref.make(0);
      let attempts = 0;
      const { api } = yield* harness((request) => {
        if (request.path !== "/v1/code/sessions/cse_1/archive") return happy(request);
        attempts += 1;
        return attempts === 1 ? { status: 401, body: "expired" } : { body: "{}" };
      }, invalidations);
      yield* api.archive("cse_1");
      assert.strictEqual(attempts, 2);
      assert.strictEqual(yield* Ref.get(invalidations), 1);
    }),
  );

  it.effect("classifies failures and never repeats the token back", () =>
    Effect.gen(function* () {
      for (const [status, kind] of [
        [401, "auth"],
        [404, "notFound"],
        [429, "rateLimit"],
        [500, "transport"],
      ] as const) {
        const { api } = yield* harness((request) =>
          request.path === "/v1/code/sessions/cse_1"
            ? { status, body: `refused ${TOKEN}` }
            : happy(request),
        );
        const exit = yield* Effect.exit(api.getSession("cse_1"));
        assert.isTrue(Exit.isFailure(exit));
        const error = Exit.isFailure(exit) ? Exit.findErrorOption(exit) : undefined;
        assert.isTrue(error?._tag === "Some" && Schema.is(ClaudeCloudApiError)(error.value));
        if (error?._tag === "Some" && Schema.is(ClaudeCloudApiError)(error.value)) {
          assert.strictEqual(error.value.kind, kind);
          assert.notInclude(error.value.message, TOKEN);
        }
      }
    }),
  );

  it.effect("reads an archived session and its recent events", () =>
    Effect.gen(function* () {
      const { api } = yield* harness((request) =>
        request.path === "/v1/code/sessions/cse_1"
          ? { body: '{"response_shape":{"id":"cse_1","status":"archived"}}' }
          : request.path.startsWith("/v1/code/sessions/cse_1/events")
            ? {
                body: '{"data":[{"sequence_num":"12","event_type":"result","source":"worker"},{"sequence_num":"11","event_type":"user","source":"client"}]}',
              }
            : happy(request),
      );
      assert.isTrue((yield* api.getSession("cse_1")).archived);
      assert.deepStrictEqual(yield* api.latestEvents("cse_1", 50), [
        { sequenceNum: 12, eventType: "result", source: "worker" },
        { sequenceNum: 11, eventType: "user", source: "client" },
      ]);
    }),
  );
});
