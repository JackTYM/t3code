import {
  UiBundleError,
  type UiBundleConfirmBootInput,
  type UiBundleManifest,
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

// Counted from apply, not from the first request the new UI makes. Long enough for a cold cache
// over Tailscale or T3 Connect; a UI that has not mounted by then is treated as broken.
const BOOT_CONFIRMATION_WINDOW = "180 seconds";
const CHECK_INTERVAL = "6 hours";
// Keeps the first network request out of server startup.
const FIRST_CHECK_DELAY = "30 seconds";
// A manual check inside this window answers from the cached state instead of asking GitHub again.
const CHECK_THROTTLE_MS = 30_000;
const REVERT_RETRY_INTERVAL = "30 seconds";
const REVERT_RETRIES = 10;
const BOOT_REVERTED_MESSAGE = "The new UI did not start; reverted.";
const SERVER_UPDATED_MESSAGE = "The server was updated; the downloaded UI was removed.";
const REVERT_FAILED_MESSAGE = "Could not return to the built-in UI.";

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

// What `extractUiBundle` verified and left in the bundle directory.
const BundleCompat = Schema.fromJsonString(
  Schema.Struct({ contractsHash: Schema.String, versionCore: Schema.String }),
);
const decodeBundleCompat = Schema.decodeUnknownEffect(BundleCompat);

const maxVersion = (left: string, right: string) =>
  compareSemverVersions(left, right) >= 0 ? left : right;

export class UiBundleService extends Context.Service<
  UiBundleService,
  {
    readonly state: Effect.Effect<UiBundleState>;
    /**
     * At most one check runs at a time: a call that arrives while another is running waits for it.
     * A call within 30 seconds of the last attempt, including one that waited, returns the current
     * state without a network call.
     */
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
  const builtinVersion = builtin?.version ?? "";

  // Not persisted: a restart should start from a clean "never checked" state.
  const lastCheckedAt = yield* Ref.make<number | null>(null);
  const lastAttemptAt = yield* Ref.make<number | null>(null);
  const checkError = yield* Ref.make<string | null>(null);
  // Why the UI went back to the built-in one. Unlike `checkError`, a later good check must not
  // erase it; only a successful apply or an explicit revert does.
  const notice = yield* Ref.make<string | null>(null);
  const bootTimer = yield* Ref.make<Option.Option<Fiber.Fiber<void>>>(Option.none());
  // Only keeps two checks from running at once (a waiting one is then throttled). The network work holds no state lock.
  const checkGuard = yield* Semaphore.make(1);
  // Guards every state mutation (apply, revert, confirmBoot, the boot timer's revert, and the
  // extract, commit and prune that follow a download). Held only for local disk work, so a slow
  // download never delays a boot confirmation.
  const stateLock = yield* Semaphore.make(1);

  const state = Effect.gen(function* () {
    const stored = yield* store.read;
    const checkedAt = yield* Ref.get(lastCheckedAt);
    return {
      enabled,
      builtinVersion,
      active: stored.active,
      previous: stored.previous,
      ready: stored.ready,
      incompatible: stored.incompatible,
      lastCheckedAt: checkedAt === null ? null : DateTime.formatIso(DateTime.makeUnsafe(checkedAt)),
      lastError: (yield* Ref.get(checkError)) ?? (yield* Ref.get(notice)),
      bootPending: stored.bootPendingSince !== null,
    } satisfies UiBundleState;
  });

  const prune = store.prune.pipe(Effect.ignoreCause({ log: true }));

  // The greater of what is being served and what shipped with the server: a persisted bundle can
  // be older than a server that was updated since.
  const effectiveVersion = (active: string) =>
    active === "builtin" ? builtinVersion : maxVersion(active, builtinVersion);

  // Persisted bundles outlive server and desktop updates, so compatibility is decided again
  // against the built-in client of this process, not the one that existed at stage time.
  const bundleUsable = Effect.fn("UiBundleService.bundleUsable")(function* (version: string) {
    if (builtin === null || compareSemverVersions(version, builtin.version) <= 0) return false;
    const compat = yield* store.bundleDir(version).pipe(
      Effect.flatMap((dir) => fs.readFileString(path.join(dir, "ui-compat.json"))),
      Effect.flatMap(decodeBundleCompat),
      Effect.orElseSucceed(() => null),
    );
    return (
      compat !== null &&
      decideUiBundleCompat(builtin, {
        schema: 1,
        contractsHash: compat.contractsHash,
        versionCore: compat.versionCore,
        version,
        sha: "",
        repository: builtin.repository,
      }).compatible
    );
  });

  const cancelBootTimer = Effect.gen(function* () {
    const timer = yield* Ref.getAndSet(bootTimer, Option.none());
    if (Option.isSome(timer)) yield* Fiber.interrupt(timer.value);
  });

  // Runs inside the state lock. Only reverts a boot that is still pending for `version`; fails
  // when the write does, so the caller can retry instead of reporting a revert that did not happen.
  const revertUnconfirmedBoot = Effect.fn("UiBundleService.revertUnconfirmedBoot")(function* (
    version: string,
  ) {
    const stored = yield* store.read;
    if (stored.active !== version || stored.bootPendingSince === null) return;
    yield* store.write({
      active: stored.previous ?? "builtin",
      previous: null,
      bootPendingSince: null,
      rejected: [...stored.rejected, version],
    });
    yield* Ref.set(notice, BOOT_REVERTED_MESSAGE);
    yield* prune;
  });

  // Never clears its own ref entry: cancelling a finished fiber is harmless, and clearing from the
  // fiber could erase a newer timer that `apply` started after this one's revert committed.
  const startBootTimer = Effect.fn("UiBundleService.startBootTimer")(function* (version: string) {
    const timer = yield* Effect.sleep(BOOT_CONFIRMATION_WINDOW).pipe(
      Effect.andThen(
        stateLock
          .withPermits(1)(revertUnconfirmedBoot(version))
          .pipe(
            Effect.retry({
              schedule: Schedule.spaced(REVERT_RETRY_INTERVAL),
              times: REVERT_RETRIES,
            }),
          ),
      ),
      Effect.ignoreCause({ log: true }),
      Effect.forkIn(scope),
    );
    yield* Ref.set(bootTimer, Option.some(timer));
  });

  const revalidatePersisted = Effect.gen(function* () {
    const stored = yield* store.read;
    const activeOk = stored.active === "builtin" || (yield* bundleUsable(stored.active));
    const previousOk = stored.previous !== null && (yield* bundleUsable(stored.previous));
    const readyOk = stored.ready !== null && (yield* bundleUsable(stored.ready.version));

    const survivingPrevious = previousOk ? stored.previous : null;
    const active = activeOk ? stored.active : (survivingPrevious ?? "builtin");
    const previous = activeOk ? survivingPrevious : null;
    const ready = readyOk ? stored.ready : null;
    const incompatible =
      builtin !== null &&
      stored.incompatible !== null &&
      compareSemverVersions(stored.incompatible.version, effectiveVersion(active)) <= 0
        ? null
        : stored.incompatible;

    const removedBundle = active !== stored.active || (stored.ready !== null && ready === null);
    if (!removedBundle && previous === stored.previous && incompatible === stored.incompatible) {
      return;
    }
    yield* store
      .write({
        active,
        previous,
        ready,
        incompatible,
        bootPendingSince: active === stored.active ? stored.bootPendingSince : null,
      })
      .pipe(
        Effect.andThen(removedBundle ? Ref.set(notice, SERVER_UPDATED_MESSAGE) : Effect.void),
        Effect.andThen(prune),
        Effect.ignoreCause({ log: true }),
      );
  });

  // A server that went down before the new UI confirmed it cannot trust that bundle.
  const initial = yield* store.read;
  if (initial.bootPendingSince !== null) {
    if (initial.active === "builtin") {
      yield* store.write({ bootPendingSince: null }).pipe(Effect.ignoreCause({ log: true }));
    } else {
      // A failed write leaves the bundle pending; the timer keeps retrying the revert.
      yield* revertUnconfirmedBoot(initial.active).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not revert an unconfirmed UI bundle at startup", cause).pipe(
            Effect.andThen(startBootTimer(initial.active)),
          ),
        ),
      );
    }
  }
  yield* revalidatePersisted;

  // True when the feed offers nothing we should fetch or stage.
  const nothingToDo = (stored: typeof initial, manifest: UiBundleManifest) =>
    compareSemverVersions(manifest.version, effectiveVersion(stored.active)) <= 0 ||
    (stored.ready !== null && compareSemverVersions(manifest.version, stored.ready.version) <= 0) ||
    stored.rejected.includes(manifest.version);

  const checkOnce = Effect.fn("UiBundleService.checkOnce")(function* (current: UiCompat) {
    const release = yield* feed.latest(current.repository);
    if (release === null) return;
    const { manifest, zipUrl } = release;

    if (nothingToDo(yield* store.read, manifest)) return;

    const decision = decideUiBundleCompat(current, {
      schema: 1,
      contractsHash: manifest.contractsHash,
      versionCore: manifest.versionCore,
      version: manifest.version,
      sha: manifest.sha,
      repository: current.repository,
    });
    if (!decision.compatible) {
      yield* store
        .write({ incompatible: { version: manifest.version, reason: decision.reason } })
        .pipe(stateLock.withPermits(1));
      return;
    }

    // No state lock: a slow download must not delay apply, revert or boot confirmation.
    const bytes = yield* feed.download(zipUrl, manifest.size + 1);

    // Extract, commit and prune stay together under the lock: a concurrent prune would otherwise
    // delete the published directory before `ready` points at it.
    yield* Effect.gen(function* () {
      // The state may have moved while the bytes were downloading.
      if (nothingToDo(yield* store.read, manifest)) return;
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
    }).pipe(stateLock.withPermits(1));
  });

  const runCheck = Effect.fn("UiBundleService.runCheck")(function* (current: UiCompat) {
    const now = yield* Clock.currentTimeMillis;
    const last = yield* Ref.get(lastAttemptAt);
    if (last !== null && now - last < CHECK_THROTTLE_MS) return;
    yield* Ref.set(lastAttemptAt, now);
    yield* checkOnce(current).pipe(
      Effect.tapError((error) => Ref.set(checkError, error.message)),
      Effect.mapError((cause) => new UiBundleError({ reason: "check-failed", cause })),
    );
    yield* Ref.set(checkError, null);
    yield* Ref.set(lastCheckedAt, yield* Clock.currentTimeMillis);
  });

  const check = Effect.fn("UiBundleService.check")(function* () {
    if (!enabled || builtin === null) return yield* new UiBundleError({ reason: "disabled" });
    yield* runCheck(builtin).pipe(checkGuard.withPermits(1));
    return yield* state;
  });

  // Runs inside the state lock.
  const apply = Effect.fn("UiBundleService.apply")(function* () {
    const stored = yield* store.read;
    if (stored.ready === null) return yield* new UiBundleError({ reason: "nothing-ready" });
    const { version } = stored.ready;
    // The bundle may have been removed or replaced on disk since it was staged; never switch to a
    // root we cannot serve or one that this server no longer accepts.
    if ((yield* store.rootFor(version)) === null || !(yield* bundleUsable(version))) {
      return yield* new UiBundleError({ reason: "apply-failed" });
    }
    // Applying over a bundle that has not confirmed keeps the last confirmed one as the way back.
    const previous =
      stored.bootPendingSince !== null
        ? stored.previous
        : stored.active === "builtin"
          ? null
          : stored.active;
    // The write comes first: if it fails, the previous state and timer stay exactly as they were.
    yield* store
      .write({
        active: version,
        previous,
        ready: null,
        incompatible:
          stored.incompatible !== null &&
          compareSemverVersions(stored.incompatible.version, version) <= 0
            ? null
            : stored.incompatible,
        bootPendingSince: yield* Clock.currentTimeMillis,
      })
      .pipe(Effect.mapError((cause) => new UiBundleError({ reason: "apply-failed", cause })));
    yield* cancelBootTimer;
    yield* startBootTimer(version);
    yield* Ref.set(notice, null);
    return yield* state;
  });

  // Runs inside the state lock. The interface has no error channel, so a failed write is logged
  // and surfaced as `lastError`; a pending boot keeps its timer, which retries the revert.
  const revert = Effect.fn("UiBundleService.revert")(function* () {
    const written = yield* store
      .write({ active: "builtin", previous: null, bootPendingSince: null })
      .pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not revert to the built-in UI", cause).pipe(Effect.as(false)),
        ),
      );
    if (written) {
      yield* cancelBootTimer;
      yield* Ref.set(notice, null);
      yield* prune;
    } else {
      yield* Ref.set(notice, REVERT_FAILED_MESSAGE);
    }
    return yield* state;
  });

  // Runs inside the state lock. On a failed write the timer stays, so the client can confirm again.
  const confirmPending = Effect.fn("UiBundleService.confirmPending")(function* (
    input: UiBundleConfirmBootInput,
  ) {
    const stored = yield* store.read;
    if (stored.active !== input.version || stored.bootPendingSince === null) return;
    const written = yield* store.write({ bootPendingSince: null }).pipe(
      Effect.as(true),
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not record a confirmed UI boot", cause).pipe(Effect.as(false)),
      ),
    );
    if (!written) return;
    yield* cancelBootTimer;
    yield* prune;
  });

  if (enabled) {
    yield* Effect.sleep(FIRST_CHECK_DELAY).pipe(
      Effect.andThen(
        check().pipe(
          Effect.ignoreCause({ log: true }),
          Effect.repeat(Schedule.spaced(CHECK_INTERVAL)),
        ),
      ),
      Effect.forkIn(scope),
    );
  }

  return UiBundleService.of({
    state,
    check: check(),
    apply: stateLock.withPermits(1)(apply()),
    revert: stateLock.withPermits(1)(revert()),
    confirmBoot: Effect.fn("UiBundleService.confirmBoot")((input: UiBundleConfirmBootInput) =>
      stateLock.withPermits(1)(confirmPending(input)),
    ),
    // One stat per static request. Caching the answer would need invalidating on every apply,
    // revert and prune, and a bundle deleted from under us must fall back to the built-in UI at once.
    activeRoot: Effect.gen(function* () {
      return yield* store.rootFor((yield* store.read).active);
    }),
  });
});

export const layer = Layer.effect(UiBundleService, make);
