import { UiBundleState } from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { ServerConfig } from "../config.ts";
import { UI_BUNDLE_TRASH_DIR } from "./extractUiBundle.ts";

/** Persisted subset of `UiBundleState`; the rest of that state is derived or kept in memory. */
const UiBundleStoreState = Schema.Struct({
  active: UiBundleState.fields.active,
  previous: UiBundleState.fields.previous,
  ready: UiBundleState.fields.ready,
  incompatible: UiBundleState.fields.incompatible,
  /** Epoch ms of the apply that is still waiting for the UI to confirm it mounted. */
  bootPendingSince: Schema.NullOr(Schema.Number),
});
export type UiBundleStoreState = typeof UiBundleStoreState.Type;

const DEFAULT_STATE: UiBundleStoreState = {
  active: "builtin",
  previous: null,
  ready: null,
  incompatible: null,
  bootPendingSince: null,
};

const decodeState = Schema.decodeUnknownEffect(Schema.fromJsonString(UiBundleStoreState));
const encodeState = Schema.encodeEffect(Schema.fromJsonString(UiBundleStoreState));

const STATE_FILE = "state.json";
const STAGING_DIR = "staging";
// Version names become directory names under the same root as these, so they must not collide.
// Compared lower-cased because macOS and Windows resolve `STATE.JSON` or `Staging` to the real entry.
const RESERVED_NAMES: ReadonlySet<string> = new Set([
  "builtin",
  STAGING_DIR,
  UI_BUNDLE_TRASH_DIR,
  STATE_FILE,
]);
// The atomic state write creates `state.json.*` temp directories beside the state file.
const isReserved = (version: string) => {
  const lower = version.toLowerCase();
  return RESERVED_NAMES.has(lower) || lower.startsWith(`${STATE_FILE}.`);
};
// The version comes from a downloaded manifest; keep it to one path segment of plain characters.
// It must end alphanumeric: Windows drops a trailing dot, so "1.0." would alias "1.0".
const SAFE_VERSION = /^[A-Za-z0-9](?:[A-Za-z0-9._+-]*[A-Za-z0-9])?$/u;

