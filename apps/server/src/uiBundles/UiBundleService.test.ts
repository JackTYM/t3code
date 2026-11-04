// @effect-diagnostics nodeBuiltinImport:off - fixtures need a sha256 of the zip and no Effect equivalent exists.
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { UiBundleError, UiBundleManifest, UiBundleState } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import * as NodeCrypto from "node:crypto";

import { ServerConfig } from "../config.ts";
import { UiBundleFeed } from "./UiBundleFeed.ts";
import * as UiBundleService from "./UiBundleService.ts";
import * as UiBundleStore from "./UiBundleStore.ts";
import { buildZip } from "./testZip.ts";

const BUILTIN = {
  schema: 1,
  contractsHash: "hash-a",
  versionCore: "1.2.3",
  version: "1.2.3-fork.5",
  sha: "builtin-sha",
  repository: "owner/repo",
};

interface Published {
  readonly manifest: UiBundleManifest;
  readonly zip: Uint8Array;
}

const publish = (
  version: string,
  overrides: { readonly contractsHash?: string; readonly sha256?: string } = {},
): Published => {
  const contractsHash = overrides.contractsHash ?? BUILTIN.contractsHash;
  const zip = buildZip([
    { name: "index.html", data: `<html>${version}</html>` },
    { name: "ui-compat.json", data: JSON.stringify({ contractsHash, versionCore: "1.2.3" }) },
  ]);
  return {
    zip,
    manifest: {
      schema: 1,
      version,
      versionCore: "1.2.3",
      contractsHash,
      sha: "bundle-sha",
      sha256: overrides.sha256 ?? NodeCrypto.createHash("sha256").update(zip).digest("hex"),
      size: zip.length,
      assetName: "ui-bundle.zip",
    },
  };
};

// A fake release feed whose published bundle the test can swap between checks.
const makeFeed = (initial: Published | null) => {
  const feed = {
    release: initial,
    latestCalls: 0,
    downloads: 0,
    hold: null as {
      readonly started: Deferred.Deferred<void>;
      readonly gate: Deferred.Deferred<void>;
    } | null,
  };
  const layer = Layer.succeed(
    UiBundleFeed,
    UiBundleFeed.of({
      latest: () =>
        Effect.sync(() => {
          feed.latestCalls += 1;
          return feed.release
            ? { manifest: feed.release.manifest, zipUrl: "https://example.test/ui-bundle.zip" }
            : null;
        }),
      download: () =>
        Effect.gen(function* () {
          feed.downloads += 1;
          const zip = feed.release?.zip ?? new Uint8Array();
          if (feed.hold) {
            yield* Deferred.succeed(feed.hold.started, undefined);
            yield* Deferred.await(feed.hold.gate);
          }
          return zip;
        }),
    }),
  );
  return { feed, layer };
};

/** Makes the next downloads stay pending until `gate` is completed. */
const holdDownloads = (feed: ReturnType<typeof makeFeed>["feed"]) =>
  Effect.gen(function* () {
    const hold = { started: yield* Deferred.make<void>(), gate: yield* Deferred.make<void>() };
    feed.hold = hold;
    return hold;
  });

/** `compat: null` leaves the built-in client without a ui-compat.json. */
const makeEnvironment = (compat: Record<string, unknown> | null = BUILTIN) =>
  Layer.effect(
    ServerConfig,
    Effect.gen(function* () {
      const base = yield* ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const staticDir = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "ui-bundle-service-static-" }),
      );
      if (compat !== null) {
        yield* fs.writeFileString(path.join(staticDir, "ui-compat.json"), JSON.stringify(compat));
      }
      return ServerConfig.of({ ...base, staticDir });
    }),
  ).pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "ui-bundle-service-test-" })),
    Layer.provideMerge(NodeServices.layer),
  );

