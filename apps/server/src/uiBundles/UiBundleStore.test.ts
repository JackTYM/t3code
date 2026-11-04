import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { ServerConfig } from "../config.ts";
import * as UiBundleStore from "./UiBundleStore.ts";

const baseLayer = ServerConfig.layerTest(process.cwd(), { prefix: "ui-bundle-store-test-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const openStore = UiBundleStore.UiBundleStore.pipe(Effect.provide(UiBundleStore.layer));

const withPaths = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const root = path.join(config.stateDir, "ui-bundles");
  return { fs, path, root, statePath: path.join(root, "state.json") };
});

const publishBundle = (version: string, files: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const { fs, path, root } = yield* withPaths;
    const dir = path.join(root, version);
    yield* fs.makeDirectory(dir, { recursive: true });
    for (const file of files) yield* fs.writeFileString(path.join(dir, file), "x");
    return dir;
  });

describe("UiBundleStore", () => {
  describe("state", () => {
    it.live("defaults to the built-in UI when nothing is stored", () =>
      Effect.gen(function* () {
        const store = yield* openStore;
        assert.deepStrictEqual(yield* store.read, {
          active: "builtin",
          previous: null,
          ready: null,
          incompatible: null,
          bootPendingSince: null,
        });
      }).pipe(Effect.provide(baseLayer)),
    );

    it.live.each([
      { label: "unparseable", contents: "{not json" },
      { label: "the wrong shape", contents: JSON.stringify({ active: 5 }) },
      { label: "an empty version", contents: JSON.stringify({ active: "", previous: null }) },
    ])("reads state with $label as the default", ({ contents }) =>
      Effect.gen(function* () {
        const { fs, root, statePath } = yield* withPaths;
        yield* fs.makeDirectory(root, { recursive: true });
        yield* fs.writeFileString(statePath, contents);
        const store = yield* openStore;
        assert.strictEqual((yield* store.read).active, "builtin");
      }).pipe(Effect.provide(baseLayer)),
    );

    it.live("persists writes so a restarted store sees them, merging partial patches", () =>
      Effect.gen(function* () {
        const first = yield* openStore;
        yield* first.write({ active: "1.0.0", previous: "0.9.0" });
        yield* first.write({
          ready: { version: "1.1.0", size: 42 },
          bootPendingSince: 1234,
        });

        const restarted = yield* openStore;
        assert.deepStrictEqual(yield* restarted.read, {
          active: "1.0.0",
          previous: "0.9.0",
          ready: { version: "1.1.0", size: 42 },
          incompatible: null,
          bootPendingSince: 1234,
        });
      }).pipe(Effect.provide(baseLayer)),
    );

    it.live("treats an explicit undefined in a patch as unchanged", () =>
      Effect.gen(function* () {
        const store = yield* openStore;
        yield* store.write({ active: "1.0.0", previous: "0.9.0" });
        const next = yield* store.write({
          active: undefined,
          previous: undefined,
          bootPendingSince: 7,
        });
        assert.strictEqual(next.active, "1.0.0");
        assert.strictEqual(next.previous, "0.9.0");
        assert.strictEqual(next.bootPendingSince, 7);
      }).pipe(Effect.provide(baseLayer)),
    );

    it.live("keeps a valid state.json on disk after every write", () =>
      Effect.gen(function* () {
        const { fs, statePath } = yield* withPaths;
        const store = yield* openStore;
        yield* store.write({ incompatible: { version: "2.0.0", reason: "contracts-changed" } });
        const onDisk = JSON.parse(yield* fs.readFileString(statePath));
        assert.deepStrictEqual(onDisk.incompatible, {
          version: "2.0.0",
          reason: "contracts-changed",
        });
      }).pipe(Effect.provide(baseLayer)),
    );
  });

  describe("rootFor", () => {
    it.live("is null for the built-in UI", () =>
      Effect.gen(function* () {
        const store = yield* openStore;
        assert.isNull(yield* store.rootFor("builtin"));
      }).pipe(Effect.provide(baseLayer)),
    );

    it.live("returns the bundle dir only when it contains index.html", () =>
      Effect.gen(function* () {
        const store = yield* openStore;
        assert.isNull(yield* store.rootFor("1.0.0"));

        yield* publishBundle("1.0.0", ["app.js"]);
        assert.isNull(yield* store.rootFor("1.0.0"));

        const dir = yield* publishBundle("1.0.0", ["index.html"]);
        assert.strictEqual(yield* store.rootFor("1.0.0"), dir);
        assert.strictEqual(yield* store.bundleDir("1.0.0"), dir);
      }).pipe(Effect.provide(baseLayer)),
    );

    it.live("never resolves a version that is not a plain directory name", () =>
      Effect.gen(function* () {
        const store = yield* openStore;
        yield* publishBundle("1.0.0", ["index.html"]);
        assert.isNull(yield* store.rootFor("../ui-bundles/1.0.0"));
      }).pipe(Effect.provide(baseLayer)),
    );
  });

  describe("directories", () => {
    it.live("puts staging under its own folder and bundles directly under the root", () =>
      Effect.gen(function* () {
        const { path, root } = yield* withPaths;
        const store = yield* openStore;
        assert.strictEqual(yield* store.bundleDir("1.0.0"), path.join(root, "1.0.0"));
        assert.strictEqual(yield* store.stagingDir("1.0.0"), path.join(root, "staging", "1.0.0"));
      }).pipe(Effect.provide(baseLayer)),
    );

    it.live.each([
      "../x",
      "a/b",
      "a\\b",
      "..",
      ".",
      "",
      "builtin",
      "staging",
      "trash",
      "state.json",
      "STATE.JSON",
      "Staging",
      "BUILTIN",
      "Trash",
      "state.json.abc",
      "1.0.",
      "1.0-",
    ])("refuses the version %j", (version) =>
      Effect.gen(function* () {
        const store = yield* openStore;
        const bundleError = yield* store.bundleDir(version).pipe(Effect.flip);
        const stagingError = yield* store.stagingDir(version).pipe(Effect.flip);
        assert.strictEqual(bundleError.reason, "invalid-version");
        assert.strictEqual(stagingError.reason, "invalid-version");
      }).pipe(Effect.provide(baseLayer)),
    );
  });

  describe("prune", () => {
    it.live("keeps active, previous and a ready bundle, and removes the rest", () =>
      Effect.gen(function* () {
        const { fs, path, root } = yield* withPaths;
        const store = yield* openStore;
        for (const version of ["1.0.0", "1.1.0", "1.2.0", "0.5.0", "0.6.0"]) {
          yield* publishBundle(version, ["index.html"]);
        }
        yield* fs.makeDirectory(path.join(root, "staging", "1.3.0"), { recursive: true });
        yield* store.write({
          active: "1.1.0",
          previous: "1.0.0",
          ready: { version: "1.2.0", size: 1 },
        });

        yield* store.prune;

        const remaining = (yield* fs.readDirectory(root)).toSorted();
        assert.deepStrictEqual(remaining, ["1.0.0", "1.1.0", "1.2.0", "staging", "state.json"]);
      }).pipe(Effect.provide(baseLayer)),
    );

    it.live("leaves staging, trash and the atomic write's temp entries alone", () =>
      Effect.gen(function* () {
        const { fs, path, root } = yield* withPaths;
        const store = yield* openStore;
        yield* fs.makeDirectory(path.join(root, "trash", "parked"), { recursive: true });
        yield* fs.makeDirectory(path.join(root, "staging", "1.3.0.abc"), { recursive: true });
        yield* fs.makeDirectory(path.join(root, "state.json.Xy12"), { recursive: true });
        yield* publishBundle("0.5.0", ["index.html"]);

        yield* store.prune;

        assert.deepStrictEqual((yield* fs.readDirectory(root)).toSorted(), [
          "staging",
          "state.json.Xy12",
          "trash",
        ]);
      }).pipe(Effect.provide(baseLayer)),
    );

    it.live("drops every bundle when the built-in UI is active", () =>
      Effect.gen(function* () {
        const { fs, root } = yield* withPaths;
        const store = yield* openStore;
        yield* publishBundle("1.0.0", ["index.html"]);
        yield* store.prune;
        assert.deepStrictEqual(yield* fs.readDirectory(root), []);
      }).pipe(Effect.provide(baseLayer)),
    );

    it.live("succeeds before any bundle has ever been stored", () =>
      Effect.gen(function* () {
        const store = yield* openStore;
        yield* store.prune;
      }).pipe(Effect.provide(baseLayer)),
    );
  });

  describe("startup cleanup", () => {
    it.live("clears staging and trash left by a crashed extraction but keeps bundles", () =>
      Effect.gen(function* () {
        const { fs, path, root } = yield* withPaths;
        yield* fs.makeDirectory(path.join(root, "staging", "1.3.0.abc"), { recursive: true });
        yield* fs.writeFileString(path.join(root, "staging", "1.3.0.abc", "partial"), "x");
        yield* fs.makeDirectory(path.join(root, "trash", "parked"), { recursive: true });
        yield* publishBundle("1.0.0", ["index.html"]);

        yield* openStore;

        assert.deepStrictEqual(yield* fs.readDirectory(root), ["1.0.0"]);
      }).pipe(Effect.provide(baseLayer)),
    );
  });
});
