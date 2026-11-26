import * as PlatformNodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  BOT_SECRET_GRANTS_MAX_PER_BOT,
  BotSecretGrantError,
  type BotSecretGrantSetInput,
  SecretProviderId,
  type SecretReference,
  ThreadId,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as PayloadSigner from "../auth/PayloadSigner.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as BotSecretGrantService from "./BotSecretGrantService.ts";
import * as BotService from "./BotService.ts";
import { makeOrchestration } from "./BotTestkit.ts";

const isGrantError = Schema.is(BotSecretGrantError);
const START = Date.UTC(2026, 10, 26, 12);
const bot = { enabled: true, muteChildren: false } as const;
const SECRET = "ghp_PLANTED_secret_value_0123456789";
const GITHUB = ["api.github.com"];

const layerBase = () =>
  ServerSecretStore.layer.pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-grants-test-" })),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, PlatformNodeCrypto.layer)),
  );

const stored = (secret: string): BotSecretGrantSetInput["value"] => ({
  type: "stored",
  secret: Redacted.make(secret),
});
const reference = (text: string): SecretReference => ({
  provider: SecretProviderId.make("op"),
  reference: text,
});

/** One server's worth of files that outlives each start of the service, as a restart does. */
const makeHarness = Effect.gen(function* () {
  const orchestration = makeOrchestration();
  const botThread = orchestration.addThread("thread:bot", { botConfig: bot });
  const otherBot = orchestration.addThread("thread:other-bot", { botConfig: bot });
  const plainThread = orchestration.addThread("thread:plain");
  const base = yield* Layer.build(layerBase());
  const { stateDir } = Context.get(base, ServerConfig.ServerConfig);
  const path = Context.get(base, Path.Path);
  const fileSystem = Context.get(base, FileSystem.FileSystem);
  const signer = yield* PayloadSigner.make("bot-secret-grants-key").pipe(
    Effect.provideContext(base),
  );
  const provided = new Map<string, string | undefined>();
  /** While set, a provider read says it has started and then waits to be let go. */
  const slowRead: {
    current: { started: Deferred.Deferred<void>; release: Deferred.Deferred<void> } | undefined;
  } = {
    current: undefined,
  };
  /** While true, the secret store refuses every grant's stored value. */
  const failValues = { current: false };
  const resolver = Layer.succeed(
    SecretResolver.SecretResolver,
    SecretResolver.SecretResolver.of({
      read: (references) =>
        Effect.gen(function* () {
          const gate = slowRead.current;
          if (gate !== undefined) {
            yield* Deferred.succeed(gate.started, undefined);
            yield* Deferred.await(gate.release);
          }
          return references.map((ref) => provided.get(ref.reference));
        }),
      invalidate: () => Effect.void,
      label: (provider) => Effect.succeed(provider),
    }),
  );
  const bootOver = (secretStore: ServerSecretStore.ServerSecretStore["Service"]) =>
    Layer.build(
      BotSecretGrantService.layer.pipe(
        Layer.provideMerge(BotService.layer),
        Layer.provideMerge(orchestration.layer),
        Layer.provideMerge(ServerSettings.ServerSettingsService.layerTest()),
        Layer.provideMerge(resolver),
        Layer.provideMerge(
          Layer.succeedContext(Context.add(base, ServerSecretStore.ServerSecretStore, secretStore)),
        ),
      ),
    ).pipe(Effect.map((context) => Effect.provideContext(context)));
  const realStore = Context.get(base, ServerSecretStore.ServerSecretStore);
  const refusing = (name: string) =>
    failValues.current && name.startsWith("bot-grant-")
      ? Effect.fail(
          new ServerSecretStore.SecretStoreReadError({
            resource: `secret ${name}`,
            cause: "refused",
          }),
        )
      : undefined;
  const storeOf: ServerSecretStore.ServerSecretStore["Service"] = {
    ...realStore,
    get: (name) => refusing(name) ?? realStore.get(name),
    set: (name, value) => refusing(name) ?? realStore.set(name, value),
  };
  const grantsFile = path.join(stateDir, "bot-secret-grants.json");
  const storedValue = (name: string) =>
    realStore
      .get(name)
      .pipe(Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes))), Effect.orDie);
  return {
    botThread,
    otherBot,
    plainThread,
    provided,
    slowRead,
    failValues,
    /** Makes the next save fail: its temporary file is a folder. */
    breakWrites: fileSystem.makeDirectory(`${grantsFile}.tmp`).pipe(Effect.orDie),
    mendWrites: fileSystem.remove(`${grantsFile}.tmp`, { recursive: true }).pipe(Effect.orDie),
    storeOf,
    stateDir,
    grantsFile,
    /** Starts the service over the same files and secrets. */
    boot: bootOver(storeOf),
    /** Starts it over a secret store that cannot say what the newest saved version is. */
    bootWithoutVersion: bootOver({
      ...storeOf,
      get: (name) =>
        name === "bot-secret-grants-version"
          ? Effect.fail(new ServerSecretStore.SecretStoreConcurrentReadError({ resource: name }))
          : storeOf.get(name),
    }),
    storedValue,
    sign: signer.sign,
    read: fileSystem.readFileString(grantsFile).pipe(Effect.orDie),
    write: (text: string) => fileSystem.writeFileString(grantsFile, text).pipe(Effect.orDie),
    rejectedFiles: fileSystem.readDirectory(stateDir).pipe(
      Effect.map((names) =>
        names.filter((name) => name.startsWith("bot-secret-grants.json.rejected.")),
      ),
      Effect.orDie,
    ),
  };
});