// Each call is one "server process": it sees the persisted store state but starts with no memory.
// `failWrites.current = true` makes every store write fail until it is set back.
const startServer = (
  feedLayer: Layer.Layer<UiBundleFeed>,
  failWrites: { current: boolean } = { current: false },
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const storeLayer: typeof UiBundleStore.layer = Layer.effect(
      UiBundleStore.UiBundleStore,
      Effect.gen(function* () {
        const real = yield* UiBundleStore.UiBundleStore;
        return UiBundleStore.UiBundleStore.of({
          ...real,
          write: (patch) =>
            failWrites.current
              ? Effect.fail(new UiBundleStore.UiBundleStoreError({ reason: "io" }))
              : real.write(patch),
        });
      }),
    ).pipe(Layer.provide(UiBundleStore.layer));
    const context = yield* Layer.build(
      UiBundleService.layer.pipe(Layer.provideMerge(storeLayer), Layer.provide(feedLayer)),
    );
    const store = Context.get(context, UiBundleStore.UiBundleStore);
    return {
      service: Context.get(context, UiBundleService.UiBundleService),
      store,
      bundleExists: (version: string) =>
        store.bundleDir(version).pipe(
          Effect.flatMap((dir) => fs.exists(dir)),
          Effect.orDie,
        ),
      stagingExists: (version: string) =>
        store.stagingDir(version).pipe(
          Effect.flatMap((dir) => fs.exists(dir)),
          Effect.orDie,
        ),
      removeBundle: (version: string) =>
        store.bundleDir(version).pipe(
          Effect.flatMap((dir) => fs.remove(dir, { recursive: true })),
          Effect.orDie,
        ),
      rewriteBundleCompat: (version: string, compat: Record<string, unknown>) =>
        store.bundleDir(version).pipe(
          Effect.flatMap((dir) =>
            fs.writeFileString(path.join(dir, "ui-compat.json"), JSON.stringify(compat)),
          ),
          Effect.orDie,
        ),
    };
  });

const withServer = <A, E>(
  options: {
    readonly compat?: Record<string, unknown> | null;
    readonly published?: Published | null;
  },
  body: (
    input: Effect.Success<ReturnType<typeof startServer>> & {
      readonly feed: ReturnType<typeof makeFeed>["feed"];
    },
  ) => Effect.Effect<A, E, never>,
) =>
  Effect.gen(function* () {
    const { feed, layer } = makeFeed(options.published ?? null);
    const server = yield* startServer(layer);
    return yield* body({ ...server, feed });
  }).pipe(
    Effect.scoped,
    Effect.provide(makeEnvironment(options.compat === undefined ? BUILTIN : options.compat)),
  );

// Lets the boot timer's revert, which runs under the service lock, finish before assertions.
// A confirmation for no bundle queues on that lock and changes nothing.
const settle = (service: UiBundleService.UiBundleService["Service"]) =>
  service.confirmBoot({ version: "no-such-version" });

// Longer than the 30 second minimum between check attempts.
const CHECK_THROTTLE = "31 seconds";
const V6 = "1.2.3-fork.6";
const V7 = "1.2.3-fork.7";

