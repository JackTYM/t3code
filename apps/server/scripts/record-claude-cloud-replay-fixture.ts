/**
 * Records a Claude Cloud replay fixture from a live session, driving the real
 * adapter against the real API. Creates exactly one cloud session and always
 * archives it, even when the turn fails.
 *
 *   node scripts/record-claude-cloud-replay-fixture.ts --scenario claude_cloud_simple
 *
 * Reads the `claude` CLI login through the provider's own credential store and
 * never prints it. The transcript keeps decoded frames, with the session id
 * replaced and adapter-minted ids wildcarded.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type ProviderReplayEntry,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  NodeId,
  MessageId,
  ProjectId,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import {
  makeClaudeCloudApi,
  makeClaudeCloudCredentialStore,
  type ClaudeCloudApi,
  type CloudFrame,
} from "@t3tools/provider-claude-cloud/server";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient } from "effect/http";

import {
  CLAUDE_CLOUD_HTTP_SSE_PROTOCOL,
  CLAUDE_CLOUD_PROVIDER_KIND,
  CLAUDE_CLOUD_REPLAY_ANY,
} from "../src/orchestration-v2/Adapters/ClaudeCloudAdapterV2.testkit.ts";
import { makeClaudeCloudAdapterV2 } from "../src/orchestration-v2/Adapters/ClaudeCloudAdapterV2.ts";
import { ORCHESTRATOR_REPLAY_FIXTURES } from "../src/orchestration-v2/testkit/fixtures/index.ts";
import { CLAUDE_CLOUD_MODEL_SELECTION } from "../src/orchestration-v2/testkit/fixtures/shared.ts";

const REPLAY_SESSION_ID = "cse_replay";
const JsonString = Schema.fromJsonString(Schema.Unknown);
const encodeJson = Schema.encodeSync(JsonString);
const decodeJson = Schema.decodeSync(JsonString);

const scenarioIndex = process.argv.indexOf("--scenario");
const scenario = scenarioIndex === -1 ? undefined : process.argv[scenarioIndex + 1];
const fixture = ORCHESTRATOR_REPLAY_FIXTURES.find((entry) => entry.name === scenario);
const firstMessage = fixture?.buildInput().steps.find((step) => step.type === "message");
if (
  fixture === undefined ||
  firstMessage?.type !== "message" ||
  !fixture.providers.some((provider) => provider.driver === CLAUDE_CLOUD_PROVIDER_KIND)
) {
  throw new Error("Pass --scenario with a single-message fixture that registers claudeCloud.");
}

/** Inverse of decodeCloudFrame, so the replay runs frames through the real decoder. */
const encodeFrame = (frame: CloudFrame) => {
  switch (frame._tag) {
    case "sessionEvent":
      return {
        event: "client_event",
        data: {
          event_id: frame.eventId,
          sequence_num: frame.sequenceNum,
          event_type: frame.eventType,
          source: frame.source,
          payload: frame.payload,
        },
      };
    case "deliveryUpdate":
      return { event: "delivery_update", data: { event_id: frame.eventId, status: frame.status } };
    case "sessionUpdate":
      return { event: "session_update", data: { status: frame.status } };
  }
};