const grant = (
  service: BotSecretGrantService.BotSecretGrantService["Service"],
  botThreadId: ThreadId,
  name: string,
  value: BotSecretGrantSetInput["value"] = stored(SECRET),
  hosts: ReadonlyArray<string> = GITHUB,
) => service.set({ botThreadId, name, hosts, value });

const withService = <A, E>(
  body: (
    harness: Effect.Success<typeof makeHarness>,
    service: BotSecretGrantService.BotSecretGrantService["Service"],
  ) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* TestClock.setTime(START);
    const run = yield* harness.boot;
    const service = yield* BotSecretGrantService.BotSecretGrantService.pipe(run);
    return yield* body(harness, service);
  });

const tamper = (text: string) =>
  JSON.stringify({
    ...(JSON.parse(text) as object),
    data: (JSON.parse(text) as { data: string }).data.replace("api.github.com", "evil.example.com"),
  });

it.effect(
  "gives the value to a run only for hosts the grant covers, and says why not otherwise",
  () =>
    withService((harness, service) =>
      Effect.gen(function* () {
        const bot = harness.botThread.id;
        yield* grant(service, bot, "GITHUB_TOKEN", stored(SECRET), [
          "api.github.com",
          "uploads.github.com",
        ]);

        const ok = yield* service.resolve({
          botThreadId: bot,
          name: "GITHUB_TOKEN",
          hosts: ["api.github.com"],
        });
        assert.strictEqual(ok._tag, "Ok");
        if (ok._tag === "Ok") assert.strictEqual(Redacted.value(ok.value), SECRET);

        assert.deepStrictEqual(
          yield* service.resolve({
            botThreadId: bot,
            name: "GITHUB_TOKEN",
            hosts: ["api.github.com", "uploads.github.com"],
          }),
          yield* service.resolve({
            botThreadId: bot,
            name: "GITHUB_TOKEN",
            hosts: ["uploads.github.com", "api.github.com"],
          }),
        );
        assert.deepStrictEqual(
          yield* service.resolve({
            botThreadId: bot,
            name: "GITHUB_TOKEN",
            hosts: ["evil.example.com"],
          }),
          { _tag: "Missing", reason: "host not covered" },
        );
        assert.deepStrictEqual(
          yield* service.resolve({
            botThreadId: bot,
            name: "GITHUB_TOKEN",
            hosts: ["api.github.com", "evil.example.com"],
          }),
          { _tag: "Missing", reason: "host not covered" },
        );
        assert.deepStrictEqual(
          yield* service.resolve({ botThreadId: bot, name: "GITHUB_TOKEN", hosts: [] }),
          { _tag: "Missing", reason: "host not covered" },
        );
        assert.deepStrictEqual(
          yield* service.resolve({ botThreadId: bot, name: "OTHER_TOKEN", hosts: GITHUB }),
          { _tag: "Missing", reason: "not granted" },
        );
      }),
    ),
);

