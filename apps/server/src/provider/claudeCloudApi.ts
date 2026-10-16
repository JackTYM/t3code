/**
 * Client for the private claude.ai/code cloud-session API (the one `claude
 * --cloud` uses), authenticated with the claude CLI's OAuth login.
 *
 * Undocumented and beta-gated: shapes here come from probing a real account
 * (see docs/internals/providers.md). Payloads that belong to the Claude SDK
 * message format stay `unknown` and are narrowed by the adapter.
 *
 * @module claudeCloudApi
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Sse } from "effect/unstable/encoding";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/unstable/http";

import type {
  ClaudeCloudCredentialsError,
  ClaudeCloudCredentialsReader,
} from "./claudeCloudCredentials.ts";

const API_BASE = "https://api.anthropic.com";
const API_HEADERS = {
  "anthropic-version": "2023-06-01",
  "anthropic-beta": "oauth-2025-04-20",
} as const;
const ERROR_EXCERPT_CHARS = 300;

export class CloudApiError extends Schema.TaggedError<CloudApiError>()("CloudApiError", {
  kind: Schema.Literals(["auth", "rate_limit", "not_found", "transport"]),
  status: Schema.optional(Schema.Number),
  detail: Schema.String,
}) {
  override get message(): string {
    return `Claude Cloud request failed (${this.kind}${this.status === undefined ? "" : ` ${this.status}`}): ${this.detail}`;
  }
}

export type ClaudeCloudError = CloudApiError | ClaudeCloudCredentialsError;

/** One decoded frame of a session's SSE stream. */
export type CloudFrame =
  | {
      readonly _tag: "client_event";
      readonly eventId: string;
      readonly sequenceNum: number;
      readonly eventType: string;
      readonly source: string;
      readonly payload: unknown;
    }
  | { readonly _tag: "session_update"; readonly data: unknown }
  | {
      readonly _tag: "delivery_update";
      readonly eventId: string;
      readonly status: string;
    }
  | { readonly _tag: "ephemeral_event"; readonly eventType: string; readonly payload: unknown };

const ClientEventData = Schema.Struct({
  event_id: Schema.String,
  sequence_num: Schema.Union([Schema.String, Schema.Finite]),
  event_type: Schema.String,
  source: Schema.String,
  payload: Schema.Unknown,
});
const DeliveryUpdateData = Schema.Struct({ event_id: Schema.String, status: Schema.String });
const EphemeralEventData = Schema.Struct({ event_type: Schema.String, payload: Schema.Unknown });
const decodeClientEvent = Schema.decodeUnknownOption(ClientEventData);
const decodeDeliveryUpdate = Schema.decodeUnknownOption(DeliveryUpdateData);
const decodeEphemeralEvent = Schema.decodeUnknownOption(EphemeralEventData);
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/** Unknown event names and malformed frames decode to `None` and are skipped. */
export function decodeCloudFrame(frame: {
  readonly event: string;
  readonly data: string;
}): Option.Option<CloudFrame> {
  const data = decodeJson(frame.data);
  if (Option.isNone(data)) return Option.none();
  switch (frame.event) {
    case "client_event":
      return Option.flatMap(decodeClientEvent(data.value), (event) => {
        const sequenceNum = Number(event.sequence_num);
        return Number.isFinite(sequenceNum)
          ? Option.some({
              _tag: "client_event" as const,
              eventId: event.event_id,
              sequenceNum,
              eventType: event.event_type,
              source: event.source,
              payload: event.payload,
            })
          : Option.none();
      });
    case "session_update":
      return Option.some({ _tag: "session_update", data: data.value });
    case "delivery_update":
      return Option.map(decodeDeliveryUpdate(data.value), (update) => ({
        _tag: "delivery_update" as const,
        eventId: update.event_id,
        status: update.status,
      }));
    case "ephemeral_event":
      return Option.map(decodeEphemeralEvent(data.value), (event) => ({
        _tag: "ephemeral_event" as const,
        eventType: event.event_type,
        payload: event.payload,
      }));
    default:
      return Option.none();
  }
}

export interface CloudRepoSource {
  readonly url: string;
}

export interface CloudEventSummary {
  readonly sequenceNum: number;
  readonly eventType: string;
  readonly source: string;
}