describe("UiBundleService", () => {
  describe("check", () => {
    it.effect("stages a newer compatible bundle as ready", () =>
      withServer({ published: publish(V6) }, ({ service, feed, bundleExists, stagingExists }) =>
        Effect.gen(function* () {
          const state = yield* service.check;
          assert.deepStrictEqual(state.ready?.version, V6);
          assert.isNull(state.incompatible);
          assert.isNull(state.lastError);
          assert.isNotNull(state.lastCheckedAt);
          assert.strictEqual(state.active, "builtin");
          assert.strictEqual(state.builtinVersion, BUILTIN.version);
          assert.strictEqual(feed.downloads, 1);
          assert.isTrue(yield* bundleExists(V6));
          assert.isFalse(yield* stagingExists(V6));
        }),
      ),
    );

    it.effect("records an incompatible bundle without downloading it", () =>
      withServer({ published: publish(V6, { contractsHash: "hash-b" }) }, ({ service, feed }) =>
        Effect.gen(function* () {
          const state = yield* service.check;
          assert.deepStrictEqual(state.incompatible, {
            version: V6,
            reason: "contracts-changed",
          });
          assert.isNull(state.ready);
          assert.strictEqual(feed.downloads, 0);
        }),
      ),
    );

    it.effect.each([
      { label: "the built-in version", version: BUILTIN.version },
      { label: "an older version", version: "1.2.3-fork.4" },
    ])("does nothing for $label", ({ version }) =>
      withServer({ published: publish(version) }, ({ service, feed }) =>
        Effect.gen(function* () {
          const state = yield* service.check;
          assert.isNull(state.ready);
          assert.isNull(state.incompatible);
          assert.isNull(state.lastError);
          assert.strictEqual(feed.downloads, 0);
        }),
      ),
    );

    it.effect("compares prerelease numbers numerically", () =>
      Effect.gen(function* () {
        const newer = yield* withServer(
          {
            compat: { ...BUILTIN, version: "1.2.3-fork.9" },
            published: publish("1.2.3-fork.10"),
          },
          ({ service }) => service.check,
        );
        assert.strictEqual(newer.ready?.version, "1.2.3-fork.10");

        const older = yield* withServer(
          {
            compat: { ...BUILTIN, version: "1.2.3-fork.10" },
            published: publish("1.2.3-fork.9"),
          },
          ({ service, feed }) =>
            service.check.pipe(Effect.map((state) => ({ state, downloads: feed.downloads }))),
        );
        assert.isNull(older.state.ready);
        assert.strictEqual(older.downloads, 0);
      }),
    );

    it.effect("does nothing when the feed has no bundle", () =>
      withServer({ published: null }, ({ service, feed }) =>
        Effect.gen(function* () {
          const state = yield* service.check;
          assert.isNull(state.ready);
          assert.strictEqual(feed.latestCalls, 1);
        }),
      ),
    );

    it.effect("fails and leaves nothing behind when the download fails its sha256", () =>
      withServer(
        { published: publish(V6, { sha256: "0".repeat(64) }) },
        ({ service, bundleExists, stagingExists }) =>
          Effect.gen(function* () {
            const error = yield* service.check.pipe(Effect.flip);
            assert.strictEqual(error.reason, "check-failed");
            const state = yield* service.state;
            assert.strictEqual(state.lastError, "The UI bundle failed its SHA-256 check.");
            assert.isNull(state.ready);
            assert.isFalse(yield* bundleExists(V6));
            assert.isFalse(yield* stagingExists(V6));
          }),
      ),
    );

    it.effect.each([
      { label: "no repository", compat: { ...BUILTIN, repository: "" } },
      { label: "no ui-compat.json", compat: null },
    ])("is disabled with $label", ({ compat }) =>
      withServer({ compat, published: publish(V6) }, ({ service, feed }) =>
        Effect.gen(function* () {
          const error = yield* service.check.pipe(Effect.flip);
          assert.strictEqual(error.reason, "disabled");
          assert.isFalse((yield* service.state).enabled);
          assert.strictEqual(feed.latestCalls, 0);
        }),
      ),
    );
  });

  describe("apply and boot confirmation", () => {
    it.effect("fails with nothing-ready when no bundle is staged", () =>
      withServer({ published: null }, ({ service }) =>
        Effect.gen(function* () {
          const error = yield* service.apply.pipe(Effect.flip);
          assert.strictEqual(error.reason, "nothing-ready");
        }),
      ),
    );

    it.effect("activates the bundle and serves its root while the boot is pending", () =>
      withServer({ published: publish(V6) }, ({ service, store }) =>
        Effect.gen(function* () {
          yield* service.check;
          const state = yield* service.apply;
          assert.strictEqual(state.active, V6);
          assert.isNull(state.previous);
          assert.isNull(state.ready);
          assert.isTrue(state.bootPending);
          assert.strictEqual(yield* service.activeRoot, yield* store.bundleDir(V6));
        }),
      ),
    );

    it.effect("keeps an unconfirmed bundle for 179 seconds and reverts it after 181", () =>
      withServer({ published: publish(V6) }, ({ service }) =>
        Effect.gen(function* () {
          yield* service.check;
          yield* service.apply;

          yield* TestClock.adjust("179 seconds");
          const early = yield* service.state;
          assert.strictEqual(early.active, V6);
          assert.isTrue(early.bootPending);

          yield* TestClock.adjust("2 seconds");
          yield* settle(service);
          const late = yield* service.state;
          assert.strictEqual(late.active, "builtin");
          assert.isFalse(late.bootPending);
          assert.strictEqual(late.lastError, "The new UI did not start; reverted.");
          assert.isNull(yield* service.activeRoot);
        }),
      ),
    );

    it.effect("keeps a confirmed bundle", () =>
      withServer({ published: publish(V6) }, ({ service }) =>
        Effect.gen(function* () {
          yield* service.check;
          yield* service.apply;
          yield* service.confirmBoot({ version: V6 });
          yield* TestClock.adjust("5 minutes");
          yield* settle(service);
          const state = yield* service.state;
          assert.strictEqual(state.active, V6);
          assert.isFalse(state.bootPending);
          assert.isNull(state.lastError);
        }),
      ),
    );

    it.effect("ignores a confirmation for a different version", () =>
      withServer({ published: publish(V6) }, ({ service }) =>
        Effect.gen(function* () {
          yield* service.check;
          yield* service.apply;
          yield* service.confirmBoot({ version: "9.9.9" });
          assert.isTrue((yield* service.state).bootPending);

          yield* TestClock.adjust("181 seconds");
          yield* settle(service);
          assert.strictEqual((yield* service.state).active, "builtin");
        }),
      ),
    );

    it.effect("reverts an unconfirmed bundle to the previous bundle, not the built-in one", () =>
      withServer({ published: publish(V6) }, ({ service, feed, bundleExists }) =>
        Effect.gen(function* () {
          yield* service.check;
          yield* service.apply;
          yield* service.confirmBoot({ version: V6 });

          feed.release = publish(V7);
          yield* TestClock.adjust(CHECK_THROTTLE);
          yield* service.check;
          const applied = yield* service.apply;
          assert.strictEqual(applied.previous, V6);

          yield* TestClock.adjust("181 seconds");
          yield* settle(service);
          const state = yield* service.state;
          assert.strictEqual(state.active, V6);
          assert.isTrue(yield* bundleExists(V6));
        }),
      ),
    );

    it.effect("reverts a bundle whose boot was never confirmed before a restart", () =>
      Effect.gen(function* () {
        const environment = yield* Layer.build(makeEnvironment());
        const first = makeFeed(publish(V6));
        yield* Effect.gen(function* () {
          const { service } = yield* startServer(first.layer);
          yield* service.check;
          yield* service.apply;
        }).pipe(Effect.scoped, Effect.provideContext(environment));

        const second = yield* Effect.gen(function* () {
          const { service } = yield* startServer(makeFeed(null).layer);
          return yield* service.state;
        }).pipe(Effect.scoped, Effect.provideContext(environment));
        assert.strictEqual(second.active, "builtin");
        assert.isFalse(second.bootPending);
        assert.strictEqual(second.lastError, "The new UI did not start; reverted.");
      }).pipe(Effect.scoped),
    );

    it.effect("keeps a confirmed bundle across a restart", () =>
      Effect.gen(function* () {
        const environment = yield* Layer.build(makeEnvironment());
        yield* Effect.gen(function* () {
          const { service } = yield* startServer(makeFeed(publish(V6)).layer);
          yield* service.check;
          yield* service.apply;
          yield* service.confirmBoot({ version: V6 });
        }).pipe(Effect.scoped, Effect.provideContext(environment));

        const state = yield* Effect.gen(function* () {
          const { service } = yield* startServer(makeFeed(null).layer);
          return yield* service.state;
        }).pipe(Effect.scoped, Effect.provideContext(environment));
        assert.strictEqual(state.active, V6);
        assert.isNull(state.lastError);
      }).pipe(Effect.scoped),
    );
  });

  describe("revert", () => {
    it.effect("returns to the built-in UI and stops the boot timer", () =>
      withServer({ published: publish(V6) }, ({ service }) =>
        Effect.gen(function* () {
          yield* service.check;
          yield* service.apply;
          const state = yield* service.revert;
          assert.strictEqual(state.active, "builtin");
          assert.isFalse(state.bootPending);

          yield* TestClock.adjust("181 seconds");
          yield* settle(service);
          assert.isNull((yield* service.state).lastError);
        }),
      ),
    );
  });

  describe("persisted state after a server update", () => {
    // Runs `body` as one server process on top of whatever earlier processes persisted.
    const inProcess = <A, E>(
      environment: Context.Context<ServerConfig | FileSystem.FileSystem | Path.Path>,
      published: Published | null,
      body: (input: Effect.Success<ReturnType<typeof startServer>>) => Effect.Effect<A, E>,
    ) =>
      Effect.gen(function* () {
        return yield* body(yield* startServer(makeFeed(published).layer));
      }).pipe(Effect.scoped, Effect.provideContext(environment));

    const writeBuiltin = (compat: Record<string, unknown>) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig;
        yield* fs.writeFileString(
          path.join(config.staticDir ?? "", "ui-compat.json"),
          JSON.stringify(compat),
        );
      });

    it.effect(
      "reverts an active bundle built for different contracts than the updated server",
      () =>
        Effect.gen(function* () {
          const environment = yield* Layer.build(makeEnvironment());
          yield* inProcess(environment, publish(V6), ({ service }) =>
            Effect.gen(function* () {
              yield* service.check;
              yield* service.apply;
              yield* service.confirmBoot({ version: V6 });
            }),
          );

          yield* writeBuiltin({ ...BUILTIN, contractsHash: "hash-b" }).pipe(
            Effect.provideContext(environment),
          );
          const { state, existed } = yield* inProcess(environment, null, (server) =>
            Effect.gen(function* () {
              return {
                state: yield* server.service.state,
                existed: yield* server.bundleExists(V6),
              };
            }),
          );
          assert.strictEqual(state.active, "builtin");
          assert.isNull(state.previous);
          assert.isFalse(state.bootPending);
          assert.strictEqual(
            state.lastError,
            "The server was updated; the downloaded UI was removed.",
          );
          assert.isFalse(existed);
        }).pipe(Effect.scoped),
    );

    it.effect("falls back to a still-valid previous bundle when the active one is stale", () =>
      Effect.gen(function* () {
        const environment = yield* Layer.build(makeEnvironment());
        yield* inProcess(environment, publish(V6), ({ service }) =>
          Effect.gen(function* () {
            yield* service.check;
            yield* service.apply;
            yield* service.confirmBoot({ version: V6 });
          }),
        );
        yield* inProcess(environment, publish(V7), ({ service, rewriteBundleCompat }) =>
          Effect.gen(function* () {
            yield* TestClock.adjust(CHECK_THROTTLE);
            yield* service.check;
            yield* service.apply;
            yield* service.confirmBoot({ version: V7 });
            yield* rewriteBundleCompat(V7, { contractsHash: "hash-z", versionCore: "1.2.3" });
          }),
        );

        const state = yield* inProcess(environment, null, ({ service }) => service.state);
        assert.strictEqual(state.active, V6);
        assert.isNull(state.previous);
      }).pipe(Effect.scoped),
    );

    it.effect("drops a staged bundle that is not newer than the updated built-in UI", () =>
      Effect.gen(function* () {
        const environment = yield* Layer.build(makeEnvironment());
        yield* inProcess(environment, publish(V6), ({ service }) => service.check);

        yield* writeBuiltin({ ...BUILTIN, version: "1.2.3-fork.9" }).pipe(
          Effect.provideContext(environment),
        );
        const { state, existed } = yield* inProcess(environment, null, (server) =>
          Effect.gen(function* () {
            return {
              state: yield* server.service.state,
              existed: yield* server.bundleExists(V6),
            };
          }),
        );
        assert.isNull(state.ready);
        assert.strictEqual(
          state.lastError,
          "The server was updated; the downloaded UI was removed.",
        );
        assert.isFalse(existed);
      }).pipe(Effect.scoped),
    );

    it.effect("clears an incompatible entry for a version the built-in UI has reached", () =>
      Effect.gen(function* () {
        const environment = yield* Layer.build(makeEnvironment());
        const recorded = yield* inProcess(
          environment,
          publish(V6, { contractsHash: "hash-b" }),
          ({ service }) => service.check,
        );
        assert.strictEqual(recorded.incompatible?.version, V6);

        yield* writeBuiltin({ ...BUILTIN, version: V6 }).pipe(Effect.provideContext(environment));
        const state = yield* inProcess(environment, null, ({ service }) => service.state);
        assert.isNull(state.incompatible);
        assert.isNull(state.lastError);
      }).pipe(Effect.scoped),
    );

    it.effect("keeps an incompatible entry that is still newer than the built-in UI", () =>
      Effect.gen(function* () {
        const environment = yield* Layer.build(makeEnvironment());
        yield* inProcess(
          environment,
          publish(V7, { contractsHash: "hash-b" }),
          ({ service }) => service.check,
        );
        yield* writeBuiltin({ ...BUILTIN, version: V6 }).pipe(Effect.provideContext(environment));
        const state = yield* inProcess(environment, null, ({ service }) => service.state);
        assert.strictEqual(state.incompatible?.version, V7);
      }).pipe(Effect.scoped),
    );

    it.effect("cleans up a pending boot flag left while the built-in UI is active", () =>
      Effect.gen(function* () {
        const environment = yield* Layer.build(makeEnvironment());
        yield* inProcess(environment, null, ({ store }) => store.write({ bootPendingSince: 1 }));

        const state = yield* inProcess(environment, null, ({ service }) => service.state);
        assert.strictEqual(state.active, "builtin");
        assert.isFalse(state.bootPending);
        assert.isNull(state.lastError);
      }).pipe(Effect.scoped),
    );

    it.effect("refuses to apply a staged bundle that is no longer compatible", () =>
      withServer({ published: publish(V6) }, ({ service, rewriteBundleCompat }) =>
        Effect.gen(function* () {
          yield* service.check;
          yield* rewriteBundleCompat(V6, { contractsHash: "hash-z", versionCore: "1.2.3" });
          const before = yield* service.state;

          const error = yield* service.apply.pipe(Effect.flip);
          assert.strictEqual(error.reason, "apply-failed");
          assert.deepStrictEqual(yield* service.state, before);
        }),
      ),
    );

    it.effect("refuses to apply a staged bundle whose directory was deleted", () =>
      withServer({ published: publish(V6) }, ({ service, removeBundle }) =>
        Effect.gen(function* () {
          yield* service.check;
          yield* removeBundle(V6);
          const before = yield* service.state;

          const error = yield* service.apply.pipe(Effect.flip);
          assert.strictEqual(error.reason, "apply-failed");
          assert.deepStrictEqual(yield* service.state, before);
        }),
      ),
    );
  });

  describe("locking", () => {
    // V6 is applied and waiting for confirmation while a download of V7 stays pending.
    const withPendingDownload = <A, E>(
      body: (
        input: Effect.Success<ReturnType<typeof startServer>> & {
          readonly feed: ReturnType<typeof makeFeed>["feed"];
          readonly release: Effect.Effect<void>;
          readonly check: Fiber.Fiber<UiBundleState, UiBundleError>;
        },
      ) => Effect.Effect<A, E>,
    ) =>
      withServer({ published: publish(V6) }, (server) =>
        Effect.gen(function* () {
          yield* server.service.check;
          yield* server.service.apply;
          server.feed.release = publish(V7);
          const hold = yield* holdDownloads(server.feed);
          yield* TestClock.adjust(CHECK_THROTTLE);
          const check = yield* Effect.forkChild(server.service.check);
          yield* Deferred.await(hold.started);
          return yield* body({
            ...server,
            release: Deferred.succeed(hold.gate, undefined).pipe(Effect.asVoid),
            check,
          });
        }).pipe(Effect.scoped),
      );

    it.effect("confirms a boot while a download is still pending", () =>
      withPendingDownload(({ service, release, check, bundleExists }) =>
        Effect.gen(function* () {
          yield* service.confirmBoot({ version: V6 });
          assert.isFalse((yield* service.state).bootPending);
          const error = yield* service.apply.pipe(Effect.flip);
          assert.strictEqual(error.reason, "nothing-ready");

          yield* release;
          yield* Fiber.join(check);
          const state = yield* service.state;
          assert.strictEqual(state.active, V6);
          assert.strictEqual(state.ready?.version, V7);
          assert.isTrue(yield* bundleExists(V6));
          assert.isTrue(yield* bundleExists(V7));
        }),
      ),
    );

    it.effect("reverts while a download is pending and still stages it afterwards", () =>
      withPendingDownload(({ service, release, check, bundleExists }) =>
        Effect.gen(function* () {
          const reverted = yield* service.revert;
          assert.strictEqual(reverted.active, "builtin");

          yield* release;
          yield* Fiber.join(check);
          const state = yield* service.state;
          assert.strictEqual(state.active, "builtin");
          assert.strictEqual(state.ready?.version, V7);
          assert.isFalse(yield* bundleExists(V6));
          assert.isTrue(yield* bundleExists(V7));
        }),
      ),
    );

    it.effect("applies a staged bundle while a newer download is pending", () =>
      Effect.gen(function* () {
        const { feed, layer } = makeFeed(publish(V6));
        const { service, bundleExists } = yield* startServer(layer);
        yield* service.check;
        feed.release = publish(V7);
        const hold = yield* holdDownloads(feed);
        yield* TestClock.adjust(CHECK_THROTTLE);
        const check = yield* Effect.forkChild(service.check);
        yield* Deferred.await(hold.started);

        const applied = yield* service.apply;
        assert.strictEqual(applied.active, V6);

        yield* Deferred.succeed(hold.gate, undefined);
        yield* Fiber.join(check);
        const state = yield* service.state;
        assert.strictEqual(state.active, V6);
        assert.strictEqual(state.ready?.version, V7);
        assert.isTrue(yield* bundleExists(V6));
        assert.isTrue(yield* bundleExists(V7));
      }).pipe(Effect.scoped, Effect.provide(makeEnvironment())),
    );

    it.effect(
      "makes an overlapping check wait for the running one instead of requesting again",
      () =>
        withPendingDownload(({ service, feed, release, check }) =>
          Effect.gen(function* () {
            const calls = feed.latestCalls;
            const overlapping = yield* Effect.forkChild(service.check);

            yield* release;
            yield* Fiber.join(check);
            const waited = yield* Fiber.join(overlapping);
            assert.strictEqual(feed.latestCalls, calls);
            assert.strictEqual(waited.ready?.version, V7);
          }),
        ),
    );
  });

  describe("check throttling", () => {
    it.effect("answers from the cached state for 30 seconds after a check", () =>
      withServer({ published: null }, ({ service, feed }) =>
        Effect.gen(function* () {
          yield* service.check;
          yield* TestClock.adjust("29 seconds");
          yield* service.check;
          assert.strictEqual(feed.latestCalls, 1);

          yield* TestClock.adjust("2 seconds");
          yield* service.check;
          assert.strictEqual(feed.latestCalls, 2);
        }),
      ),
    );

    it.effect("also throttles after a failed check", () =>
      withServer({ published: publish(V6, { sha256: "0".repeat(64) }) }, ({ service, feed }) =>
        Effect.gen(function* () {
          yield* service.check.pipe(Effect.flip);
          yield* service.check;
          assert.strictEqual(feed.downloads, 1);
          assert.strictEqual(
            (yield* service.state).lastError,
            "The UI bundle failed its SHA-256 check.",
          );
        }),
      ),
    );
  });

  describe("failed writes", () => {
    const withFailingWrites = <A, E>(
      body: (
        input: Effect.Success<ReturnType<typeof startServer>> & {
          readonly feed: ReturnType<typeof makeFeed>["feed"];
          readonly failWrites: { current: boolean };
        },
      ) => Effect.Effect<A, E>,
    ) =>
      Effect.gen(function* () {
        const { feed, layer } = makeFeed(publish(V6));
        const failWrites = { current: false };
        const server = yield* startServer(layer, failWrites);
        return yield* body({ ...server, feed, failWrites });
      }).pipe(Effect.scoped, Effect.provide(makeEnvironment()));

    it.effect("leaves the previous state and boot timer alone when an apply cannot be saved", () =>
      withFailingWrites(({ service, feed, failWrites }) =>
        Effect.gen(function* () {
          yield* service.check;
          yield* service.apply;
          feed.release = publish(V7);
          yield* TestClock.adjust(CHECK_THROTTLE);
          yield* service.check;

          failWrites.current = true;
          const error = yield* service.apply.pipe(Effect.flip);
          assert.strictEqual(error.reason, "apply-failed");
          failWrites.current = false;
          const unchanged = yield* service.state;
          assert.strictEqual(unchanged.active, V6);
          assert.strictEqual(unchanged.ready?.version, V7);

          // V6's own timer is still running, so it reverts when its window ends.
          yield* TestClock.adjust("150 seconds");
          yield* settle(service);
          const state = yield* service.state;
          assert.strictEqual(state.active, "builtin");
          assert.strictEqual(state.lastError, "The new UI did not start; reverted.");
        }),
      ),
    );

    it.effect("retries a timer revert that could not be saved and reports it only once saved", () =>
      withFailingWrites(({ service, failWrites }) =>
        Effect.gen(function* () {
          yield* service.check;
          yield* service.apply;

          failWrites.current = true;
          yield* TestClock.adjust("181 seconds");
          yield* settle(service);
          const stuck = yield* service.state;
          assert.strictEqual(stuck.active, V6);
          assert.isTrue(stuck.bootPending);
          assert.isNull(stuck.lastError);

          failWrites.current = false;
          yield* TestClock.adjust("30 seconds");
          yield* settle(service);
          const state = yield* service.state;
          assert.strictEqual(state.active, "builtin");
          assert.isFalse(state.bootPending);
          assert.strictEqual(state.lastError, "The new UI did not start; reverted.");
        }),
      ),
    );

    it.effect("keeps the boot timer when an explicit revert cannot be saved", () =>
      withFailingWrites(({ service, failWrites }) =>
        Effect.gen(function* () {
          yield* service.check;
          yield* service.apply;

          failWrites.current = true;
          const failed = yield* service.revert;
          assert.strictEqual(failed.active, V6);
          assert.strictEqual(failed.lastError, "Could not return to the built-in UI.");
          failWrites.current = false;

          yield* TestClock.adjust("181 seconds");
          yield* settle(service);
          assert.strictEqual((yield* service.state).active, "builtin");
        }),
      ),
    );

    it.effect("keeps the boot timer when a confirmation cannot be saved", () =>
      withFailingWrites(({ service, failWrites }) =>
        Effect.gen(function* () {
          yield* service.check;
          yield* service.apply;

          failWrites.current = true;
          yield* service.confirmBoot({ version: V6 });
          failWrites.current = false;
          assert.isTrue((yield* service.state).bootPending);

          yield* service.confirmBoot({ version: V6 });
          assert.isFalse((yield* service.state).bootPending);
          yield* TestClock.adjust("5 minutes");
          yield* settle(service);
          assert.strictEqual((yield* service.state).active, V6);
        }),
      ),
    );
  });

  describe("applying over an unconfirmed bundle", () => {
    it.effect("keeps the last confirmed bundle as the way back", () =>
      withServer({ published: publish(V6) }, ({ service, feed }) =>
        Effect.gen(function* () {
          yield* service.check;
          yield* service.apply;
          yield* service.confirmBoot({ version: V6 });

          feed.release = publish(V7);
          yield* TestClock.adjust(CHECK_THROTTLE);
          yield* service.check;
          yield* service.apply;

          feed.release = publish("1.2.3-fork.8");
          yield* TestClock.adjust(CHECK_THROTTLE);
          yield* service.check;
          const applied = yield* service.apply;
          assert.strictEqual(applied.active, "1.2.3-fork.8");
          assert.strictEqual(applied.previous, V6);

          yield* TestClock.adjust("181 seconds");
          yield* settle(service);
          assert.strictEqual((yield* service.state).active, V6);
        }),
      ),
    );
  });

  describe("a bundle that failed to boot", () => {
    const failBoot = (service: UiBundleService.UiBundleService["Service"]) =>
      Effect.gen(function* () {
        yield* service.check;
        yield* service.apply;
        yield* TestClock.adjust("181 seconds");
        yield* settle(service);
      });

    it.effect("is not offered again, but a newer one is", () =>
      withServer({ published: publish(V6) }, ({ service, store, feed }) =>
        Effect.gen(function* () {
          yield* failBoot(service);
          assert.deepStrictEqual((yield* store.read).rejected, [V6]);
          const downloads = feed.downloads;

          yield* TestClock.adjust(CHECK_THROTTLE);
          const again = yield* service.check;
          assert.strictEqual(feed.downloads, downloads);
          assert.isNull(again.ready);

          feed.release = publish(V7);
          yield* TestClock.adjust(CHECK_THROTTLE);
          const newer = yield* service.check;
          assert.strictEqual(newer.ready?.version, V7);
        }),
      ),
    );

    it.effect("keeps the boot failure message through a good check until the next apply", () =>
      withServer({ published: publish(V6) }, ({ service, feed }) =>
        Effect.gen(function* () {
          yield* failBoot(service);

          feed.release = publish(V7);
          yield* TestClock.adjust(CHECK_THROTTLE);
          const checked = yield* service.check;
          assert.strictEqual(checked.lastError, "The new UI did not start; reverted.");

          const applied = yield* service.apply;
          assert.isNull(applied.lastError);
        }),
      ),
    );

    it.effect("shows a check error over the boot failure message, then goes back to it", () =>
      withServer({ published: publish(V6) }, ({ service, feed }) =>
        Effect.gen(function* () {
          yield* failBoot(service);

          feed.release = publish(V7, { sha256: "0".repeat(64) });
          yield* TestClock.adjust(CHECK_THROTTLE);
          yield* service.check.pipe(Effect.flip);
          assert.strictEqual(
            (yield* service.state).lastError,
            "The UI bundle failed its SHA-256 check.",
          );

          feed.release = null;
          yield* TestClock.adjust(CHECK_THROTTLE);
          assert.strictEqual(
            (yield* service.check).lastError,
            "The new UI did not start; reverted.",
          );
        }),
      ),
    );

    it.effect("clears the boot failure message on an explicit revert", () =>
      withServer({ published: publish(V6) }, ({ service }) =>
        Effect.gen(function* () {
          yield* failBoot(service);
          assert.isNull((yield* service.revert).lastError);
        }),
      ),
    );

    it.effect("stays rejected across a restart that reverted an unconfirmed boot", () =>
      Effect.gen(function* () {
        const environment = yield* Layer.build(makeEnvironment());
        yield* Effect.gen(function* () {
          const { service } = yield* startServer(makeFeed(publish(V6)).layer);
          yield* service.check;
          yield* service.apply;
        }).pipe(Effect.scoped, Effect.provideContext(environment));

        const { feed, layer } = makeFeed(publish(V6));
        const state = yield* Effect.gen(function* () {
          const { service } = yield* startServer(layer);
          yield* TestClock.adjust(CHECK_THROTTLE);
          return yield* service.check;
        }).pipe(Effect.scoped, Effect.provideContext(environment));
        assert.isNull(state.ready);
        assert.strictEqual(feed.downloads, 0);
      }).pipe(Effect.scoped),
    );
  });

  describe("periodic check", () => {
    it.effect(
      "checks shortly after start without blocking the layer, and again every 6 hours",
      () =>
        withServer({ published: null }, ({ service, feed }) =>
          Effect.gen(function* () {
            assert.strictEqual(feed.latestCalls, 0);
            yield* TestClock.adjust("31 seconds");
            yield* settle(service);
            assert.strictEqual(feed.latestCalls, 1);
            yield* TestClock.adjust("6 hours");
            yield* settle(service);
            assert.strictEqual(feed.latestCalls, 2);
          }),
        ),
    );

    it.effect("survives a failing feed", () =>
      withServer({ published: publish(V6, { sha256: "0".repeat(64) }) }, ({ service }) =>
        Effect.gen(function* () {
          yield* TestClock.adjust("31 seconds");
          yield* settle(service);
          const state = yield* service.state;
          assert.strictEqual(state.lastError, "The UI bundle failed its SHA-256 check.");
        }),
      ),
    );
  });
});