it.effect("keeps one Bot's grants from another Bot", () =>
  withService((harness, service) =>
    Effect.gen(function* () {
      yield* grant(service, harness.botThread.id, "GITHUB_TOKEN");
      assert.deepStrictEqual(
        yield* service.resolve({
          botThreadId: harness.otherBot.id,
          name: "GITHUB_TOKEN",
          hosts: GITHUB,
        }),
        { _tag: "Missing", reason: "not granted" },
      );
      assert.deepStrictEqual((yield* service.list(harness.otherBot.id)).grants, []);
    }),
  ),
);

it.effect("reads a reference from the provider at each use, and keeps no stored copy of it", () =>
  withService((harness, service) =>
    Effect.gen(function* () {
      const bot = harness.botThread.id;
      harness.provided.set("op://vault/item/field", "first");
      yield* grant(service, bot, "OP_TOKEN", {
        type: "reference",
        reference: reference("op://vault/item/field"),
      });
      assert.deepStrictEqual(
        (yield* service.list(bot)).grants.map(({ name, source }) => ({ name, source })),
        [{ name: "OP_TOKEN", source: "reference" }],
      );
      assert.isTrue(
        Option.isNone(yield* harness.storedValue("bot-grant-thread-thread~3abot-OP_TOKEN")),
      );

      const read = () => service.resolve({ botThreadId: bot, name: "OP_TOKEN", hosts: GITHUB });
      const first = yield* read();
      assert.strictEqual(first._tag === "Ok" ? Redacted.value(first.value) : undefined, "first");
      harness.provided.set("op://vault/item/field", "rotated");
      const second = yield* read();
      assert.strictEqual(
        second._tag === "Ok" ? Redacted.value(second.value) : undefined,
        "rotated",
      );

      for (const unreadable of [undefined, "", "   "]) {
        harness.provided.set("op://vault/item/field", unreadable);
        assert.deepStrictEqual(yield* read(), { _tag: "Missing", reason: "unreadable" });
      }
    }),
  ),
);

it.effect("keeps a stored value in the secret store under a name that names its Bot", () =>
  withService((harness, service) =>
    Effect.gen(function* () {
      yield* grant(service, harness.botThread.id, "GITHUB_TOKEN");
      assert.deepStrictEqual(
        yield* harness.storedValue("bot-grant-thread-thread~3abot-GITHUB_TOKEN"),
        Option.some(SECRET),
      );
      const file = yield* harness.read;
      assert.notInclude(file, SECRET);
    }),
  ),
);

it.effect("stamps when a value was last read, only when given out, and at most hourly", () =>
  withService((harness, service) =>
    Effect.gen(function* () {
      const bot = harness.botThread.id;
      yield* grant(service, bot, "GITHUB_TOKEN");
      const lastUsed = () =>
        service.list(bot).pipe(Effect.map(({ grants }) => grants[0]?.lastUsedAt));
      const use = () => service.resolve({ botThreadId: bot, name: "GITHUB_TOKEN", hosts: GITHUB });
      assert.isUndefined(yield* lastUsed());

      yield* service.resolve({
        botThreadId: bot,
        name: "GITHUB_TOKEN",
        hosts: ["evil.example.com"],
      });
      assert.isUndefined(yield* lastUsed());

      yield* TestClock.adjust("5 minutes");
      yield* use();
      assert.strictEqual(yield* lastUsed(), "2026-11-26T12:05:00.000Z");

      // A poll every minute must not rewrite the signed file and its version each time.
      const saved = yield* harness.read;
      yield* TestClock.adjust("30 minutes");
      assert.strictEqual((yield* use())._tag, "Ok");
      assert.strictEqual(yield* lastUsed(), "2026-11-26T12:05:00.000Z");
      assert.strictEqual(yield* harness.read, saved);

      yield* TestClock.adjust("31 minutes");
      yield* use();
      assert.strictEqual(yield* lastUsed(), "2026-11-26T13:06:00.000Z");
    }),
  ),
);

