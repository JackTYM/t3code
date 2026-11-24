import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ExitCode } from "effect/process/ChildProcessSpawner";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as BotService from "./BotService.ts";
import { makeOrchestration } from "./BotTestkit.ts";
import * as WatcherService from "./WatcherService.ts";

const bot = { enabled: true, muteChildren: false } as const;
const EVERY_MS = 60_000;
const MINUTE = 60_000;

type Scripted = Pick<ProcessRunner.ProcessRunOutput, "code" | "stdout" | "timedOut">;

/** A ProcessRunner that answers with whatever the test last set, counting its runs. */
const makeScriptedRunner = () => {
  const state: { result: Scripted | ProcessRunner.ProcessRunError; runs: number } = {
    result: { code: ExitCode(0), stdout: "", timedOut: false },
    runs: 0,
  };
  const layer = Layer.mock(ProcessRunner.ProcessRunner)({
    run: () => {
      state.runs += 1;
      const { result } = state;
      return "_tag" in result
        ? Effect.fail(result)
        : Effect.succeed({
            ...result,
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          });
    },
  });
  return { state, layer };
};

const provideWatchers = (
  orchestration: ReturnType<typeof makeOrchestration>,
  runner: Layer.Layer<ProcessRunner.ProcessRunner>,
) =>
  Effect.provide(
    WatcherService.layer.pipe(
      Layer.provideMerge(Layer.mergeAll(runner, Scheduler.layer)),
      Layer.provideMerge(BotService.layer),
      Layer.provideMerge(orchestration.layer),
      Layer.provideMerge(ServerSettings.ServerSettingsService.layerTest()),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-watchers-test-" })),
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    ),
  );

const installWatcher = Effect.fn("installWatcher")(function* (
  threadId: ThreadId,
  name: string,
  options: { readonly run?: string; readonly expect?: string; readonly approve?: boolean } = {},
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { baseDir } = yield* ServerConfig.ServerConfig;
  const directory = path.join(
    baseDir,
    "bots",
    BotService.memoryFolderName(threadId),
    "watchers",
    name,
  );
  const run = options.run ?? "#!/bin/sh\nexit 1\n";
  const config = {
    everyMs: EVERY_MS,
    timeoutMs: 5_000,
    ...(options.expect === undefined ? {} : { expect: options.expect }),
  };
  const approvedHash = WatcherService.computeHash({ run: new TextEncoder().encode(run), config });
  yield* fileSystem.makeDirectory(directory, { recursive: true });
  yield* fileSystem.writeFileString(path.join(directory, "run"), run);
  yield* fileSystem.chmod(path.join(directory, "run"), 0o755);
  yield* fileSystem.writeFileString(
    path.join(directory, "watcher.json"),
    JSON.stringify(options.approve === false ? config : { ...config, approvedHash }),
  );
  return directory;
});

it.effect("runs a watcher only while its content matches the approved hash", () => {
  const orchestration = makeOrchestration();
  const botThread = orchestration.addThread("thread:bot", { botConfig: bot });
  const plain = orchestration.addThread("thread:plain");
  const runner = makeScriptedRunner();
  runner.state.result = { code: ExitCode(1), stdout: "", timedOut: false };
  return Effect.gen(function* () {
    const watchers = yield* WatcherService.WatcherService;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const approved = yield* installWatcher(botThread.id, "disk");
    yield* installWatcher(botThread.id, "unapproved", { approve: false });
    // Only a live Bot's watchers run.
    yield* installWatcher(plain.id, "ignored");

    yield* watchers.runDue;
    assert.strictEqual(runner.state.runs, 1);
    assert.deepStrictEqual(
      (yield* watchers.list(botThread.id)).map(({ name, status }) => [name, status]),
      [
        ["disk", "tripped"],
        ["unapproved", "needs_approval"],
      ],
    );

    // Editing the script voids the approval; it stops running until approved again.
    yield* fileSystem.writeFileString(path.join(approved, "run"), "#!/bin/sh\nexit 0\n");
    yield* TestClock.adjust(EVERY_MS);
    yield* watchers.runDue;
    assert.strictEqual(runner.state.runs, 1);
    assert.deepStrictEqual(
      (yield* watchers.list(botThread.id)).map(({ name, status }) => [name, status]),
      [
        ["disk", "needs_approval"],
        ["unapproved", "needs_approval"],
      ],
    );
  }).pipe(provideWatchers(orchestration, runner.layer));
});

