/**
 * Replays Claude Cloud transcripts at the HTTP/SSE boundary: API calls are
 * matched against recorded requests, and recorded SSE frames feed the
 * session's event stream through the real frame decoder.
 */
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderReplayEntry,
  type ProviderReplayTranscript,
} from "@t3tools/contracts";
import {
  ClaudeCloudApiError,
  decodeCloudFrame,
  type ClaudeCloudApi,
  type ClaudeCloudError,
  type CloudFrame,
} from "@t3tools/provider-claude-cloud/server";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import type { OrchestratorV2ProviderReplayHarness } from "../testkit/ProviderReplayHarness.ts";
import { makeClaudeCloudAdapterV2 } from "./ClaudeCloudAdapterV2.ts";

export const CLAUDE_CLOUD_PROVIDER_KIND = "claudeCloud";
export const CLAUDE_CLOUD_HTTP_SSE_PROTOCOL = "claude-cloud.http-sse";
/** Matches any recorded value, for ids the adapter mints at random. */
export const CLAUDE_CLOUD_REPLAY_ANY = "<any>";

const ClaudeCloudReplayTranscript = Schema.Struct({
  provider: Schema.Literal(CLAUDE_CLOUD_PROVIDER_KIND),
  protocol: Schema.Literal(CLAUDE_CLOUD_HTTP_SSE_PROTOCOL),
  version: Schema.String,
  scenario: Schema.String,
  entries: Schema.Array(ProviderReplayEntry),
});
type ClaudeCloudReplayTranscript = typeof ClaudeCloudReplayTranscript.Type;
const decodeTranscript = Schema.decodeUnknownEffect(ClaudeCloudReplayTranscript);