it.effect(
  "does not give out a value for a grant that was removed or replaced during the read",
  () =>
    withService((harness, service) =>
      Effect.gen(function* () {
        const bot = harness.botThread.id;
        harness.provided.set("op://v/i/f", "from the provider");
        yield* grant(service, bot, "OP_TOKEN", {
          type: "reference",
          reference: reference("op://v/i/f"),
        });
        const resolving = (name: string) =>
          service.resolve({ botThreadId: bot, name, hosts: GITHUB });

        for (const change of ["replace", "remove"] as const) {
          const started = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          harness.slowRead.current = { started, release };
          const pending = yield* Effect.forkChild(resolving("OP_TOKEN"));
          yield* Deferred.await(started);
          // The slow read holds no lock, so the user's change is not kept waiting behind it.
          yield* change === "remove"
            ? service.remove({ botThreadId: bot, name: "OP_TOKEN" })
            : grant(service, bot, "OP_TOKEN", {
                type: "reference",
                reference: reference("op://v/i/f"),
              });
          harness.slowRead.current = undefined;
          yield* Deferred.succeed(release, undefined);
          assert.deepStrictEqual(yield* Fiber.join(pending), {
            _tag: "Missing",
            reason: "not granted",
          });
        }
        assert.isUndefined((yield* service.list(bot)).grants[0]?.lastUsedAt);
      }),
    ),
);

it.effect("replaces the hosts and the value when a name is given again", () =>
  withService((harness, service) =>
    Effect.gen(function* () {
      const bot = harness.botThread.id;
      const storedName = "bot-grant-thread-thread~3abot-GITHUB_TOKEN";
      yield* grant(service, bot, "GITHUB_TOKEN");
      yield* grant(service, bot, "GITHUB_TOKEN", stored("second"), ["uploads.github.com"]);
      assert.deepStrictEqual(yield* harness.storedValue(storedName), Option.some("second"));
      assert.deepStrictEqual((yield* service.list(bot)).grants, [
        { name: "GITHUB_TOKEN", hosts: ["uploads.github.com"], source: "stored" },
      ]);
      assert.strictEqual(
        (yield* service.resolve({ botThreadId: bot, name: "GITHUB_TOKEN", hosts: GITHUB }))._tag,
        "Missing",
      );

      harness.provided.set("op://v/i/f", "from the provider");
      yield* grant(service, bot, "GITHUB_TOKEN", {
        type: "reference",
        reference: reference("op://v/i/f"),
      });
      assert.isTrue(Option.isNone(yield* harness.storedValue(storedName)));
      assert.deepStrictEqual(
        (yield* service.list(bot)).grants.map(({ source }) => source),
        ["reference"],
      );
    }),
  ),
);

