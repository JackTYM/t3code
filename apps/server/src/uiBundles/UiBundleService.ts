import {
  UiBundleError,
  type UiBundleConfirmBootInput,
  type UiBundleState,
} from "@t3tools/contracts";
import { compareSemverVersions } from "@t3tools/shared/semver";
import { decideUiBundleCompat, type UiCompat } from "@t3tools/shared/uiCompat";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { resolveStaticDir, ServerConfig } from "../config.ts";
import { extractUiBundle } from "./extractUiBundle.ts";
import { UiBundleFeed } from "./UiBundleFeed.ts";
import { UiBundleStore } from "./UiBundleStore.ts";

const BOOT_CONFIRMATION_WINDOW = "60 seconds";
const CHECK_INTERVAL = "6 hours";
// Keeps the first network request out of server startup.
const FIRST_CHECK_DELAY = "30 seconds";
const BOOT_REVERTED_MESSAGE = "The new UI did not start; reverted.";

const BuiltinCompat = Schema.fromJsonString(
  Schema.Struct({
    schema: Schema.Literal(1),
    contractsHash: Schema.String,
    versionCore: Schema.String,
    version: Schema.String,
    sha: Schema.String,
    repository: Schema.String,
  }),
);
const decodeBuiltinCompat = Schema.decodeUnknownEffect(BuiltinCompat);

export class UiBundleService extends Context.Service<
  UiBundleService,
  {
    readonly state: Effect.Effect<UiBundleState>;
    readonly check: Effect.Effect<UiBundleState, UiBundleError>;
    readonly apply: Effect.Effect<UiBundleState, UiBundleError>;
    readonly revert: Effect.Effect<UiBundleState>;
    /** Ignored unless `version` is the active bundle and its boot is still pending. */
    readonly confirmBoot: (input: UiBundleConfirmBootInput) => Effect.Effect<void>;
    readonly activeRoot: Effect.Effect<string | null>;
  }