it.effect("wakes once per failure, backs off while it persists, and clears on recovery", () => {
  const orchestration = makeOrchestration();
  const botThread = orchestration.addThread("thread:bot", { botConfig: bot });
  const runner = makeScriptedRunner();
  const trip = (stdout: string) => {
    runner.state.result = { code: ExitCode(1), stdout, timedOut: false };
  };
  return Effect.gen(function* () {
    const watchers = yield* WatcherService.WatcherService;
    yield* installWatcher(botThread.id, "disk");
    const wakes = () => orchestration.sent.length;
    const poll = Effect.fnUntraced(function* (advanceMs: number) {
      yield* TestClock.adjust(advanceMs);
      yield* watchers.runDue;
    });

    trip("disk 91%");
    yield* watchers.runDue;
    assert.strictEqual(wakes(), 1);
    const first = orchestration.sent[0]!;
    assert.include(first.text, "Watcher disk tripped");
    assert.include(first.text, "disk 91%");
    assert.match(first.text, /<watcher-data-[0-9a-f-]+>[\s\S]*<\/watcher-data-[0-9a-f-]+>/u);
    assert.include(first.text, "untrusted data");

    // The same failure is not news before its first backoff elapses.
    yield* poll(EVERY_MS);
    yield* poll(10 * MINUTE);
    assert.strictEqual(wakes(), 1);

    // After the 15 minutes it is a reminder, and the next one waits twice as long.
    yield* poll(5 * MINUTE);
    assert.strictEqual(wakes(), 2);
    yield* poll(15 * MINUTE);
    assert.strictEqual(wakes(), 2);
    yield* poll(15 * MINUTE);
    assert.strictEqual(wakes(), 3);

    // New output is news at once and restarts the backoff.
    trip("disk 95%");
    yield* poll(EVERY_MS);
    assert.strictEqual(wakes(), 4);
    assert.include(orchestration.sent[3]!.text, "disk 95%");
    yield* poll(14 * MINUTE);
    assert.strictEqual(wakes(), 4);

    // Recovery is silent and forgets the failure, so the next trip is a fresh wake.
    runner.state.result = { code: ExitCode(0), stdout: "", timedOut: false };
    yield* poll(EVERY_MS);
    assert.strictEqual(wakes(), 4);
    assert.strictEqual((yield* watchers.list(botThread.id))[0]?.status, "healthy");
    trip("disk 95%");
    yield* poll(EVERY_MS);
    assert.strictEqual(wakes(), 5);

    const commandIds = orchestration.sent.map((message) => message.commandId);
    assert.strictEqual(new Set(commandIds).size, commandIds.length);
  }).pipe(provideWatchers(orchestration, runner.layer));
});

it.effect("doubles the backoff from 15 minutes to a 24 hour ceiling", () => {
  const orchestration = makeOrchestration();
  const botThread = orchestration.addThread("thread:bot", { botConfig: bot });
  const runner = makeScriptedRunner();
  runner.state.result = { code: ExitCode(2), stdout: "down", timedOut: false };
  return Effect.gen(function* () {
    const watchers = yield* WatcherService.WatcherService;
    yield* installWatcher(botThread.id, "api");
    const gaps: Array<number> = [];
    for (let wake = 0; wake < 10; wake += 1) {
      yield* watchers.runDue;
      const now = yield* Clock.currentTimeMillis;
      const nextWakeAt = (yield* watchers.list(botThread.id))[0]!.nextWakeAt!;
      gaps.push((nextWakeAt - now) / MINUTE);
      yield* TestClock.adjust(nextWakeAt - now);
    }
    assert.deepStrictEqual(gaps, [15, 30, 60, 120, 240, 480, 960, 1440, 1440, 1440]);
    assert.strictEqual(orchestration.sent.length, 10);
  }).pipe(provideWatchers(orchestration, runner.layer));
});

it.effect("resends an unconfirmed wake under the same key after a restart", () => {
  const orchestration = makeOrchestration();
  const botThread = orchestration.addThread("thread:bot", { botConfig: bot });
  const runner = makeScriptedRunner();
  runner.state.result = { code: ExitCode(1), stdout: "down", timedOut: false };
  return Effect.gen(function* () {
    const watchers = yield* WatcherService.WatcherService;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* installWatcher(botThread.id, "api");
    yield* watchers.runDue;
    // A crash after the send but before the save leaves the failure marked pending.
    const statePath = path.join(directory, "state.json");
    const saved = JSON.parse(yield* fileSystem.readFileString(statePath));
    saved.failing.pending = true;
    yield* fileSystem.writeFileString(statePath, JSON.stringify(saved));
    yield* TestClock.adjust(EVERY_MS);
    yield* watchers.runDue;
    const [first, second] = orchestration.sent;
    // The Bot's idempotent command id is what turns the second send into a replay.
    assert.strictEqual(second?.commandId, first?.commandId);
  }).pipe(provideWatchers(orchestration, runner.layer));
});