it.effect("keeps the old value and hosts when a replacement cannot be saved", () =>
  withService((harness, service) =>
    Effect.gen(function* () {
      const bot = harness.botThread.id;
      const storedName = "bot-grant-thread-thread~3abot-GITHUB_TOKEN";
      yield* grant(service, bot, "GITHUB_TOKEN", stored("first"));

      yield* harness.breakWrites;
      const failed = yield* grant(service, bot, "GITHUB_TOKEN", stored("second"), [
        "uploads.github.com",
      ]).pipe(Effect.flip);
      assert.strictEqual(failed.reason, "io");
      assert.deepStrictEqual(yield* harness.storedValue(storedName), Option.some("first"));
      assert.deepStrictEqual(
        (yield* service.list(bot)).grants.map(({ hosts }) => hosts),
        [GITHUB],
      );

      // A grant that never existed leaves nothing behind.
      assert.strictEqual((yield* grant(service, bot, "NEW_TOKEN").pipe(Effect.flip)).reason, "io");
      assert.isTrue(
        Option.isNone(yield* harness.storedValue("bot-grant-thread-thread~3abot-NEW_TOKEN")),
      );

      yield* harness.mendWrites;
      const ok = yield* service.resolve({ botThreadId: bot, name: "GITHUB_TOKEN", hosts: GITHUB });
      assert.strictEqual(ok._tag === "Ok" ? Redacted.value(ok.value) : undefined, "first");
    }),
  ),
);

it.effect("removes the grant and its stored value, and says when there was none", () =>
  withService((harness, service) =>
    Effect.gen(function* () {
      const bot = harness.botThread.id;
      yield* grant(service, bot, "GITHUB_TOKEN");
      yield* service.remove({ botThreadId: bot, name: "GITHUB_TOKEN" });
      assert.deepStrictEqual((yield* service.list(bot)).grants, []);
      assert.isTrue(
        Option.isNone(yield* harness.storedValue("bot-grant-thread-thread~3abot-GITHUB_TOKEN")),
      );
      assert.deepStrictEqual(
        yield* service.resolve({ botThreadId: bot, name: "GITHUB_TOKEN", hosts: GITHUB }),
        { _tag: "Missing", reason: "not granted" },
      );
      const missing = yield* service
        .remove({ botThreadId: bot, name: "GITHUB_TOKEN" })
        .pipe(Effect.flip);
      assert.strictEqual(missing.reason, "not_found");
    }),
  ),
);

it.effect("holds at most 24 grants per Bot, but a name already held can still change", () =>
  withService((harness, service) =>
    Effect.gen(function* () {
      const bot = harness.botThread.id;
      for (let index = 0; index < BOT_SECRET_GRANTS_MAX_PER_BOT; index += 1) {
        yield* grant(service, bot, `TOKEN_${index}`);
      }
      const refused = yield* grant(service, bot, "ONE_TOO_MANY").pipe(Effect.flip);
      assert.strictEqual(refused.reason, "limit");
      assert.isTrue(
        Option.isNone(yield* harness.storedValue("bot-grant-thread-thread~3abot-ONE_TOO_MANY")),
      );
      yield* grant(service, bot, "TOKEN_3", stored("changed"));
      yield* grant(service, harness.otherBot.id, "ONE_TOO_MANY");
      assert.strictEqual((yield* service.list(bot)).grants.length, BOT_SECRET_GRANTS_MAX_PER_BOT);
    }),
  ),
);

it.effect("refuses an empty value and a thread that is not a Bot", () =>
  withService((harness, service) =>
    Effect.gen(function* () {
      const empty = yield* grant(service, harness.botThread.id, "GITHUB_TOKEN", stored("")).pipe(
        Effect.flip,
      );
      assert.strictEqual(empty.reason, "invalid");
      const blank = yield* grant(
        service,
        harness.botThread.id,
        "GITHUB_TOKEN",
        stored("  \n"),
      ).pipe(Effect.flip);
      assert.strictEqual(blank.reason, "invalid");
      const plain = yield* grant(service, harness.plainThread.id, "GITHUB_TOKEN").pipe(Effect.flip);
      assert.strictEqual(plain.reason, "not_a_bot");
      assert.deepStrictEqual((yield* service.list(harness.botThread.id)).grants, []);
    }),
  ),
);

