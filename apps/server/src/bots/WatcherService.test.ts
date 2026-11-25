import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, type ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ExitCode } from "effect/process/ChildProcessSpawner";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
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
const userMessage = { id: "message:user", createdBy: "user" } as const;

type Scripted = Pick<ProcessRunner.ProcessRunOutput, "code" | "stdout" | "timedOut">;

/**
 * A ProcessRunner that answers with whatever the test last set, counting and recording its runs.
 * Dry runs, which every approval now needs first, are recorded apart so run counts stay about
 * the scheduled runs.
 */
const makeScriptedRunner = () => {
  const state: {
    result: Scripted | ProcessRunner.ProcessRunError;
    runs: number;
    inputs: Array<ProcessRunner.ProcessRunInput>;
    dryInputs: Array<ProcessRunner.ProcessRunInput>;
    /** Runs while the script would be running, for a test that acts mid-run. */
    onRun: (input: ProcessRunner.ProcessRunInput) => Effect.Effect<void>;
  } = {
    result: { code: ExitCode(0), stdout: "", timedOut: false },
    runs: 0,
    inputs: [],
    dryInputs: [],
    onRun: () => Effect.void,
  };
  const layer = Layer.mock(ProcessRunner.ProcessRunner)({
    run: (input) => {
      if (input.env?.T3_WATCHER_DRY_RUN === "1") state.dryInputs.push(input);
      else {
        state.runs += 1;
        state.inputs.push(input);
      }
      const { result } = state;
      return state.onRun(input).pipe(
        Effect.andThen(
          "_tag" in result
            ? Effect.fail(result)
            : Effect.succeed({
                ...result,
                stderr: "",
                stdoutTruncated: false,
                stderrTruncated: false,
                stdoutInvalidUtf8: false,
                stderrInvalidUtf8: false,
              }),
        ),
      );
    },
  });
  return { state, layer };
};

/** What survives a restart: the server's config and secrets. */
const layerBase = () =>
  ServerSecretStore.layer.pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-watchers-test-" })),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

const layerWatchers = (
  orchestration: ReturnType<typeof makeOrchestration>,
  runner: Layer.Layer<ProcessRunner.ProcessRunner>,
) =>
  WatcherService.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(runner, Scheduler.layer)),
    Layer.provideMerge(BotService.layer),
    Layer.provideMerge(orchestration.layer),
    Layer.provideMerge(ServerSettings.ServerSettingsService.layerTest()),
  );

const provideWatchers = (
  orchestration: ReturnType<typeof makeOrchestration>,
  runner: Layer.Layer<ProcessRunner.ProcessRunner>,
) => Effect.provide(layerWatchers(orchestration, runner).pipe(Layer.provideMerge(layerBase())));

/** A Bot whose active turn began with the user typing, the only kind that may change watchers. */
const addBot = (orchestration: ReturnType<typeof makeOrchestration>, id: string) => {
  const thread = orchestration.addThread(id, { botConfig: bot });
  orchestration.startRun(thread, userMessage);
  return thread;
};

const SHELL_FAILS = "#!/bin/sh\nexit 1\n";

const proposeWatcher = (
  threadId: ThreadId,
  name: string,
  options: {
    readonly run?: string;
    readonly expect?: string;
    readonly runtime?: "node" | "sh";
    readonly intervalSeconds?: number;
  } = {},
) =>
  Effect.gen(function* () {
    const watchers = yield* WatcherService.WatcherService;
    return yield* watchers.propose({
      botThreadId: threadId,
      name,
      runtime: options.runtime ?? "sh",
      source: options.run ?? SHELL_FAILS,
      intervalSeconds: options.intervalSeconds ?? EVERY_MS / 1000,
      expect: options.expect,
    });
  });