it.effect("counts a timeout and a script that cannot start as tripped", () => {
  const orchestration = makeOrchestration();
  const botThread = orchestration.addThread("thread:bot", { botConfig: bot });
  const runner = makeScriptedRunner();
  return Effect.gen(function* () {
    const watchers = yield* WatcherService.WatcherService;
    yield* installWatcher(botThread.id, "slow");
    runner.state.result = { code: null, stdout: "", timedOut: true };
    yield* watchers.runDue;
    assert.include(orchestration.sent[0]?.text, "exit: timeout");

    runner.state.result = new ProcessRunner.ProcessSpawnError({
      command: "run",
      argumentCount: 0,
      cause: new Error("EACCES"),
    });
    yield* TestClock.adjust(EVERY_MS);
    yield* watchers.runDue;
    assert.include(orchestration.sent[1]?.text, "exit: spawn-error");
  }).pipe(provideWatchers(orchestration, runner.layer));
});

it.effect("keeps a wake the Bot could not receive pending, so the next run offers it again", () => {
  const orchestration = makeOrchestration();
  const botThread = orchestration.addThread("thread:bot", { botConfig: bot });
  const runner = makeScriptedRunner();
  runner.state.result = { code: ExitCode(1), stdout: "down", timedOut: false };
  return Effect.gen(function* () {
    const watchers = yield* WatcherService.WatcherService;
    yield* installWatcher(botThread.id, "api");
    botThread.settledOverride = "settled";
    yield* watchers.runDue;
    assert.strictEqual(orchestration.sent.length, 0);

    botThread.settledOverride = null;
    yield* TestClock.adjust(EVERY_MS);
    yield* watchers.runDue;
    assert.strictEqual(orchestration.sent.length, 1);
  }).pipe(provideWatchers(orchestration, runner.layer));
});

const plantSecret = () => {
  process.env.T3_WATCHER_TEST_SECRET = "hunter2";
};
const removeSecret = () => {
  delete process.env.T3_WATCHER_TEST_SECRET;
};

it.effect("runs the script in its own folder with a scrubbed environment and capped output", () => {
  const orchestration = makeOrchestration();
  const botThread = orchestration.addThread("thread:bot", { botConfig: bot });
  return Effect.gen(function* () {
    const watchers = yield* WatcherService.WatcherService;
    // Healthy only if the secret is gone, PATH survives, and cwd is the watcher's folder.
    yield* installWatcher(botThread.id, "probe", {
      run: '#!/bin/sh\necho "secret=${T3_WATCHER_TEST_SECRET:-none} path=${PATH:+set} cwd=$(basename "$(pwd)")"\n',
      expect: "^secret=none path=set cwd=probe$",
    });
    yield* installWatcher(botThread.id, "loud", {
      run: "#!/bin/sh\nhead -c 6000 /dev/zero | tr '\\0' x\necho oops >&2\nexit 3\n",
    });
    yield* Effect.sync(plantSecret);
    yield* watchers.runDue.pipe(Effect.ensuring(Effect.sync(removeSecret)));

    const statuses = Object.fromEntries(
      (yield* watchers.list(botThread.id)).map(({ name, status }) => [name, status]),
    );
    assert.deepStrictEqual(statuses, { loud: "tripped", probe: "healthy" });
    assert.strictEqual(orchestration.sent.length, 1);
    const text = orchestration.sent[0]!.text;
    assert.include(text, "exit: 3");
    assert.include(text, "oops");
    const xs = text.match(/x+/u)?.[0].length ?? 0;
    assert.isAbove(xs, 0);
    assert.isAtMost(xs, 4096);
  }).pipe(
    provideWatchers(orchestration, ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer))),
  );
});

it.effect("runs due watchers from the Scheduler", () => {
  const orchestration = makeOrchestration();
  const botThread = orchestration.addThread("thread:bot", { botConfig: bot });
  const runs = Effect.runSync(Queue.unbounded<void>());
  const layer = Layer.mock(ProcessRunner.ProcessRunner)({
    run: () =>
      Queue.offer(runs, undefined).pipe(
        Effect.as({
          stdout: "",
          stderr: "",
          code: ExitCode(0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        }),
      ),
  });
  return Effect.gen(function* () {
    const watchers = yield* WatcherService.WatcherService;
    yield* installWatcher(botThread.id, "api");
    yield* watchers.start();
    yield* Queue.take(runs);
    yield* TestClock.adjust(EVERY_MS);
    yield* Queue.take(runs);
  }).pipe(provideWatchers(orchestration, layer));
});