class ClaudeCloudReplayTranscriptDecodeError extends Schema.TaggedError<ClaudeCloudReplayTranscriptDecodeError>()(
  "ClaudeCloudReplayTranscriptDecodeError",
  { scenario: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Failed to decode Claude Cloud replay transcript for scenario ${this.scenario}.`;
  }
}

class ClaudeCloudReplayMismatchError extends Schema.TaggedError<ClaudeCloudReplayMismatchError>()(
  "ClaudeCloudReplayMismatchError",
  {
    scenario: Schema.String,
    cursor: Schema.Number,
    expected: Schema.Unknown,
    actual: Schema.Unknown,
  },
) {
  override get message(): string {
    return `Claude Cloud replay request mismatch at cursor ${this.cursor} in scenario ${this.scenario}.`;
  }
}

class ClaudeCloudReplayIncompleteError extends Schema.TaggedError<ClaudeCloudReplayIncompleteError>()(
  "ClaudeCloudReplayIncompleteError",
  { scenario: Schema.String, cursor: Schema.Number, remaining: Schema.Number },
) {
  override get message(): string {
    return `Claude Cloud replay ended with ${this.remaining} unconsumed entries at cursor ${this.cursor} in scenario ${this.scenario}.`;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function replayValueMatches(expected: unknown, actual: unknown): boolean {
  if (expected === CLAUDE_CLOUD_REPLAY_ANY) return true;
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((entry, index) => replayValueMatches(entry, actual[index]))
    );
  }
  if (isRecord(expected)) {
    if (!isRecord(actual)) return false;
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    return [...keys].every((key) => replayValueMatches(expected[key], actual[key]));
  }
  return Object.is(expected, actual);
}

const ReplayError = Schema.Struct({
  kind: ClaudeCloudApiError.fields.kind,
  status: Schema.optional(Schema.Int),
  detail: Schema.String,
});
const decodeReplayError = Schema.decodeUnknownSync(ReplayError);

/** Inbound entries are `{ response }`, `{ error }`, or `{ sse: { event, data } }`. */
class ClaudeCloudReplayController {
  private cursor = 0;
  private failure: unknown = null;
  readonly streamOpens: Array<{ readonly id: string; readonly lastEventId?: number }> = [];

  private readonly transcript: ClaudeCloudReplayTranscript;
  private readonly frames: Queue.Queue<CloudFrame, ClaudeCloudError | Cause.Done>;

  constructor(
    transcript: ClaudeCloudReplayTranscript,
    frames: Queue.Queue<CloudFrame, ClaudeCloudError | Cause.Done>,
  ) {
    this.transcript = transcript;
    this.frames = frames;
  }

  request(actual: Record<string, unknown>): Effect.Effect<unknown, ClaudeCloudError> {
    return Effect.suspend(() => {
      if (this.failure !== null) return Effect.die(this.failure);
      const entries = this.transcript.entries;
      const expected = entries[this.cursor];
      if (expected?.type !== "expect_outbound" || !replayValueMatches(expected.frame, actual)) {
        this.failure = new ClaudeCloudReplayMismatchError({
          scenario: this.transcript.scenario,
          cursor: this.cursor,
          expected: expected ?? null,
          actual,
        });
        return Effect.die(this.failure);
      }
      this.cursor += 1;
      const answer = entries[this.cursor];
      let outcome: Effect.Effect<unknown, ClaudeCloudError> = Effect.void;
      if (answer?.type === "emit_inbound" && isRecord(answer.frame)) {
        if ("response" in answer.frame) {
          outcome = Effect.succeed(answer.frame.response);
          this.cursor += 1;
        } else if ("error" in answer.frame) {
          outcome = Effect.fail(new ClaudeCloudApiError(decodeReplayError(answer.frame.error)));
          this.cursor += 1;
        }
      }
      this.drainFrames();
      return outcome;
    });
  }

  assertComplete(): void {
    if (this.failure !== null) throw this.failure;
    if (this.cursor !== this.transcript.entries.length) {
      throw new ClaudeCloudReplayIncompleteError({
        scenario: this.transcript.scenario,
        cursor: this.cursor,
        remaining: this.transcript.entries.length - this.cursor,
      });
    }
  }

  private drainFrames(): void {
    while (true) {
      const entry = this.transcript.entries[this.cursor];
      if (entry?.type !== "emit_inbound" || !isRecord(entry.frame) || !isRecord(entry.frame.sse)) {
        return;
      }
      this.cursor += 1;
      const sse = entry.frame.sse;
      const decoded = decodeCloudFrame({
        event: String(sse.event),
        data: typeof sse.data === "string" ? sse.data : JSON.stringify(sse.data),
      });
      if (Option.isSome(decoded)) Queue.offerUnsafe(this.frames, decoded.value);
    }
  }
}

const makeReplayApi = (
  controller: ClaudeCloudReplayController,
  frames: Queue.Dequeue<CloudFrame, ClaudeCloudError | Cause.Done>,
): ClaudeCloudApi => ({
  profile: Effect.succeed({ email: "replay@example.com", orgUuid: "replay-org" }),
  createSession: (input) =>
    controller
      .request({ method: "createSession", input })
      .pipe(Effect.map((response) => response as { id: string; sessionUrl: string | null })),
  getSession: (id) =>
    controller
      .request({ method: "getSession", id })
      .pipe(Effect.map((response) => response as { id: string; archived: boolean })),
  latestEvents: (id, limit) =>
    controller
      .request({ method: "latestEvents", id, limit })
      .pipe(
        Effect.map(
          (response) =>
            response as ReadonlyArray<{ sequenceNum: number; eventType: string; source: string }>,
        ),
      ),
  sendEvents: (id, events) =>
    controller.request({ method: "sendEvents", id, events }).pipe(Effect.asVoid),
  archive: (id) => controller.request({ method: "archive", id }).pipe(Effect.asVoid),
  streamFrames: (id, options) =>
    Stream.unwrap(
      Effect.sync(() => {
        controller.streamOpens.push({
          id,
          ...(options?.lastEventId === undefined ? {} : { lastEventId: options.lastEventId }),
        });
        return Stream.fromQueue(frames);
      }),
    ),
});

export const ClaudeCloudOrchestratorReplayHarness: OrchestratorV2ProviderReplayHarness<
  ClaudeCloudReplayTranscript,
  ClaudeCloudReplayTranscriptDecodeError
> = {
  driver: ProviderDriverKind.make(CLAUDE_CLOUD_PROVIDER_KIND),
  decodeTranscript: (transcript: ProviderReplayTranscript) =>
    decodeTranscript(transcript).pipe(
      Effect.mapError(
        (cause) =>
          new ClaudeCloudReplayTranscriptDecodeError({ scenario: transcript.scenario, cause }),
      ),
    ),
  makeProviderAdapterRegistryLayer: (transcript) =>
    Layer.unwrap(
      Effect.gen(function* () {
        const frames = yield* Queue.unbounded<CloudFrame, ClaudeCloudError | Cause.Done>();
        const controller = new ClaudeCloudReplayController(transcript, frames);
        yield* Effect.addFinalizer(() => Effect.sync(() => controller.assertComplete()));
        return ProviderAdapterRegistry.layerFromAdaptersEffect(
          Effect.gen(function* () {
            return [
              yield* makeClaudeCloudAdapterV2({
                instanceId: ProviderInstanceId.make(CLAUDE_CLOUD_PROVIDER_KIND),
                api: makeReplayApi(controller, frames),
                defaultCwd: process.cwd(),
                resolveRepoSource: () => Effect.succeed(null),
              }),
            ];
          }),
        ).pipe(Layer.provide(IdAllocator.layer));
      }),
    ),
};