/** Proposes a watcher and, unless told not to, dry-runs and approves that exact version as the user. */
const installWatcher = Effect.fn("installWatcher")(function* (
  threadId: ThreadId,
  name: string,
  options: {
    readonly run?: string;
    readonly expect?: string;
    readonly runtime?: "node" | "sh";
    readonly approve?: boolean;
  } = {},
) {
  const watchers = yield* WatcherService.WatcherService;
  const { hash } = yield* proposeWatcher(threadId, name, options);
  if (options.approve !== false) {
    yield* watchers.dryRun({ botThreadId: threadId, name, hash });
    yield* watchers.approve({
      botThreadId: threadId,
      name,
      hash,
      runsOn: "local",
      approvedBy: "owner",
    });
  }
  return hash;
});

/** Where the Bot's files for one version live, as the Bot's own tools would see them. */
const versionDirectory = Effect.fn("versionDirectory")(function* (
  threadId: ThreadId,
  name: string,
  hash: string,
) {
  const path = yield* Path.Path;
  const { baseDir } = yield* ServerConfig.ServerConfig;
  return path.join(baseDir, "bots", BotService.memoryFolderName(threadId), "watchers", name, hash);
});

const statuses = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const watchers = yield* WatcherService.WatcherService;
    return (yield* watchers.list(threadId)).watchers.map(({ name, status }) => [name, status]);
  });

it.effect(
  "runs a watcher only as the approved version, and a change stops it until approved",
  () => {
    const orchestration = makeOrchestration();
    const botThread = addBot(orchestration, "thread:bot");
    const plain = orchestration.addThread("thread:plain");
    const runner = makeScriptedRunner();
    runner.state.result = { code: ExitCode(1), stdout: "", timedOut: false };
    return Effect.gen(function* () {
      const watchers = yield* WatcherService.WatcherService;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const approvedHash = yield* installWatcher(botThread.id, "disk");
      yield* installWatcher(botThread.id, "unapproved", { approve: false });
      // Only a live Bot proposes watchers, so a plain thread has none to run.
      const refused = yield* proposeWatcher(plain.id, "ignored").pipe(Effect.flip);
      assert.strictEqual(refused.reason, "not_a_bot");

      yield* watchers.runDue;
      assert.strictEqual(runner.state.runs, 1);
      assert.deepStrictEqual(yield* statuses(botThread.id), [
        ["disk", "tripped"],
        ["unapproved", "needs_approval"],
      ]);

      // A changed proposal does not replace the approved version: both stop until the user decides.
      const proposed = yield* proposeWatcher(botThread.id, "disk", { run: "#!/bin/sh\nexit 0\n" });
      assert.notStrictEqual(proposed.hash, approvedHash);
      yield* TestClock.adjust(EVERY_MS);
      yield* watchers.runDue;
      assert.strictEqual(runner.state.runs, 1);
      const listed = (yield* watchers.list(botThread.id)).watchers.find(
        ({ name }) => name === "disk",
      );
      assert.strictEqual(listed?.status, "needs_approval");
      assert.strictEqual(listed?.approvedHash, approvedHash);
      assert.strictEqual(listed?.pendingHash, proposed.hash);

      // Rejecting the proposal resumes the version the user approved before.
      yield* watchers.reject({ botThreadId: botThread.id, name: "disk" });
      yield* TestClock.adjust(EVERY_MS);
      yield* watchers.runDue;
      assert.strictEqual(runner.state.runs, 2);
      assert.strictEqual((yield* statuses(botThread.id))[0]?.[1], "tripped");
      assert.isFalse(
        yield* fileSystem.exists(yield* versionDirectory(botThread.id, "disk", proposed.hash)),
      );

      // Bytes on disk that no longer hash to the approved version do not run either.
      const stored = yield* versionDirectory(botThread.id, "disk", approvedHash);
      yield* fileSystem.writeFileString(path.join(stored, "run"), "#!/bin/sh\nexit 0\n");
      yield* TestClock.adjust(EVERY_MS);
      yield* watchers.runDue;
      assert.strictEqual(runner.state.runs, 2);
      assert.strictEqual((yield* statuses(botThread.id))[0]?.[1], "invalid");
    }).pipe(provideWatchers(orchestration, runner.layer));
  },
);