export interface CloudOutgoingEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface ClaudeCloudApi {
  readonly profile: Effect.Effect<{ email: string; orgUuid: string }, ClaudeCloudError>;
  readonly createSession: (input: {
    readonly title: string;
    readonly sources: ReadonlyArray<CloudRepoSource>;
    readonly model?: string;
    readonly effort?: string;
  }) => Effect.Effect<{ id: string; sessionUrl: string | null }, ClaudeCloudError>;
  readonly getSession: (
    id: string,
  ) => Effect.Effect<{ id: string; archived: boolean }, ClaudeCloudError>;
  /** Newest first. */
  readonly latestEvents: (
    id: string,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<CloudEventSummary>, ClaudeCloudError>;
  readonly sendEvents: (
    id: string,
    events: ReadonlyArray<CloudOutgoingEvent>,
  ) => Effect.Effect<void, ClaudeCloudError>;
  readonly archive: (id: string) => Effect.Effect<void, ClaudeCloudError>;
  /** Replays from the start (or after `lastEventId`), then stays live. */
  readonly streamFrames: (
    id: string,
    options?: { readonly lastEventId?: number },
  ) => Stream.Stream<CloudFrame, ClaudeCloudError>;
}

const ProfileBody = Schema.Struct({
  account: Schema.Struct({ email: Schema.String }),
  organization: Schema.Struct({ uuid: Schema.String }),
});
const EnvironmentsBody = Schema.Struct({
  environments: Schema.Array(Schema.Struct({ kind: Schema.String, environment_id: Schema.String })),
});
const CreatedSessionBody = Schema.Struct({
  session: Schema.Struct({ id: Schema.String, session_url: Schema.optional(Schema.String) }),
});
const SessionBody = Schema.Struct({
  response_shape: Schema.optional(
    Schema.Struct({ id: Schema.String, status: Schema.optional(Schema.String) }),
  ),
  id: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
});
const EventsBody = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      sequence_num: Schema.Union([Schema.String, Schema.Finite]),
      event_type: Schema.String,
      source: Schema.String,
    }),
  ),
});

