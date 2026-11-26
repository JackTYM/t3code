import * as PlatformNodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as BotHoldService from "./BotHoldService.ts";
import * as BotService from "./BotService.ts";
import { makeOrchestration, model } from "./BotTestkit.ts";
import * as RepairService from "./RepairService.ts";

// BotHoldService.test.ts mocks `crewOf`. This is the same decision over the real RepairService,
// whose registry and `startRepair` are what make a thread a repair crew at all.

const START = Date.UTC(2026, 10, 26, 12);
const REPAIR_PROJECT = ProjectId.make("project:t3code");
const HERE = EnvironmentId.make("env:here");

const fixture = () => {
  const orchestration = makeOrchestration();
  orchestration.projects.set(REPAIR_PROJECT, { title: "T3 Code", workspaceRoot: "/work/t3code" });
  const bot = orchestration.addThread("thread:bot", {
    botConfig: { enabled: true, muteChildren: false },
  });
  return { orchestration, bot };
};

const provide = (orchestration: ReturnType<typeof makeOrchestration>) =>
  Effect.provide(
    BotHoldService.layer.pipe(
      Layer.provideMerge(RepairService.layer),
      Layer.provideMerge(BotService.layer),
      Layer.provideMerge(orchestration.layer),
      Layer.provideMerge(
        ServerSettings.ServerSettingsService.layerTest({
          home: { repairProjectId: REPAIR_PROJECT },
          defaultModelSelection: model,
        }),
      ),
      Layer.provideMerge(ServerSecretStore.layer),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-hold-repair-" })),
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, PlatformNodeCrypto.layer)),
    ),
  );

const TOOLS = [
  { tool: "t3_thread_send", params: { message: "go" } },
  { tool: "t3_thread_send_attachments", params: { message: "go", attachments: [] } },
  { tool: "t3_thread_interrupt", params: {} },
] as const;

const heldFor =
  (holds: BotHoldService.BotHoldService["Service"], botThreadId: ThreadId) =>
  (threadId: ThreadId) =>
    Effect.forEach(TOOLS, ({ tool, params }) =>
      holds
        .check({
          botThreadId,
          tool,
          readonly: false,
          params: { ...params, threadId },
          environmentId: HERE,
        })
        .pipe(Effect.map((verdict) => verdict.held)),
    );

it.effect("holds a thread a real repair crew launched, and frees the crew the Bot launched", () => {
  const { orchestration, bot } = fixture();
  return Effect.gen(function* () {
    yield* TestClock.setTime(START);
    const repair = yield* RepairService.RepairService;
    const holds = yield* BotHoldService.BotHoldService;

    // The server wakes the Bot, and the Bot starts the crew from that turn.
    yield* repair.signal({
      kind: "watcher",
      botThreadId: bot.id,
      name: "disk",
      count: 3,
      firstAt: START - 60_000,
      lastAt: START,
    });
    const wake = orchestration.sent.at(-1)!;
    orchestration.startRun(bot, { id: wake.commandId, createdBy: "system" });
    const signalId = /^bot-wake:health:([0-9a-f]{12}):/u.exec(wake.commandId)![1]!;
    const { threadId: crew } = yield* repair.startRepair({ botThreadId: bot.id, signalId });
    assert.strictEqual((yield* repair.crewOf(crew))?.signalId, signalId);

    // The crew launches a sibling and the Bot launches an ordinary crew thread, each with a prompt:
    // both are grouped under the Bot, and only the first message tells them apart.
    const sibling = orchestration.addThread("thread:sibling", {
      groupedUnderThreadId: bot.id,
      createdBy: "agent",
      creationSource: "mcp",
    });
    orchestration.startRun(sibling, {
      id: "message:sibling",
      createdBy: "agent",
      senderThreadId: crew,
    });
    const siblingOfSibling = orchestration.addThread("thread:sibling-of-sibling", {
      groupedUnderThreadId: bot.id,
      createdBy: "agent",
      creationSource: "mcp",
    });
    orchestration.startRun(siblingOfSibling, {
      id: "message:sibling-of-sibling",
      createdBy: "agent",
      senderThreadId: sibling.id,
    });
    const own = orchestration.addThread("thread:own-crew", {
      groupedUnderThreadId: bot.id,
      createdBy: "agent",
      creationSource: "mcp",
    });
    orchestration.startRun(own, {
      id: "message:own-crew",
      createdBy: "agent",
      senderThreadId: bot.id,
    });

    // A mail digest begins the Bot's next turn, which is the influenced one.
    orchestration.startRun(bot, { id: "bot-wake:mail:home:1:1", createdBy: "system" });
    const held = heldFor(holds, bot.id);
    assert.deepStrictEqual(yield* held(crew), [true, true, true]);
    assert.deepStrictEqual(yield* held(sibling.id), [true, true, true]);
    assert.deepStrictEqual(yield* held(siblingOfSibling.id), [true, true, true]);
    assert.deepStrictEqual(yield* held(own.id), [false, false, false]);
  }).pipe(provide(orchestration));
});