it.effect("keeps approvals where the Bot's own folder cannot change them", () => {
  const orchestration = makeOrchestration();
  const botThread = addBot(orchestration, "thread:bot");
  const runner = makeScriptedRunner();
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { baseDir, stateDir } = yield* ServerConfig.ServerConfig;
    const hash = yield* installWatcher(botThread.id, "disk");
    const approvals = yield* fileSystem.readFileString(
      path.join(stateDir, "watcher-approvals.json"),
    );
    assert.include(approvals, hash);
    // Nothing the Bot's folder holds names an approval: a file it writes there approves nothing.
    const botFolder = path.join(baseDir, "bots", BotService.memoryFolderName(botThread.id));
    const files = yield* fileSystem.readDirectory(botFolder, { recursive: true });
    for (const file of files.filter((entry) => entry.endsWith("watcher.json"))) {
      assert.notInclude(yield* fileSystem.readFileString(path.join(botFolder, file)), "approved");
    }
  }).pipe(provideWatchers(orchestration, runner.layer));
});

it.effect("runs the exact bytes that were hashed, from a private copy", () => {
  const orchestration = makeOrchestration();
  const botThread = addBot(orchestration, "thread:bot");
  const runner = makeScriptedRunner();
  const source = "#!/bin/sh\necho approved\n";
  const seen: { executed?: string; before?: string; after?: string } = {};
  return Effect.gen(function* () {
    const watchers = yield* WatcherService.WatcherService;
    const path = yield* Path.Path;
    const hash = yield* installWatcher(botThread.id, "disk", { run: source });
    const stored = path.join(yield* versionDirectory(botThread.id, "disk", hash), "run");
    runner.state.onRun = (input) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        seen.executed = input.args[0]!;
        seen.before = yield* fileSystem.readFileString(input.args[0]!);
        // Someone rewrites the stored file while the script is running.
        yield* fileSystem.writeFileString(stored, "#!/bin/sh\necho swapped\n");
        seen.after = yield* fileSystem.readFileString(input.args[0]!);
      }).pipe(Effect.orDie, Effect.provide(NodeServices.layer));

    yield* watchers.runDue;
    const input = runner.state.inputs[0]!;
    assert.strictEqual(seen.before, source);
    assert.strictEqual(seen.after, source);
    assert.notStrictEqual(seen.executed, stored);
    assert.strictEqual(path.dirname(seen.executed!), input.cwd);
    assert.strictEqual(input.command, "sh");
    assert.isFalse(input.inheritEnv);
    assert.strictEqual(input.stdin, "");
    // The edit is caught on the next look, so the swapped file never runs.
    yield* TestClock.adjust(EVERY_MS);
    yield* watchers.runDue;
    assert.strictEqual(runner.state.runs, 1);
  }).pipe(provideWatchers(orchestration, runner.layer));
});

it.effect("refuses to create or remove watchers in a turn the user did not start", () => {
  const orchestration = makeOrchestration();
  const botThread = addBot(orchestration, "thread:bot");
  const runner = makeScriptedRunner();
  return Effect.gen(function* () {
    const watchers = yield* WatcherService.WatcherService;
    yield* installWatcher(botThread.id, "disk");
    const injected = [
      { id: "bot-wake:watcher:disk:1", createdBy: "system" },
      // A client chooses its own message ids, so an id alone proves nothing either way.
      { id: "bot-wake:forged", createdBy: "user" },
      { id: "message:agent", createdBy: "agent" },
      { id: "message:cron", createdBy: "user", scheduledTaskId: "task:morning" },
    ] as const;
    for (const message of injected) {
      orchestration.startRun(botThread, message);
      const proposing = yield* proposeWatcher(botThread.id, "more").pipe(Effect.flip);
      const removing = yield* watchers
        .remove({ botThreadId: botThread.id, name: "disk" })
        .pipe(Effect.flip);
      assert.strictEqual(proposing.reason, "started_by_wake");
      assert.strictEqual(removing.reason, "started_by_wake");
    }
    // A turn that cannot be traced to a message fails closed too.
    botThread.activeRunId = null;
    assert.strictEqual(
      (yield* proposeWatcher(botThread.id, "more").pipe(Effect.flip)).reason,
      "started_by_wake",
    );
    assert.deepStrictEqual(yield* statuses(botThread.id), [["disk", "healthy"]]);

    // The same Bot, in a turn the user started, may.
    orchestration.startRun(botThread, userMessage);
    yield* proposeWatcher(botThread.id, "more");
    yield* watchers.remove({ botThreadId: botThread.id, name: "disk" });
    assert.deepStrictEqual(yield* statuses(botThread.id), [["more", "needs_approval"]]);
  }).pipe(provideWatchers(orchestration, runner.layer));
});