export const makeClaudeCloudApi = Effect.fn("makeClaudeCloudApi")(function* (input: {
  readonly httpClient: HttpClient.HttpClient;
  readonly credentials: ClaudeCloudCredentialsReader;
}) {
  const orgUuidRef = yield* Ref.make<string | null>(null);
  const environmentIdRef = yield* Ref.make<string | null>(null);

  const apiError = (kind: CloudApiError["kind"], detail: string, status?: number): CloudApiError =>
    new CloudApiError({ kind, detail, ...(status === undefined ? {} : { status }) });

  const failForStatus = Effect.fn("claudeCloudApi.failForStatus")(function* (
    response: HttpClientResponse.HttpClientResponse,
    token: string,
  ): Effect.fn.Return<never, CloudApiError> {
    const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
    const detail = body.split(token).join("<token>").slice(0, ERROR_EXCERPT_CHARS);
    const status = response.status;
    return yield* apiError(
      status === 401 || status === 403
        ? "auth"
        : status === 404
          ? "not_found"
          : status === 429
            ? "rate_limit"
            : "transport",
      detail,
      status,
    );
  });

  /** Sends one request. A 401 drops the cached login and retries once. */
  const execute = Effect.fn("claudeCloudApi.execute")(function* (options: {
    readonly method: "GET" | "POST";
    readonly path: string;
    readonly body?: unknown;
    readonly orgScoped: boolean;
    readonly headers?: Readonly<Record<string, string>>;
  }): Effect.fn.Return<HttpClientResponse.HttpClientResponse, ClaudeCloudError> {
    const attempt = Effect.fn("claudeCloudApi.attempt")(function* (): Effect.fn.Return<
      HttpClientResponse.HttpClientResponse,
      ClaudeCloudError
    > {
      const credentials = yield* input.credentials.read;
      const token = Redacted.value(credentials.accessToken);
      const orgUuid = options.orgScoped ? yield* organizationUuid : null;
      let request = HttpClientRequest.make(options.method)(`${API_BASE}${options.path}`).pipe(
        HttpClientRequest.bearerToken(token),
        HttpClientRequest.setHeaders({
          ...API_HEADERS,
          ...(orgUuid === null ? {} : { "x-organization-uuid": orgUuid }),
          ...options.headers,
        }),
      );
      if (options.body !== undefined) {
        request = HttpClientRequest.bodyJsonUnsafe(request, options.body);
      }
      const response = yield* input.httpClient
        .execute(request)
        .pipe(
          Effect.mapError((error) => apiError("transport", String(error.reason ?? error.message))),
        );
      if (response.status >= 200 && response.status < 300) return response;
      return yield* failForStatus(response, token);
    });
    return yield* attempt().pipe(
      Effect.catchIf(
        (error) => error._tag === "CloudApiError" && error.kind === "auth" && error.status === 401,
        () => input.credentials.invalidate.pipe(Effect.andThen(attempt())),
      ),
    );
  });

  const json = <A>(schema: Schema.Decoder<A>, response: HttpClientResponse.HttpClientResponse) =>
    response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(schema)),
      Effect.mapError(() => apiError("transport", "Unexpected response shape.", response.status)),
    );

  const profile = Effect.gen(function* () {
    const body = yield* execute({
      method: "GET",
      path: "/api/oauth/profile",
      orgScoped: false,
    }).pipe(Effect.flatMap((response) => json(ProfileBody, response)));
    yield* Ref.set(orgUuidRef, body.organization.uuid);
    return { email: body.account.email, orgUuid: body.organization.uuid };
  });

  const organizationUuid = Effect.gen(function* () {
    const cached = yield* Ref.get(orgUuidRef);
    return cached ?? (yield* profile).orgUuid;
  });

  const defaultEnvironmentId = Effect.gen(function* () {
    const cached = yield* Ref.get(environmentIdRef);
    if (cached !== null) return cached;
    const body = yield* execute({
      method: "GET",
      path: "/v1/environment_providers",
      orgScoped: true,
    }).pipe(Effect.flatMap((response) => json(EnvironmentsBody, response)));
    const environment = body.environments.find((entry) => entry.kind === "anthropic_cloud");
    if (environment === undefined) {
      return yield* apiError("not_found", "No Claude cloud environment on this account.");
    }
    yield* Ref.set(environmentIdRef, environment.environment_id);
    return environment.environment_id;
  });

  const createSession: ClaudeCloudApi["createSession"] = Effect.fn("claudeCloudApi.createSession")(
    function* (options) {
      const environmentId = yield* defaultEnvironmentId;
      const body = yield* execute({
        method: "POST",
        path: "/v1/code/sessions",
        orgScoped: true,
        body: {
          title: options.title,
          environment_id: environmentId,
          events: [],
          config: {
            sources: options.sources.map((source) => ({ type: "git_repository", url: source.url })),
            outcomes: [],
            ...(options.model === undefined ? {} : { model: options.model }),
            ...(options.effort === undefined ? {} : { effort_level: options.effort }),
          },
        },
      }).pipe(Effect.flatMap((response) => json(CreatedSessionBody, response)));
      return { id: body.session.id, sessionUrl: body.session.session_url ?? null };
    },
  );

  const getSession: ClaudeCloudApi["getSession"] = Effect.fn("claudeCloudApi.getSession")(
    function* (id) {
      const body = yield* execute({
        method: "GET",
        path: `/v1/code/sessions/${encodeURIComponent(id)}`,
        orgScoped: true,
      }).pipe(Effect.flatMap((response) => json(SessionBody, response)));
      const shape = body.response_shape;
      return {
        id: shape?.id ?? body.id ?? id,
        archived: (shape?.status ?? body.status) === "archived",
      };
    },
  );

  const latestEvents: ClaudeCloudApi["latestEvents"] = Effect.fn("claudeCloudApi.latestEvents")(
    function* (id, limit) {
      const body = yield* execute({
        method: "GET",
        path: `/v1/code/sessions/${encodeURIComponent(id)}/events?limit=${limit}`,
        orgScoped: true,
      }).pipe(Effect.flatMap((response) => json(EventsBody, response)));
      return body.data.flatMap((event) => {
        const sequenceNum = Number(event.sequence_num);
        return Number.isFinite(sequenceNum)
          ? [{ sequenceNum, eventType: event.event_type, source: event.source }]
          : [];
      });
    },
  );

  const sendEvents: ClaudeCloudApi["sendEvents"] = Effect.fn("claudeCloudApi.sendEvents")(
    function* (id, events) {
      yield* execute({
        method: "POST",
        path: `/v1/code/sessions/${encodeURIComponent(id)}/events`,
        orgScoped: true,
        body: {
          events: events.map((event) => ({
            event_id: event.eventId,
            event_type: event.eventType,
            source: "client",
            payload: event.payload,
          })),
        },
      });
    },
  );

  const archive: ClaudeCloudApi["archive"] = Effect.fn("claudeCloudApi.archive")(function* (id) {
    yield* execute({
      method: "POST",
      path: `/v1/code/sessions/${encodeURIComponent(id)}/archive`,
      orgScoped: true,
      body: {},
    });
  });

  const streamFrames: ClaudeCloudApi["streamFrames"] = (id, options) =>
    Stream.unwrap(
      execute({
        method: "GET",
        path: `/v1/code/sessions/${encodeURIComponent(id)}/events/stream`,
        orgScoped: true,
        headers: {
          accept: "text/event-stream",
          ...(options?.lastEventId === undefined
            ? {}
            : { "last-event-id": String(options.lastEventId) }),
        },
      }).pipe(
        Effect.map((response) =>
          response.stream.pipe(
            Stream.decodeText(),
            Stream.pipeThroughChannel(Sse.decode()),
            Stream.flatMap((event) => Stream.fromIterable(Option.toArray(decodeCloudFrame(event)))),
            Stream.mapError((error): ClaudeCloudError =>
              error._tag === "HttpClientError"
                ? apiError("transport", "The event stream was interrupted.")
                : apiError("transport", "The event stream could not be decoded."),
            ),
          ),
        ),
      ),
    );

  return {
    profile,
    createSession,
    getSession,
    latestEvents,
    sendEvents,
    archive,
    streamFrames,
  } satisfies ClaudeCloudApi;
});
