import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderReplayTranscript,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { readProviderReplayTranscript } from "@t3tools/provider-testing/replayTranscript";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import { makeClaudeReplayHarnessWithEnvironment } from "./Adapters/ClaudeAdapterV2.testkit.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ReplyEditService from "./ReplyEditService.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import { provideDeterministicTestRuntime } from "./testkit/DeterministicRuntime.ts";
import { CLAUDE_MODEL_SELECTION, materializeFixtureInput } from "./testkit/fixtures/shared.ts";
import { simpleInput } from "./testkit/fixtures/simple/input.ts";
import { runOrchestratorV2Scenario } from "./testkit/OrchestratorScenario.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { materializeReplayTranscriptRuntimeInstructions } from "./testkit/ReplayRuntimeInstructions.ts";

const { planReplyEdit } = ReplyEditService;

describe("planReplyEdit", () => {
  const original = { text: "blue", edits: undefined };

  it("keeps the original as version 1 and selects text that is already a version", () => {
    const first = planReplyEdit(original, { type: "edit", text: "green" });
    assert.deepStrictEqual(first, {
      _tag: "Apply",
      expectedText: "blue",
      text: "green",
      edits: { selected: 2, versions: ["blue", "green"] },
    });
    if (first._tag !== "Apply") return;
    const edited = { text: first.text, edits: first.edits };
    assert.deepStrictEqual(planReplyEdit(edited, { type: "edit", text: "blue" }), {
      _tag: "Apply",
      expectedText: "green",
      text: "blue",
      edits: { selected: 1, versions: ["blue", "green"] },
    });
    assert.deepStrictEqual(planReplyEdit(edited, { type: "select", version: 1 }), {
      _tag: "Apply",
      expectedText: "green",
      text: "blue",
      edits: { selected: 1, versions: ["blue", "green"] },
    });
  });

  it("refuses empty text, unknown versions and a full history, and ignores no-ops", () => {
    assert.deepStrictEqual(planReplyEdit(original, { type: "edit", text: "  \n" }), {
      _tag: "Refused",
      reason: "empty-text",
    });
    assert.deepStrictEqual(planReplyEdit(original, { type: "edit", text: "blue" }), {
      _tag: "Unchanged",
    });
    assert.deepStrictEqual(planReplyEdit(original, { type: "select", version: 1 }), {
      _tag: "Refused",
      reason: "unknown-version",
    });
    const full = {
      text: "v10",
      edits: { selected: 10, versions: Array.from({ length: 10 }, (_, index) => `v${index + 1}`) },
    };
    assert.deepStrictEqual(planReplyEdit(full, { type: "edit", text: "v11" }), {
      _tag: "Refused",
      reason: "version-limit",
    });
    assert.deepStrictEqual(planReplyEdit(full, { type: "select", version: 11 }), {
      _tag: "Refused",
      reason: "unknown-version",
    });
    assert.deepStrictEqual(planReplyEdit(full, { type: "select", version: 10 }), {
      _tag: "Unchanged",
    });
  });
});

const readSimpleClaudeFixture = Effect.fn("readSimpleClaudeFixture")(function* () {
  return yield* readProviderReplayTranscript(
    new URL("./testkit/fixtures/simple/claude_transcript.ndjson", import.meta.url),
  );
}, Effect.provide(NodeServices.layer));

type AssistantItem = Extract<OrchestrationV2TurnItem, { readonly type: "assistant_message" }>;