it.effect("approves only the version that is still pending, and shows what changed", () => {
  const orchestration = makeOrchestration();
  const botThread = addBot(orchestration, "thread:bot");
  const runner = makeScriptedRunner();
  runner.state.result = { code: ExitCode(1), stdout: "boom", timedOut: false };
  const approve = (hash: string) =>
    Effect.gen(function* () {
      const watchers = yield* WatcherService.WatcherService;
      return yield* watchers.approve({
        botThreadId: botThread.id,
        name: "disk",
        hash,
        runsOn: "local",
        approvedBy: "owner",
      });
    });
  return Effect.gen(function* () {
    const watchers = yield* WatcherService.WatcherService;
    const first = yield* proposeWatcher(botThread.id, "disk", { run: "echo one\n" });
    // Nothing runs until approval, and a dry run of what is shown does not wake the Bot.
    const dry = yield* watchers.dryRun({
      botThreadId: botThread.id,
      name: "disk",
      hash: first.hash,
    });
    assert.deepStrictEqual(
      [dry.exit, dry.stdout, dry.healthy, dry.hash],
      ["1", "boom", false, first.hash],
    );
    assert.strictEqual(runner.state.dryInputs[0]?.env?.T3_WATCHER_DRY_RUN, "1");
    assert.strictEqual(runner.state.runs, 0);
    assert.strictEqual(orchestration.sent.length, 0);
    assert.strictEqual(
      (yield* watchers.list(botThread.id)).watchers[0]?.lastDryRun?.stdout,
      "boom",
    );

    // The Bot revises it before the user decides: what the user saw is no longer approvable.
    const second = yield* proposeWatcher(botThread.id, "disk", { run: "echo two\n" });
    assert.strictEqual((yield* approve(first.hash).pipe(Effect.flip)).reason, "stale_hash");
    const staleDry = yield* watchers
      .dryRun({ botThreadId: botThread.id, name: "disk", hash: first.hash })
      .pipe(Effect.flip);
    assert.strictEqual(staleDry.reason, "stale_hash");
    // The new version has not been dry-run: the old result is not carried over.
    assert.isUndefined((yield* watchers.list(botThread.id)).watchers[0]?.lastDryRun);

    // A dry run of the version the user saw says nothing about this one: the server wants its own.
    assert.strictEqual((yield* approve(second.hash).pipe(Effect.flip)).reason, "dry_run_required");
    yield* watchers.dryRun({ botThreadId: botThread.id, name: "disk", hash: second.hash });
    yield* approve(second.hash);
    assert.strictEqual((yield* approve(second.hash).pipe(Effect.flip)).reason, "no_pending");
    const approved = (yield* watchers.list(botThread.id)).watchers[0]!;
    assert.strictEqual(approved.approvedHash, second.hash);
    assert.isUndefined(approved.pendingHash);
    assert.deepStrictEqual(
      approved.history.map(({ hash, approvedBy }) => [hash, approvedBy]),
      [
        [first.hash, undefined],
        [second.hash, "owner"],
      ],
    );

    // A later proposal comes with a diff against what the user approved.
    const third = yield* proposeWatcher(botThread.id, "disk", { run: "echo three\n" });
    const pending = (yield* watchers.list(botThread.id)).watchers[0]!;
    assert.strictEqual(pending.hash, third.hash);
    assert.include(pending.diff, "-echo two");
    assert.include(pending.diff, "+echo three");
    assert.strictEqual(pending.source, "echo three\n");
  }).pipe(provideWatchers(orchestration, runner.layer));
});