it.effect("keeps its grants, their stored values and the time of use across a restart", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    yield* TestClock.setTime(START);
    const first = yield* harness.boot;
    const bot = harness.botThread.id;
    yield* Effect.gen(function* () {
      const service = yield* BotSecretGrantService.BotSecretGrantService;
      yield* grant(service, bot, "GITHUB_TOKEN");
      yield* service.resolve({ botThreadId: bot, name: "GITHUB_TOKEN", hosts: GITHUB });
    }).pipe(first);

    const second = yield* harness.boot;
    yield* Effect.gen(function* () {
      const service = yield* BotSecretGrantService.BotSecretGrantService;
      const listed = yield* service.list(bot);
      assert.strictEqual(listed.approvals, "ok");
      assert.deepStrictEqual(listed.grants, [
        {
          name: "GITHUB_TOKEN",
          hosts: GITHUB,
          source: "stored",
          lastUsedAt: "2026-11-26T12:00:00.000Z",
        },
      ]);
      const ok = yield* service.resolve({ botThreadId: bot, name: "GITHUB_TOKEN", hosts: GITHUB });
      assert.strictEqual(ok._tag === "Ok" ? Redacted.value(ok.value) : undefined, SECRET);
    }).pipe(second);
  }),
);

it.effect.each(["tampered", "unsigned", "not json", "rolled back"] as const)(
  "starts with no grants from a %s file, keeps it aside, and keeps the stored values",
  (kind) =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* TestClock.setTime(START);
      const bot = harness.botThread.id;
      const first = yield* harness.boot;
      let older = "";
      yield* Effect.gen(function* () {
        const service = yield* BotSecretGrantService.BotSecretGrantService;
        yield* grant(service, bot, "GITHUB_TOKEN");
        older = yield* harness.read;
        yield* grant(service, bot, "SECOND_TOKEN");
      }).pipe(first);
      const newest = yield* harness.read;
      yield* harness.write(
        kind === "tampered"
          ? tamper(newest)
          : kind === "unsigned"
            ? JSON.stringify({ data: JSON.parse(newest).data, signature: "AAAA" })
            : kind === "not json"
              ? "{{{"
              : older,
      );

      yield* TestClock.adjust("1 second");
      const second = yield* harness.boot;
      yield* Effect.gen(function* () {
        const service = yield* BotSecretGrantService.BotSecretGrantService;
        const listed = yield* service.list(bot);
        assert.deepStrictEqual(listed, { grants: [], approvals: "unverified" });
        assert.deepStrictEqual(
          yield* service.resolve({ botThreadId: bot, name: "GITHUB_TOKEN", hosts: GITHUB }),
          { _tag: "Missing", reason: "not granted" },
        );
        // The values stay for the user to grant again, and that grant works.
        assert.deepStrictEqual(
          yield* harness.storedValue("bot-grant-thread-thread~3abot-GITHUB_TOKEN"),
          Option.some(SECRET),
        );
        // The first save writes a good signed file, so the warning does not outlive the cause.
        yield* grant(service, bot, "GITHUB_TOKEN");
        const after = yield* service.list(bot);
        assert.strictEqual(after.grants.length, 1);
        assert.strictEqual(after.approvals, "ok");
      }).pipe(second);

      const rejected = yield* harness.rejectedFiles;
      assert.deepStrictEqual(rejected, [`bot-secret-grants.json.rejected.${START + 1000}`]);
    }),
);

it.effect(
  "starts from nothing, in memory only, when the file or secrets cannot be read, and leaves the file alone",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* TestClock.setTime(START);
      const bot = harness.botThread.id;
      const first = yield* harness.boot;
      yield* Effect.gen(function* () {
        yield* grant(yield* BotSecretGrantService.BotSecretGrantService, bot, "GITHUB_TOKEN");
      }).pipe(first);
      const before = yield* harness.read;

      const degraded = yield* harness.bootWithoutVersion;
      yield* Effect.gen(function* () {
        const service = yield* BotSecretGrantService.BotSecretGrantService;
        assert.deepStrictEqual(yield* service.list(bot), { grants: [], approvals: "ok" });
        yield* grant(service, bot, "SECOND_TOKEN");
        assert.strictEqual((yield* service.list(bot)).grants.length, 1);
      }).pipe(degraded);

      assert.strictEqual(yield* harness.read, before);
      assert.deepStrictEqual(yield* harness.rejectedFiles, []);
    }),
);