describe("ReplyEditService", () => {
  it.effect(
    "rewrites the agent's own history, releases its live session and switches versions",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "reply-edit-" });
        const configDir = path.join(root, "claude");
        const harness = makeClaudeReplayHarnessWithEnvironment([
          { name: "CLAUDE_CONFIG_DIR", value: configDir },
        ]);
        const raw: ProviderReplayTranscript = yield* readSimpleClaudeFixture();
        const transcript = yield* harness.decodeTranscript(
          materializeReplayTranscriptRuntimeInstructions(raw, {
            driver: ProviderDriverKind.make("claudeAgent"),
            model: CLAUDE_MODEL_SELECTION.model,
          }),
        );
        const materialized = yield* materializeFixtureInput({
          scenario: "reply-edit",
          fixtureInput: simpleInput(),
          driver: ProviderDriverKind.make("claudeAgent"),
          modelSelection: CLAUDE_MODEL_SELECTION,
        }).pipe(Effect.provide(IdAllocator.layer), provideDeterministicTestRuntime);
        const scenario = {
          name: "reply-edit",
          transcript,
          commands: materialized.commands,
          steps: materialized.steps,
          projectionThreadIds: materialized.projectionThreadIds,
        };
        const registry = harness.makeProviderAdapterRegistryLayer(transcript);

        yield* Effect.gen(function* () {
          const result = yield* runOrchestratorV2Scenario(scenario);
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
          const replyEdits = yield* ReplyEditService.ReplyEditService;
          const serverConfig = yield* ServerConfig.ServerConfig;
          const before = [...result.projections.values()][0]!;
          const threadId = before.thread.id;
          const item = before.turnItems.find(
            (candidate): candidate is AssistantItem => candidate.type === "assistant_message",
          )!;
          const providerThread = before.providerThreads.find(
            (candidate) => candidate.id === before.thread.activeProviderThreadId,
          )!;
          const sessionId = providerThread.nativeThreadRef!.nativeId!;
          const providerSessionId = providerThread.providerSessionId!;
          assert.isTrue(yield* sessions.isLive(providerSessionId));

          // The history Claude Code would have written for this turn.
          const transcriptPath = path.join(
            configDir,
            "projects",
            "-private-tmp-reply-edit",
            `${sessionId}.jsonl`,
          );
          yield* fileSystem.makeDirectory(path.dirname(transcriptPath), { recursive: true });
          const history =
            [
              {
                type: "user",
                uuid: "user-1",
                parentUuid: null,
                sessionId,
                message: { role: "user", content: "Respond with the following text" },
              },
              {
                type: "assistant",
                uuid: item.nativeItemRef!.nativeId,
                parentUuid: "user-1",
                sessionId,
                message: {
                  id: "msg_1",
                  role: "assistant",
                  content: [
                    { type: "thinking", thinking: "", signature: "sig==" },
                    { type: "text", text: item.text },
                  ],
                },
              },
            ]
              .map((line) => JSON.stringify(line))
              .join("\n") + "\n";
          yield* fileSystem.writeFileString(transcriptPath, history);

          yield* replyEdits.edit({ threadId, messageId: item.messageId, text: "fixture edited" });

          assert.isFalse(yield* sessions.isLive(providerSessionId));
          const edited = yield* fileSystem.readFileString(transcriptPath);
          assert.strictEqual(
            edited,
            history.replace(`"text":${JSON.stringify(item.text)}`, '"text":"fixture edited"'),
          );
          assert.strictEqual(
            yield* fileSystem.readFileString(
              path.join(serverConfig.stateDir, "reply-edit-backups", `${sessionId}.jsonl`),
            ),
            history,
          );
          const afterEdit = yield* orchestrator.getThreadProjection(threadId);
          const editedItem = afterEdit.turnItems.find(
            (candidate): candidate is AssistantItem =>
              candidate.type === "assistant_message" && candidate.messageId === item.messageId,
          )!;
          assert.strictEqual(editedItem.text, "fixture edited");
          assert.deepStrictEqual(editedItem.edits, {
            selected: 2,
            versions: [item.text, "fixture edited"],
          });
          assert.strictEqual(
            afterEdit.messages.find((message) => message.id === item.messageId)?.text,
            "fixture edited",
          );

          yield* replyEdits.selectVersion({ threadId, messageId: item.messageId, version: 1 });
          assert.strictEqual(yield* fileSystem.readFileString(transcriptPath), history);
          const afterSelect = yield* orchestrator.getThreadProjection(threadId);
          const selectedItem = afterSelect.turnItems.find(
            (candidate): candidate is AssistantItem =>
              candidate.type === "assistant_message" && candidate.messageId === item.messageId,
          )!;
          assert.strictEqual(selectedItem.text, item.text);
          assert.strictEqual(selectedItem.edits?.selected, 1);

          // A record that does not start from the text the history was rewritten from, or that
          // drops a version, must not land.
          for (const [expectedText, versions] of [
            ["not the current text", [item.text, "fixture edited"]],
            [item.text, ["fixture edited", item.text]],
          ] as const) {
            const rejected = yield* orchestrator
              .dispatch({
                type: "assistant-message.edit.record",
                commandId: CommandId.make(`command:reply-edit:reject:${expectedText}`),
                threadId,
                messageId: item.messageId,
                expectedText,
                edits: { selected: 2, versions },
              })
              .pipe(Effect.flip);
            assert.strictEqual(rejected._tag, "OrchestratorDispatchError");
          }

          const refusal = (effect: Effect.Effect<void, { readonly reason: string }>) =>
            effect.pipe(
              Effect.flip,
              Effect.map((error) => error.reason),
            );
          assert.strictEqual(
            yield* refusal(
              replyEdits.edit({
                threadId,
                messageId: MessageId.make("message:missing"),
                text: "x",
              }),
            ),
            "not-editable",
          );
          assert.strictEqual(
            yield* refusal(replyEdits.edit({ threadId, messageId: item.messageId, text: " " })),
            "empty-text",
          );
          assert.strictEqual(
            yield* refusal(
              replyEdits.selectVersion({ threadId, messageId: item.messageId, version: 7 }),
            ),
            "unknown-version",
          );

          // History changed behind T3's back: refuse and leave both sides alone.
          const diverged = history.replace(
            `"text":${JSON.stringify(item.text)}`,
            '"text":"changed elsewhere"',
          );
          yield* fileSystem.writeFileString(transcriptPath, diverged);
          assert.strictEqual(
            yield* refusal(
              replyEdits.edit({ threadId, messageId: item.messageId, text: "another" }),
            ),
            "out-of-sync",
          );
          assert.strictEqual(yield* fileSystem.readFileString(transcriptPath), diverged);
          const afterRefusal = yield* orchestrator.getThreadProjection(threadId);
          assert.deepStrictEqual(
            afterRefusal.turnItems.find((candidate) => candidate.id === selectedItem.id),
            selectedItem,
          );
        }).pipe(
          Effect.provide(
            ReplyEditService.layer.pipe(
              Layer.provideMerge(ProviderReplayHarness.layerWithRegistry(scenario, registry, {})),
              Layer.provideMerge(
                Layer.mergeAll(
                  registry.pipe(Layer.provide(McpProviderSessions.layer)),
                  ThreadCommandExecutor.layer,
                  Layer.effect(
                    ServerConfig.ServerConfig,
                    ProviderReplayHarness.makeReplayServerConfig("reply-edit").pipe(Effect.orDie),
                  ),
                ),
              ),
            ),
          ),
          provideDeterministicTestRuntime,
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("ReplyEditService gating", () => {
  const threadId = ThreadId.make("thread:reply-edit:gating");
  const messageId = MessageId.make("message:reply-edit:gating");
  const instanceId = ProviderInstanceId.make("claudeAgent");
  const providerThreadId = ProviderThreadId.make("provider-thread:reply-edit:gating");

  const records = (overrides: {
    readonly runStatus?: string;
    readonly pendingRequest?: boolean;
    readonly backgroundTask?: boolean;
    readonly itemProviderThreadId?: ProviderThreadId;
  }) =>
    ({
      thread: {
        id: threadId,
        deletedAt: null,
        archivedAt: null,
        lineage: { relationshipToParent: null },
        creationSource: "web",
        activeProviderThreadId: providerThreadId,
      },
      runs: overrides.runStatus === undefined ? [] : [{ status: overrides.runStatus }],
      runtimeRequests: overrides.pendingRequest === true ? [{ status: "pending" }] : [],
      providerThreads: [
        {
          id: providerThreadId,
          appThreadId: threadId,
          providerInstanceId: instanceId,
          providerSessionId: null,
          nativeThreadRef: { nativeId: "session-1" },
          pendingBackgroundTasks:
            overrides.backgroundTask === true ? [{ taskId: "t", kind: "command" }] : [],
        },
      ],
      turnItems: [
        {
          type: "assistant_message",
          messageId,
          status: "completed",
          streaming: false,
          text: "blue",
          providerThreadId: overrides.itemProviderThreadId ?? providerThreadId,
          nativeItemRef: { nativeId: "uuid-1" },
        },
      ],
    }) as unknown as OrchestrationV2ThreadProjection;

  const run = (
    projection: OrchestrationV2ThreadProjection,
    editAssistantText: ProviderAdapter.ProviderAdapterV2["Service"]["editAssistantText"],
  ) =>
    Effect.gen(function* () {
      const service = yield* ReplyEditService.ReplyEditService;
      return yield* service.edit({ threadId, messageId, text: "green" }).pipe(
        Effect.flip,
        Effect.map((error) => error.reason),
      );
    }).pipe(
      Effect.provide(
        ReplyEditService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(Orchestrator.OrchestratorV2)({
                getThreadRecords: () => Effect.succeed(projection),
                dispatch: () => Effect.die("a refused edit must not record anything"),
              }),
              ProviderAdapterRegistry.layerFromAdapters([
                {
                  instanceId,
                  driver: ProviderDriverKind.make("claudeAgent"),
                  getCapabilities: () => Effect.die("unused"),
                  planSelectionTransition: () => Effect.die("unused"),
                  openSession: () => Effect.die("unused"),
                  ...(editAssistantText === undefined ? {} : { editAssistantText }),
                } as ProviderAdapter.ProviderAdapterV2["Service"],
              ]),
              Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
              ThreadCommandExecutor.layer,
              Layer.effect(
                ServerConfig.ServerConfig,
                ProviderReplayHarness.makeReplayServerConfig("reply-edit-gating").pipe(
                  Effect.orDie,
                ),
              ),
            ),
          ),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );

  const untouched = () => Effect.die("history must not be touched");

  it.effect("refuses while the agent is busy, without touching its history", () =>
    Effect.gen(function* () {
      for (const status of ["running", "queued", "waiting", "starting", "preparing"]) {
        assert.strictEqual(yield* run(records({ runStatus: status }), untouched), "thread-busy");
      }
      assert.strictEqual(yield* run(records({ pendingRequest: true }), untouched), "thread-busy");
      assert.strictEqual(yield* run(records({ backgroundTask: true }), untouched), "thread-busy");
    }),
  );

  it.effect(
    "refuses providers without native history editing and replies from other sessions",
    () =>
      Effect.gen(function* () {
        assert.strictEqual(yield* run(records({}), undefined), "unsupported");
        assert.strictEqual(
          yield* run(
            records({
              itemProviderThreadId: ProviderThreadId.make("provider-thread:reply-edit:older"),
            }),
            untouched,
          ),
          "not-in-history",
        );
      }),
  );
});