const program = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const credentials = yield* makeClaudeCloudCredentialStore();
  const live = yield* makeClaudeCloudApi({ httpClient, credentials });
  const entries: Array<ProviderReplayEntry> = [];
  let liveSessionId: string | null = null;
  let recording = true;

  const recordCall = <A, E>(frame: Record<string, unknown>, call: Effect.Effect<A, E>) =>
    Effect.suspend(() => {
      if (!recording) return call;
      const index = entries.push({ type: "expect_outbound", frame }) - 1;
      return call.pipe(
        Effect.tap((response) =>
          // Frames that raced ahead of the response still replay after it.
          Effect.sync(() =>
            entries.splice(index + 1, 0, {
              type: "emit_inbound",
              frame: { response: response ?? null },
            }),
          ),
        ),
      );
    });

  const api: ClaudeCloudApi = {
    ...live,
    createSession: (input) =>
      recordCall(
        { method: "createSession", input },
        live.createSession(input).pipe(
          Effect.map((created) => {
            liveSessionId = created.id;
            // The share URL is account data the adapter never reads.
            return { ...created, sessionUrl: null };
          }),
        ),
      ),
    sendEvents: (id, events) =>
      recordCall(
        {
          method: "sendEvents",
          id,
          events: events.map((event) =>
            event.eventType === "user"
              ? {
                  ...event,
                  eventId: CLAUDE_CLOUD_REPLAY_ANY,
                  payload: { ...event.payload, uuid: CLAUDE_CLOUD_REPLAY_ANY },
                }
              : { ...event, eventId: CLAUDE_CLOUD_REPLAY_ANY, payload: CLAUDE_CLOUD_REPLAY_ANY },
          ),
        },
        live.sendEvents(id, events),
      ),
    streamFrames: (id, options) =>
      live.streamFrames(id, options).pipe(
        Stream.tap((frame) =>
          Effect.sync(() => {
            if (recording)
              entries.push({ type: "emit_inbound", frame: { sse: encodeFrame(frame) } });
          }),
        ),
      ),
  };

  const instanceId = ProviderInstanceId.make(CLAUDE_CLOUD_PROVIDER_KIND);
  const adapter = yield* makeClaudeCloudAdapterV2({
    instanceId,
    api,
    defaultCwd: process.cwd(),
    resolveRepoSource: () => Effect.succeed(null),
  });
  const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: "full-access",
    interactionMode: "default",
    cwd: null,
  });
  const threadId = ThreadId.make("thread-claude-cloud-record");
  const title = `Replay fixture: ${fixture.name}`;

  const turn = Effect.gen(function* () {
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make("session-claude-cloud-record"),
      modelSelection: CLAUDE_CLOUD_MODEL_SELECTION,
      runtimePolicy,
    });
    const providerThread = yield* runtime.ensureThread({
      threadId,
      title,
      modelSelection: CLAUDE_CLOUD_MODEL_SELECTION,
      runtimePolicy,
    });
    const now = yield* DateTime.now;
    const appThread: OrchestrationV2AppThread = {
      id: threadId,
      projectId: ProjectId.make("project-claude-cloud-record"),
      title,
      createdBy: "user",
      creationSource: "web",
      providerInstanceId: instanceId,
      modelSelection: CLAUDE_CLOUD_MODEL_SELECTION,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThread.id,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    yield* runtime.startTurn({
      appThread,
      threadId,
      runId: RunId.make("run-record-1"),
      runOrdinal: 1,
      providerTurnOrdinal: 1,
      attemptId: RunAttemptId.make("attempt-record-1"),
      rootNodeId: NodeId.make("root-record-1"),
      providerThread,
      message: {
        messageId: MessageId.make("message-record-1"),
        text: firstMessage.text,
        attachments: [],
        createdBy: "user",
        creationSource: "web",
      },
      modelSelection: CLAUDE_CLOUD_MODEL_SELECTION,
      runtimePolicy,
    });
    const replies: Array<string> = [];
    const terminal = yield* runtime.events.pipe(
      Stream.tap((event) =>
        Effect.sync(() => {
          if (event.type === "turn_item.updated" && event.turnItem.type === "assistant_message") {
            replies.push(event.turnItem.text);
          }
        }),
      ),
      Stream.filter((event) => event.type === "turn.terminal"),
      Stream.runHead,
      Effect.timeout("3 minutes"),
    );
    recording = false;
    yield* Console.log(
      `Turn ${terminal._tag === "Some" && terminal.value.type === "turn.terminal" ? terminal.value.status : "did not settle"}; reply: "${replies.join("")}"`,
    );
  }).pipe(Effect.scoped);

  yield* turn.pipe(
    // Archive no matter how the turn ended; a live session must never leak.
    Effect.ensuring(
      Effect.suspend(() =>
        liveSessionId === null
          ? Console.log("No cloud session was created.")
          : adapter.releaseNativeThread!({ nativeThreadId: liveSessionId }).pipe(
              Effect.tap(() => Console.log("Archived the cloud session.")),
              Effect.catch((error) => Console.error(`Archive failed: ${error.message}`)),
            ),
      ),
    ),
  );

  const sessionId = liveSessionId;
  if (sessionId === null) return;
  // The session id is account data; the replay only needs it to be consistent.
  const redact = (value: unknown): unknown =>
    decodeJson(encodeJson(value).split(sessionId).join(REPLAY_SESSION_ID));
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(
    import.meta.dirname,
    "../src/orchestration-v2/testkit/fixtures",
    fixture.name,
  );
  yield* fs.makeDirectory(directory, { recursive: true });
  const header = {
    type: "transcript_start",
    provider: CLAUDE_CLOUD_PROVIDER_KIND,
    protocol: CLAUDE_CLOUD_HTTP_SSE_PROTOCOL,
    version: "1",
    scenario: fixture.name,
    metadata: {
      generatedBy: "live-claude-cloud-recorder",
      model: CLAUDE_CLOUD_MODEL_SELECTION.model,
    },
  };
  const lines = [header, ...entries.map(redact)].map((line) => encodeJson(line));
  yield* fs.writeFileString(
    path.join(directory, "claude_cloud_transcript.ndjson"),
    `${lines.join("\n")}\n`,
  );
  yield* Console.log(`Wrote ${entries.length} entries for ${fixture.name}.`);
});

program.pipe(
  Effect.provide(IdAllocator.layer),
  Effect.provide(FetchHttpClient.layer),
  Effect.provide(NodeServices.layer),
  Effect.runPromise,
);