it.effect("turns away proposals that break the limits", () => {
  const orchestration = makeOrchestration();
  const botThread = addBot(orchestration, "thread:bot");
  const runner = makeScriptedRunner();
  return Effect.gen(function* () {
    const refusal = (name: string, options: Parameters<typeof proposeWatcher>[2] = {}) =>
      proposeWatcher(botThread.id, name, options).pipe(
        Effect.flip,
        Effect.map(({ reason }) => reason),
      );
    assert.strictEqual(yield* refusal("../escape"), "invalid");
    assert.strictEqual(yield* refusal("x".repeat(65)), "invalid");
    assert.strictEqual(yield* refusal("ok", { run: "" }), "invalid");
    assert.strictEqual(yield* refusal("ok", { run: "x".repeat(64 * 1024 + 1) }), "invalid");
    assert.strictEqual(yield* refusal("ok", { intervalSeconds: 59 }), "invalid");
    assert.strictEqual(yield* refusal("ok", { expect: "(" }), "invalid");
    yield* proposeWatcher(botThread.id, "ok", { run: "x".repeat(64 * 1024) });
    // Names that are also properties of every object are still just names.
    yield* proposeWatcher(botThread.id, "constructor");
    for (let index = 2; index < 20; index += 1) yield* proposeWatcher(botThread.id, `w${index}`);
    assert.strictEqual(yield* refusal("one-too-many"), "invalid");
    assert.strictEqual((yield* statuses(botThread.id)).length, 20);
  }).pipe(provideWatchers(orchestration, runner.layer));
});

it.effect("runs a watcher only where the user approved it to run", () => {
  const orchestration = makeOrchestration();
  const botThread = addBot(orchestration, "thread:bot");
  const runner = makeScriptedRunner();
  return Effect.gen(function* () {
    const watchers = yield* WatcherService.WatcherService;
    const { hash } = yield* proposeWatcher(botThread.id, "disk");
    yield* watchers.dryRun({ botThreadId: botThread.id, name: "disk", hash });
    yield* watchers.approve({
      botThreadId: botThread.id,
      name: "disk",
      hash,
      runsOn: EnvironmentId.make("env:laptop"),
      approvedBy: "owner",
    });
    yield* watchers.runDue;
    assert.strictEqual(runner.state.runs, 0);
    assert.deepStrictEqual(yield* statuses(botThread.id), [["disk", "elsewhere"]]);

    yield* watchers.setRunsOn({ botThreadId: botThread.id, name: "disk", runsOn: "local" });
    yield* watchers.runDue;
    assert.strictEqual(runner.state.runs, 1);
  }).pipe(provideWatchers(orchestration, runner.layer));
});

it.effect("wakes once per failure, backs off while it persists, and clears on recovery", () => {
  const orchestration = makeOrchestration();
  const botThread = addBot(orchestration, "thread:bot");
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
    assert.strictEqual((yield* watchers.list(botThread.id)).watchers[0]?.status, "healthy");
    trip("disk 95%");
    yield* poll(EVERY_MS);
    assert.strictEqual(wakes(), 5);

    const commandIds = orchestration.sent.map((message) => message.commandId);
    assert.strictEqual(new Set(commandIds).size, commandIds.length);
  }).pipe(provideWatchers(orchestration, runner.layer));
});

it.effect("doubles the backoff from 15 minutes to a 24 hour ceiling", () => {
  const orchestration = makeOrchestration();
  const botThread = addBot(orchestration, "thread:bot");
  const runner = makeScriptedRunner();
  runner.state.result = { code: ExitCode(2), stdout: "down", timedOut: false };
  return Effect.gen(function* () {
    const watchers = yield* WatcherService.WatcherService;
    yield* installWatcher(botThread.id, "api");
    const gaps: Array<number> = [];
    for (let wake = 0; wake < 10; wake += 1) {
      yield* watchers.runDue;
      const now = yield* Clock.currentTimeMillis;
      const nextWakeAt = (yield* watchers.list(botThread.id)).watchers[0]!.nextWakeAt!;
      gaps.push((nextWakeAt - now) / MINUTE);
      yield* TestClock.adjust(nextWakeAt - now);
    }
    assert.deepStrictEqual(gaps, [15, 30, 60, 120, 240, 480, 960, 1440, 1440, 1440]);
    assert.strictEqual(orchestration.sent.length, 10);
  }).pipe(provideWatchers(orchestration, runner.layer));
});

