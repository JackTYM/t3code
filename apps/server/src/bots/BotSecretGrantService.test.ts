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
import * as Effect from "effect/Effect";
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
  const resolver = Layer.succeed(
    SecretResolver.SecretResolver,
    SecretResolver.SecretResolver.of({
      read: (references) => Effect.succeed(references.map((ref) => provided.get(ref.reference))),
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
  const storeOf = Context.get(base, ServerSecretStore.ServerSecretStore);
  const grantsFile = path.join(stateDir, "bot-secret-grants.json");
  const storedValue = (name: string) =>
    storeOf
      .get(name)
      .pipe(Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes))), Effect.orDie);
  return {
    botThread,
    otherBot,
    plainThread,
    provided,
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

it.effect("reads a reference when it is used, so the value is never kept", () =>
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

it.effect("stamps when a value was last read, and only when it was given out", () =>
  withService((harness, service) =>
    Effect.gen(function* () {
      const bot = harness.botThread.id;
      yield* grant(service, bot, "GITHUB_TOKEN");
      const lastUsed = () =>
        service.list(bot).pipe(Effect.map(({ grants }) => grants[0]?.lastUsedAt));
      assert.isUndefined(yield* lastUsed());

      yield* service.resolve({
        botThreadId: bot,
        name: "GITHUB_TOKEN",
        hosts: ["evil.example.com"],
      });
      assert.isUndefined(yield* lastUsed());

      yield* TestClock.adjust("5 minutes");
      yield* service.resolve({ botThreadId: bot, name: "GITHUB_TOKEN", hosts: GITHUB });
      assert.strictEqual(yield* lastUsed(), "2026-11-26T12:05:00.000Z");
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
        yield* grant(service, bot, "GITHUB_TOKEN");
        assert.strictEqual((yield* service.list(bot)).grants.length, 1);
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

it.effect("never lets a value into a list, an error or a log line", () =>
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
    yield* Effect.gen(function* () {
      const service = yield* BotSecretGrantService.BotSecretGrantService;
      seen.push(yield* grant(service, bot, "GITHUB_TOKEN"));
      seen.push(yield* grant(service, bot, "GITHUB_TOKEN", stored(SECRET), ["uploads.github.com"]));
      harness.provided.set("op://v/i/f", SECRET);
      seen.push(
        yield* grant(service, bot, "OP_TOKEN", {
          type: "reference",
          reference: reference("op://v/i/f"),
        }),
      );
      seen.push(yield* service.list(bot));
      seen.push(yield* service.resolve({ botThreadId: bot, name: "GITHUB_TOKEN", hosts: GITHUB }));
      seen.push(yield* service.resolve({ botThreadId: bot, name: "OP_TOKEN", hosts: GITHUB }));
      harness.provided.set("op://v/i/f", undefined);
      seen.push(yield* service.resolve({ botThreadId: bot, name: "OP_TOKEN", hosts: GITHUB }));
      seen.push(yield* service.resolve({ botThreadId: bot, name: "NOPE", hosts: GITHUB }));
      seen.push(
        yield* grant(service, harness.plainThread.id, "GITHUB_TOKEN", stored(SECRET)).pipe(
          Effect.flip,
        ),
      );
      seen.push(yield* service.remove({ botThreadId: bot, name: "NOPE" }).pipe(Effect.flip));
      seen.push(yield* service.remove({ botThreadId: bot, name: "GITHUB_TOKEN" }));
    }).pipe(run, Effect.provide(logger));

    const outputs = seen.map((value) =>
      isGrantError(value)
        ? `${value.message}${JSON.stringify(value)}`
        : (JSON.stringify(value) ?? ""),
    );
    // The resolve that does give the value out is the only output that may hold it, and only as a redacted wrapper.
    for (const text of [...outputs, ...lines, yield* harness.read]) {
      assert.notInclude(text, SECRET);
    }
    assert.isAbove(lines.length + outputs.length, 0);
  }),
);
