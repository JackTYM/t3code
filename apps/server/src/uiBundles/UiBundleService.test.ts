// @effect-diagnostics nodeBuiltinImport:off - fixtures need a sha256 of the zip and no Effect equivalent exists.
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { UiBundleManifest } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
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
  const feed = { release: initial, latestCalls: 0, downloads: 0 };
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
        Effect.sync(() => {
          feed.downloads += 1;
          return feed.release?.zip ?? new Uint8Array();
        }),
    }),
  );
  return { feed, layer };
};

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
const startServer = (feedLayer: Layer.Layer<UiBundleFeed>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const context = yield* Layer.build(
      UiBundleService.layer.pipe(Layer.provideMerge(UiBundleStore.layer), Layer.provide(feedLayer)),
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
const settle = (service: UiBundleService.UiBundleService["Service"]) =>
  service.apply.pipe(Effect.exit, Effect.asVoid);

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

    it.effect("keeps an unconfirmed bundle for 59 seconds and reverts it after 61", () =>
      withServer({ published: publish(V6) }, ({ service }) =>
        Effect.gen(function* () {
          yield* service.check;
          yield* service.apply;

          yield* TestClock.adjust("59 seconds");
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

          yield* TestClock.adjust("61 seconds");
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
          yield* service.check;
          const applied = yield* service.apply;
          assert.strictEqual(applied.previous, V6);

          yield* TestClock.adjust("61 seconds");
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

          yield* TestClock.adjust("61 seconds");
          yield* settle(service);
          assert.isNull((yield* service.state).lastError);
        }),
      ),
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