>()("t3/uiBundles/UiBundleService") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const store = yield* UiBundleStore;
  const feed = yield* UiBundleFeed;
  const scope = yield* Effect.scope;

  const builtinRoot = config.staticDir ?? (yield* resolveStaticDir());
  const builtin: UiCompat | null =
    builtinRoot === undefined
      ? null
      : yield* fs.readFileString(path.join(builtinRoot, "ui-compat.json")).pipe(
          Effect.flatMap(decodeBuiltinCompat),
          Effect.catchCause(() => Effect.succeed(null)),
        );
  const enabled = builtin !== null && builtin.repository.trim() !== "";

  // Not persisted: a restart should start from a clean "never checked" state.
  const lastCheckedAt = yield* Ref.make<number | null>(null);
  const lastError = yield* Ref.make<string | null>(null);
  const bootTimer = yield* Ref.make<Option.Option<Fiber.Fiber<void>>>(Option.none());
  // Serializes every state transition, including the boot timer's revert.
  const lock = yield* Semaphore.make(1);

  const state = Effect.gen(function* () {
    const stored = yield* store.read;
    const checkedAt = yield* Ref.get(lastCheckedAt);
    return {
      enabled,
      builtinVersion: builtin?.version ?? "",
      active: stored.active,
      previous: stored.previous,
      ready: stored.ready,
      incompatible: stored.incompatible,
      lastCheckedAt: checkedAt === null ? null : DateTime.formatIso(DateTime.makeUnsafe(checkedAt)),
      lastError: yield* Ref.get(lastError),
      bootPending: stored.bootPendingSince !== null,
    } satisfies UiBundleState;
  });

  const prune = store.prune.pipe(Effect.ignoreCause({ log: true }));

  const cancelBootTimer = Effect.gen(function* () {
    const timer = yield* Ref.getAndSet(bootTimer, Option.none());
    if (Option.isSome(timer)) yield* Fiber.interrupt(timer.value);
  });

  // Runs inside the lock. Only reverts a boot that is still pending for `version`.
  const revertUnconfirmedBoot = Effect.fn("UiBundleService.revertUnconfirmedBoot")(function* (
    version: string,
  ) {
    const stored = yield* store.read;
    if (stored.active !== version || stored.bootPendingSince === null) return;
    yield* store
      .write({ active: stored.previous ?? "builtin", previous: null, bootPendingSince: null })
      .pipe(Effect.ignoreCause({ log: true }));
    yield* Ref.set(lastError, BOOT_REVERTED_MESSAGE);
    yield* prune;
  });

  const startBootTimer = Effect.fn("UiBundleService.startBootTimer")(function* (version: string) {
    const timer = yield* Effect.sleep(BOOT_CONFIRMATION_WINDOW).pipe(
      Effect.andThen(Ref.set(bootTimer, Option.none())),
      Effect.andThen(lock.withPermits(1)(revertUnconfirmedBoot(version))),
      Effect.forkIn(scope),
    );
    yield* Ref.set(bootTimer, Option.some(timer));
  });

  // A server that went down before the new UI confirmed it cannot trust that bundle.
  const initial = yield* store.read;
  if (initial.bootPendingSince !== null) {
    if (initial.active === "builtin") {
      yield* store.write({ bootPendingSince: null }).pipe(Effect.ignoreCause({ log: true }));
    } else {
      yield* revertUnconfirmedBoot(initial.active);
    }
  }

  const effectiveVersion = Effect.gen(function* () {
    const stored = yield* store.read;
    return stored.active === "builtin" ? (builtin?.version ?? "") : stored.active;
  });

  const checkOnce = Effect.fn("UiBundleService.checkOnce")(function* (current: UiCompat) {
    const release = yield* feed.latest(current.repository);
    if (release === null) return;
    const { manifest, zipUrl } = release;

    const stored = yield* store.read;
    // Equal or older is "nothing to do"; a bundle that is already staged needs no second download.
    if (
      compareSemverVersions(manifest.version, yield* effectiveVersion) <= 0 ||
      stored.ready?.version === manifest.version
    ) {
      return;
    }

    const decision = decideUiBundleCompat(current, {
      schema: 1,
      contractsHash: manifest.contractsHash,
      versionCore: manifest.versionCore,
      version: manifest.version,
      sha: manifest.sha,
      repository: current.repository,
    });
    if (!decision.compatible) {
      yield* store.write({
        incompatible: { version: manifest.version, reason: decision.reason },
      });
      return;
    }

    const bytes = yield* feed.download(zipUrl, manifest.size + 1);
    yield* extractUiBundle({
      zipBytes: bytes,
      manifest,
      stagingDir: yield* store.stagingDir(manifest.version),
      finalDir: yield* store.bundleDir(manifest.version),
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
    yield* store.write({
      ready: { version: manifest.version, size: manifest.size },
      incompatible: null,
    });
    yield* prune;
  });

  const check = Effect.fn("UiBundleService.check")(function* () {
    if (!enabled || builtin === null) return yield* new UiBundleError({ reason: "disabled" });
    yield* checkOnce(builtin).pipe(
      Effect.tapError((error) => Ref.set(lastError, error.message)),
      Effect.mapError((cause) => new UiBundleError({ reason: "check-failed", cause })),
    );
    yield* Ref.set(lastError, null);
    yield* Ref.set(lastCheckedAt, yield* Clock.currentTimeMillis);
    return yield* state;
  });

  const apply = Effect.fn("UiBundleService.apply")(function* () {
    const stored = yield* store.read;
    if (stored.ready === null) return yield* new UiBundleError({ reason: "nothing-ready" });
    const { version } = stored.ready;
    // The bundle may have been removed from disk since it was staged; never switch to a root we cannot serve.
    if ((yield* store.rootFor(version)) === null) {
      return yield* new UiBundleError({ reason: "apply-failed" });
    }
    yield* cancelBootTimer;
    yield* store
      .write({
        active: version,
        previous: stored.active === "builtin" ? null : stored.active,
        ready: null,
        bootPendingSince: yield* Clock.currentTimeMillis,
      })
      .pipe(Effect.mapError((cause) => new UiBundleError({ reason: "apply-failed", cause })));
    yield* Ref.set(lastError, null);
    yield* startBootTimer(version);
    return yield* state;
  });

  const revert = Effect.fn("UiBundleService.revert")(function* () {
    yield* cancelBootTimer;
    yield* store
      .write({ active: "builtin", previous: null, bootPendingSince: null })
      .pipe(Effect.ignoreCause({ log: true }));
    yield* prune;
    return yield* state;
  });

  const confirmPending = Effect.fn("UiBundleService.confirmPending")(function* (
    input: UiBundleConfirmBootInput,
  ) {
    const stored = yield* store.read;
    if (stored.active !== input.version || stored.bootPendingSince === null) return;
    yield* cancelBootTimer;
    yield* store.write({ bootPendingSince: null }).pipe(Effect.ignoreCause({ log: true }));
    yield* prune;
  });

  if (enabled) {
    yield* Effect.sleep(FIRST_CHECK_DELAY).pipe(
      Effect.andThen(
        lock
          .withPermits(1)(check())
          .pipe(Effect.ignoreCause({ log: true }), Effect.repeat(Schedule.spaced(CHECK_INTERVAL))),
      ),
      Effect.forkIn(scope),
    );
  }

  return UiBundleService.of({
    state,
    check: lock.withPermits(1)(check()),
    apply: lock.withPermits(1)(apply()),
    revert: lock.withPermits(1)(revert()),
    confirmBoot: Effect.fn("UiBundleService.confirmBoot")((input: UiBundleConfirmBootInput) =>
      lock.withPermits(1)(confirmPending(input)),
    ),
    activeRoot: Effect.gen(function* () {
      return yield* store.rootFor((yield* store.read).active);
    }),
  });
});

export const layer = Layer.effect(UiBundleService, make);