export class UiBundleStoreError extends Schema.TaggedError<UiBundleStoreError>()(
  "UiBundleStoreError",
  {
    reason: Schema.Literals(["invalid-version", "io"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason === "invalid-version"
      ? "That UI bundle version cannot be stored."
      : "Could not read or write stored UI bundles.";
  }
}

export class UiBundleStore extends Context.Service<
  UiBundleStore,
  {
    readonly read: Effect.Effect<UiBundleStoreState>;
    readonly write: (
      patch: Partial<UiBundleStoreState>,
    ) => Effect.Effect<UiBundleStoreState, UiBundleStoreError>;
    /**
     * Directory to serve for `active`, or null (built-in) when it is `builtin` or the bundle
     * directory has no index.html.
     */
    readonly rootFor: (active: string) => Effect.Effect<string | null>;
    readonly bundleDir: (version: string) => Effect.Effect<string, UiBundleStoreError>;
    readonly stagingDir: (version: string) => Effect.Effect<string, UiBundleStoreError>;
    /**
     * Removes every bundle directory that is not active, previous, or ready. Callers serialize
     * check, extract and prune (the service holds a semaphore); prune only locks against `write`.
     */
    readonly prune: Effect.Effect<void, UiBundleStoreError>;
  }
>()("t3/uiBundles/UiBundleStore") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;

  const root = path.join(config.stateDir, "ui-bundles");
  const statePath = path.join(root, STATE_FILE);

  // No extraction can be running while the store is being built, so anything left in these was
  // abandoned by a crash. A bundle parked in trash/ by a crashed publish is dropped too.
  yield* Effect.forEach(
    [STAGING_DIR, UI_BUNDLE_TRASH_DIR],
    (name) => fs.remove(path.join(root, name), { recursive: true, force: true }),
    { discard: true },
  ).pipe(Effect.ignore({ log: true }));

  // A corrupt or unreadable file must not strand the server on a broken UI selection.
  const stored = yield* fs.readFileString(statePath).pipe(
    Effect.flatMap(decodeState),
    Effect.orElseSucceed(() => DEFAULT_STATE),
  );
  const state = yield* Ref.make(stored);
  const writeLock = yield* Semaphore.make(1);

  const toIoError = (cause: unknown) => new UiBundleStoreError({ reason: "io", cause });

  const versionDir = (parent: string, version: string) =>
    SAFE_VERSION.test(version) && !isReserved(version)
      ? Effect.succeed(path.join(parent, version))
      : Effect.fail(new UiBundleStoreError({ reason: "invalid-version" }));

  const write = Effect.fn("UiBundleStore.write")(function* (patch: Partial<UiBundleStoreState>) {
    return yield* Effect.gen(function* () {
      const current = yield* Ref.get(state);
      // An explicit `undefined` means "unchanged"; spreading it would fail the encode below.
      const next: UiBundleStoreState = {
        active: patch.active ?? current.active,
        previous: patch.previous === undefined ? current.previous : patch.previous,
        ready: patch.ready === undefined ? current.ready : patch.ready,
        incompatible: patch.incompatible === undefined ? current.incompatible : patch.incompatible,
        bootPendingSince:
          patch.bootPendingSince === undefined ? current.bootPendingSince : patch.bootPendingSince,
      };
      const contents = yield* encodeState(next);
      yield* writeFileStringAtomically({ filePath: statePath, contents }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
      yield* Ref.set(state, next);
      return next;
    }).pipe(writeLock.withPermits(1), Effect.mapError(toIoError));
  });

  const rootFor = Effect.fn("UiBundleStore.rootFor")(function* (active: string) {
    if (active === "builtin") return null;
    const dir = yield* versionDir(root, active).pipe(Effect.option);
    if (dir._tag === "None") return null;
    const hasIndex = yield* fs
      .exists(path.join(dir.value, "index.html"))
      .pipe(Effect.orElseSucceed(() => false));
    return hasIndex ? dir.value : null;
  });

  const prune = Effect.fn("UiBundleStore.prune")(function* () {
    yield* Effect.gen(function* () {
      const current = yield* Ref.get(state);
      const keep = new Set<string>();
      for (const version of [current.active, current.previous, current.ready?.version]) {
        if (version) keep.add(version);
      }
      const names = yield* fs.readDirectory(root).pipe(
        Effect.catchTags({
          PlatformError: (error) =>
            error.reason._tag === "NotFound" ? Effect.succeed([]) : Effect.fail(toIoError(error)),
        }),
      );
      // staging/ and trash/ belong to a publish in flight, and `state.json.*` are the atomic
      // write's temp directories; neither may be removed from under their owner.
      const removable = names.filter((name) => !keep.has(name) && !isReserved(name));
      yield* Effect.forEach(
        removable,
        (name) =>
          fs
            .remove(path.join(root, name), { recursive: true, force: true })
            .pipe(Effect.mapError(toIoError)),
        { discard: true },
      );
    }).pipe(writeLock.withPermits(1));
  });

  return UiBundleStore.of({
    read: Ref.get(state),
    write,
    rootFor,
    bundleDir: Effect.fn("UiBundleStore.bundleDir")(function* (version: string) {
      return yield* versionDir(root, version);
    }),
    stagingDir: Effect.fn("UiBundleStore.stagingDir")(function* (version: string) {
      return yield* versionDir(path.join(root, STAGING_DIR), version);
    }),
    prune: prune(),
  });
});

/**
 * Persists under `ServerConfig.stateDir`. Tests provide it with `ServerConfig.layerTest(cwd, { prefix })`
 * and `NodeServices.layer`, so state and bundle directories live in a throwaway temp dir.
 */
export const layer = Layer.effect(UiBundleStore, make);