it.effect("never lets a value or a reference into a list, an error or a log line", () =>
  Effect.gen(function* () {
    const lines: Array<string> = [];
    const logger = Logger.layer(
      [Logger.make((entry) => lines.push(Logger.formatLogFmt.log(entry)))],
      { mergeWithExisting: false },
    );
    const harness = yield* makeHarness;
    yield* TestClock.setTime(START);
    const bot = harness.botThread.id;
    const run = yield* harness.boot;
    const seen: Array<unknown> = [];
    const REFERENCE = "op://v/i/f";
    yield* Effect.gen(function* () {
      const service = yield* BotSecretGrantService.BotSecretGrantService;
      seen.push(yield* grant(service, bot, "GITHUB_TOKEN"));
      seen.push(yield* grant(service, bot, "GITHUB_TOKEN", stored(SECRET), ["uploads.github.com"]));
      harness.provided.set(REFERENCE, SECRET);
      seen.push(
        yield* grant(service, bot, "OP_TOKEN", {
          type: "reference",
          reference: reference(REFERENCE),
        }),
      );
      seen.push(yield* service.list(bot));
      seen.push(
        yield* service.resolve({
          botThreadId: bot,
          name: "GITHUB_TOKEN",
          hosts: ["uploads.github.com"],
        }),
      );
      seen.push(yield* service.resolve({ botThreadId: bot, name: "OP_TOKEN", hosts: GITHUB }));
      harness.provided.set(REFERENCE, undefined);
      seen.push(yield* service.resolve({ botThreadId: bot, name: "OP_TOKEN", hosts: GITHUB }));
      seen.push(yield* service.resolve({ botThreadId: bot, name: "NOPE", hosts: GITHUB }));
      seen.push(
        yield* grant(service, harness.plainThread.id, "GITHUB_TOKEN", stored(SECRET)).pipe(
          Effect.flip,
        ),
      );
      seen.push(yield* service.remove({ botThreadId: bot, name: "NOPE" }).pipe(Effect.flip));

      // A secret store that refuses: the save fails with an error, a read logs a warning.
      harness.failValues.current = true;
      seen.push(yield* grant(service, bot, "GITHUB_TOKEN", stored(SECRET)).pipe(Effect.flip));
      seen.push(yield* grant(service, bot, "NEW_TOKEN", stored(SECRET)).pipe(Effect.flip));
      seen.push(
        yield* service.resolve({
          botThreadId: bot,
          name: "GITHUB_TOKEN",
          hosts: ["uploads.github.com"],
        }),
      );
      harness.failValues.current = false;

      // A save that fails after the value was written.
      yield* harness.breakWrites;
      seen.push(
        yield* grant(service, bot, "GITHUB_TOKEN", stored(SECRET), ["uploads.github.com"]).pipe(
          Effect.flip,
        ),
      );
      harness.provided.set(REFERENCE, SECRET);
      seen.push(yield* service.resolve({ botThreadId: bot, name: "OP_TOKEN", hosts: GITHUB }));
      yield* harness.mendWrites;
      seen.push(yield* service.remove({ botThreadId: bot, name: "GITHUB_TOKEN" }));
    }).pipe(run, Effect.provide(logger));

    const outputs = seen.map((value) =>
      isGrantError(value)
        ? `${value.message}${JSON.stringify(value)}`
        : (JSON.stringify(value) ?? ""),
    );
    assert.isAbove(lines.length, 0);
    assert.isTrue(seen.some(isGrantError));
    // The resolves that give a value out hold it only as a redacted wrapper.
    for (const text of [...outputs, ...lines]) {
      assert.notInclude(text, SECRET);
      assert.notInclude(text, REFERENCE);
    }
    // The file is where a reference is kept, so only the value must be absent from it.
    assert.notInclude(yield* harness.read, SECRET);
  }),
);