it.effect("resends an unconfirmed wake under the same key after a restart", () => {
  const orchestration = makeOrchestration();
  const botThread = addBot(orchestration, "thread:bot");
  const runner = makeScriptedRunner();
  runner.state.result = { code: ExitCode(1), stdout: "down", timedOut: false };
  return Effect.gen(function* () {
    const watchers = yield* WatcherService.WatcherService;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const hash = yield* installWatcher(botThread.id, "api");
    yield* watchers.runDue;
    // A crash after the send but before the save leaves the failure marked pending.
    const directory = path.dirname(yield* versionDirectory(botThread.id, "api", hash));
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
  const botThread = addBot(orchestration, "thread:bot");
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
  const botThread = addBot(orchestration, "thread:bot");
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
  const botThread = addBot(orchestration, "thread:bot");
  return Effect.gen(function* () {
    const watchers = yield* WatcherService.WatcherService;
    // Healthy only if the secret is gone, PATH survives, stdin is already closed, and the script
    // runs in a scratch folder rather than the Bot's.
    yield* installWatcher(botThread.id, "probe", {
      run: '#!/bin/sh\nif read -r _line; then stdin=data; else stdin=eof; fi\necho "secret=${T3_WATCHER_TEST_SECRET:-none} path=${PATH:+set} stdin=$stdin cwd=$(basename "$(pwd)" | cut -c1-10)"\n',
      expect: "^secret=none path=set stdin=eof cwd=t3-watcher$",
    });
    // The scratch folder and the copy of the script are private to the server's user.
    yield* installWatcher(botThread.id, "private", {
      runtime: "node",
      run: 'const fs = require("node:fs");\nconst mode = (target) => (fs.statSync(target).mode & 0o777).toString(8);\nconsole.log(`cwd=${mode(process.cwd())} run=${mode(__filename)} secret=${process.env.T3_WATCHER_TEST_SECRET ?? "none"}`);\n',
      expect: "^cwd=700 run=700 secret=none$",
    });
    yield* installWatcher(botThread.id, "loud", {
      run: "#!/bin/sh\nhead -c 6000 /dev/zero | tr '\\0' x\necho oops >&2\nexit 3\n",
    });
    yield* Effect.sync(plantSecret);
    yield* watchers.runDue.pipe(Effect.ensuring(Effect.sync(removeSecret)));

    const byName = Object.fromEntries(
      (yield* watchers.list(botThread.id)).watchers.map(({ name, status }) => [name, status]),
    );
    assert.deepStrictEqual(byName, { loud: "tripped", private: "healthy", probe: "healthy" });
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
  const botThread = addBot(orchestration, "thread:bot");
  const runner = makeScriptedRunner();
  return Effect.gen(function* () {
    const runs = yield* Queue.unbounded<void>();
    const watchers = yield* WatcherService.WatcherService;
    yield* installWatcher(botThread.id, "api");
    runner.state.onRun = () => Queue.offer(runs, undefined).pipe(Effect.asVoid);
    yield* watchers.start();
    yield* Queue.take(runs);
    yield* TestClock.adjust(EVERY_MS);
    yield* Queue.take(runs);
  }).pipe(provideWatchers(orchestration, runner.layer));
});

it.effect("approves only a version whose own dry run completed, whatever that run found", () => {
  const orchestration = makeOrchestration();
  const botThread = addBot(orchestration, "thread:bot");
  const runner = makeScriptedRunner();
  // A watcher that trips right now is still approvable: the user decides after seeing it run.
  runner.state.result = { code: ExitCode(1), stdout: "disk 99%", timedOut: false };
  return Effect.gen(function* () {
    const watchers = yield* WatcherService.WatcherService;
    const approve = (hash: string) =>
      watchers
        .approve({
          botThreadId: botThread.id,
          name: "disk",
          hash,
          runsOn: "local",
          approvedBy: "owner",
        })
        .pipe(Effect.flip);
    const first = yield* proposeWatcher(botThread.id, "disk", { run: "echo one\n" });
    assert.strictEqual((yield* approve(first.hash)).reason, "dry_run_required");
    assert.strictEqual(runner.state.runs + runner.state.dryInputs.length, 0);

    yield* watchers.dryRun({ botThreadId: botThread.id, name: "disk", hash: first.hash });
    yield* watchers.approve({
      botThreadId: botThread.id,
      name: "disk",
      hash: first.hash,
      runsOn: "local",
      approvedBy: "owner",
    });

    // A changed version starts over, even though an older one was dry-run and approved.
    const second = yield* proposeWatcher(botThread.id, "disk", { run: "echo two\n" });
    assert.strictEqual((yield* approve(second.hash)).reason, "dry_run_required");
  }).pipe(provideWatchers(orchestration, runner.layer));
});

it.effect("lets the user pause, resume and remove a watcher whatever woke the Bot", () => {
  const orchestration = makeOrchestration();
  const botThread = addBot(orchestration, "thread:bot");
  const runner = makeScriptedRunner();
  runner.state.result = { code: ExitCode(1), stdout: "down", timedOut: false };
  return Effect.gen(function* () {
    const watchers = yield* WatcherService.WatcherService;
    const target = { botThreadId: botThread.id, name: "api" };
    const hash = yield* installWatcher(botThread.id, "api");
    // The Bot is mid-way through a turn a wake started, which refuses it every change of its own.
    orchestration.startRun(botThread, { id: "bot-wake:watcher:api:1", createdBy: "system" });

    yield* watchers.pause(target);
    const paused = (yield* watchers.list(botThread.id)).watchers[0]!;
    assert.deepStrictEqual(
      [paused.status, paused.paused, paused.approvedHash],
      ["paused", true, hash],
    );
    yield* TestClock.adjust(EVERY_MS);
    yield* watchers.runDue;
    assert.strictEqual(runner.state.runs, 0);

    // A newer version needs approval as usual, and approving it does not undo the user's pause.
    const next = yield* proposeWatcher(botThread.id, "api", { run: "#!/bin/sh\nexit 2\n" }).pipe(
      Effect.flip,
    );
    assert.strictEqual(next.reason, "started_by_wake");
    orchestration.startRun(botThread, userMessage);
    const proposed = yield* proposeWatcher(botThread.id, "api", { run: "#!/bin/sh\nexit 2\n" });
    yield* watchers.dryRun({ ...target, hash: proposed.hash });
    yield* watchers.approve({
      ...target,
      hash: proposed.hash,
      runsOn: "local",
      approvedBy: "owner",
    });
    yield* watchers.runDue;
    assert.strictEqual(runner.state.runs, 0);
    assert.strictEqual((yield* watchers.list(botThread.id)).watchers[0]?.paused, true);

    yield* watchers.resume(target);
    yield* watchers.runDue;
    assert.strictEqual(runner.state.runs, 1);
    assert.strictEqual((yield* watchers.list(botThread.id)).watchers[0]?.paused, false);

    // The Bot itself cannot remove it in such a turn, but the user can.
    orchestration.startRun(botThread, { id: "bot-wake:watcher:api:2", createdBy: "system" });
    assert.strictEqual(
      (yield* watchers.remove(target).pipe(Effect.flip)).reason,
      "started_by_wake",
    );
    yield* watchers.removeByUser(target);
    assert.deepStrictEqual(yield* statuses(botThread.id), []);
    assert.strictEqual((yield* watchers.pause(target).pipe(Effect.flip)).reason, "not_found");
    assert.strictEqual(
      (yield* watchers.removeByUser(target).pipe(Effect.flip)).reason,
      "not_found",
    );
  }).pipe(provideWatchers(orchestration, runner.layer));
});

/** Starts the service again over the same config and secrets, as a server restart does. */
const makeRestarts = (
  orchestration: ReturnType<typeof makeOrchestration>,
  runner: ReturnType<typeof makeScriptedRunner>,
) =>
  Effect.gen(function* () {
    const base = yield* Layer.build(layerBase());
    const { stateDir } = Context.get(base, ServerConfig.ServerConfig);
    const approvalsFile = (yield* Path.Path).join(stateDir, "watcher-approvals.json");
    return {
      approvalsFile,
      boot: Layer.build(
        layerWatchers(orchestration, runner.layer).pipe(
          Layer.provideMerge(Layer.succeedContext(base)),
        ),
      ).pipe(Effect.map((context) => Effect.provideContext(context))),
    };
  });

it.effect("keeps approvals across a restart while their signature holds", () => {
  const orchestration = makeOrchestration();
  const botThread = addBot(orchestration, "thread:bot");
  const runner = makeScriptedRunner();
  return Effect.gen(function* () {
    const { boot } = yield* makeRestarts(orchestration, runner);
    const first = yield* boot;
    yield* installWatcher(botThread.id, "disk").pipe(first);

    const second = yield* boot;
    yield* Effect.gen(function* () {
      const watchers = yield* WatcherService.WatcherService;
      const listed = yield* watchers.list(botThread.id);
      assert.strictEqual(listed.approvals, "ok");
      assert.deepStrictEqual(
        listed.watchers.map(({ status }) => status),
        ["healthy"],
      );
      yield* watchers.runDue;
      assert.strictEqual(runner.state.runs, 1);
    }).pipe(second);
  }).pipe(Effect.provide(NodeServices.layer));
});

it.effect.each([
  [
    "a field edited by hand",
    (saved: { approvals: Record<string, Record<string, Record<string, unknown>>> }) => {
      // Approves a version nobody approved, keeping the signature of the real file.
      for (const records of Object.values(saved.approvals)) {
        for (const record of Object.values(records)) {
          record.approvedHash = record.pendingHash;
          delete record.pendingHash;
        }
      }
      return saved;
    },
  ],
  [
    "a file with no signature",
    (saved: { approvals: Record<string, Record<string, Record<string, unknown>>> }) =>
      saved.approvals,
  ],
] as const)("runs nothing after a restart when the approvals file is %s", ([, tamper]) => {
  const orchestration = makeOrchestration();
  const botThread = addBot(orchestration, "thread:bot");
  const runner = makeScriptedRunner();
  return Effect.gen(function* () {
    const { boot, approvalsFile } = yield* makeRestarts(orchestration, runner);
    const fileSystem = yield* FileSystem.FileSystem;
    const first = yield* boot;
    // One approved watcher and one the user has not decided on.
    yield* Effect.gen(function* () {
      yield* installWatcher(botThread.id, "disk");
      yield* installWatcher(botThread.id, "waiting", {
        approve: false,
        run: "#!/bin/sh\nexit 4\n",
      });
    }).pipe(first);
    const saved = JSON.parse(yield* fileSystem.readFileString(approvalsFile));
    yield* fileSystem.writeFileString(approvalsFile, JSON.stringify(tamper(saved)));

    const second = yield* boot;
    yield* Effect.gen(function* () {
      const watchers = yield* WatcherService.WatcherService;
      const listed = yield* watchers.list(botThread.id);
      assert.strictEqual(listed.approvals, "unverified");
      assert.deepStrictEqual(listed.watchers, []);
      yield* watchers.runDue;
      assert.strictEqual(runner.state.runs, 0);

      // The user starts over, and what is saved from then on is signed again.
      yield* installWatcher(botThread.id, "disk");
    }).pipe(second);
    const third = yield* boot;
    yield* Effect.gen(function* () {
      const listed = yield* (yield* WatcherService.WatcherService).list(botThread.id);
      assert.strictEqual(listed.approvals, "ok");
      assert.deepStrictEqual(
        listed.watchers.map(({ name }) => name),
        ["disk"],
      );
    }).pipe(third);
  }).pipe(Effect.provide(NodeServices.layer));
});
