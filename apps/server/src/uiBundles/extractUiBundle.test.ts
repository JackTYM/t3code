// @effect-diagnostics nodeBuiltinImport:off - zip fixtures need crypto and no Effect equivalent exists.
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { UiBundleManifest } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeCrypto from "node:crypto";

import { extractUiBundle } from "./extractUiBundle.ts";
import { buildZip, type ZipSpec } from "./testZip.ts";

const MB = 1024 * 1024;

const COMPAT = { contractsHash: "hash-a", versionCore: "1.2.3" };
const compatFile = (overrides: Partial<typeof COMPAT> = {}): ZipSpec => ({
  name: "ui-compat.json",
  data: JSON.stringify({ ...COMPAT, ...overrides }),
});
const validFiles: ReadonlyArray<ZipSpec> = [
  { name: "index.html", data: "<html></html>" },
  { name: "assets/", data: "" },
  { name: "assets/app.js", data: "console.log(1)" },
  compatFile(),
];

const manifestFor = (zip: Buffer, overrides: Partial<UiBundleManifest> = {}): UiBundleManifest => ({
  schema: 1,
  version: "1.2.3-nightly.1",
  versionCore: COMPAT.versionCore,
  contractsHash: COMPAT.contractsHash,
  sha: "abc",
  sha256: NodeCrypto.createHash("sha256").update(zip).digest("hex"),
  size: zip.length,
  assetName: "ui-bundle.zip",
  ...overrides,
});

const extract = (zip: Buffer, overrides: Partial<UiBundleManifest> = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const base = yield* fs.makeTempDirectoryScoped({ prefix: "ui-bundle-extract-test-" });
    const stagingDir = path.join(base, "staging", "v");
    const finalDir = path.join(base, "v");
    const exit = yield* extractUiBundle({
      zipBytes: zip,
      manifest: manifestFor(zip, overrides),
      stagingDir,
      finalDir,
    }).pipe(Effect.flip, Effect.option);
    return {
      error: exit._tag === "Some" ? exit.value : undefined,
      stagingDir,
      finalDir,
      base,
      exists: (target: string) => fs.exists(target),
    };
  });

const expectRejected = (zip: Buffer, reason: string, overrides: Partial<UiBundleManifest> = {}) =>
  Effect.gen(function* () {
    const result = yield* extract(zip, overrides);
    assert.strictEqual(result.error?.reason, reason);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

// Rejections must leave neither the staging dir nor a published bundle behind.
const expectNothingLeft = (zip: Buffer) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const base = yield* fs.makeTempDirectoryScoped({ prefix: "ui-bundle-extract-test-" });
    const stagingDir = path.join(base, "staging", "v");
    const finalDir = path.join(base, "v");
    const error = yield* extractUiBundle({
      zipBytes: zip,
      manifest: manifestFor(zip),
      stagingDir,
      finalDir,
    }).pipe(Effect.flip);
    assert.isDefined(error.reason);
    assert.isFalse(yield* fs.exists(stagingDir));
    assert.isFalse(yield* fs.exists(finalDir));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("extractUiBundle", () => {
  it.live("extracts a valid bundle into the final dir and removes staging", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const zip = buildZip(validFiles);
      const result = yield* extract(zip);
      assert.isUndefined(result.error);
      assert.strictEqual(
        yield* fs.readFileString(path.join(result.finalDir, "assets", "app.js")),
        "console.log(1)",
      );
      assert.isTrue(yield* result.exists(path.join(result.finalDir, "index.html")));
      assert.isFalse(yield* result.exists(result.stagingDir));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("replaces an existing bundle of the same version", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const base = yield* fs.makeTempDirectoryScoped({ prefix: "ui-bundle-extract-test-" });
      const finalDir = path.join(base, "v");
      yield* fs.makeDirectory(finalDir);
      yield* fs.writeFileString(path.join(finalDir, "stale.txt"), "old");
      const zip = buildZip(validFiles);
      yield* extractUiBundle({
        zipBytes: zip,
        manifest: manifestFor(zip),
        stagingDir: path.join(base, "staging", "v"),
        finalDir,
      });
      assert.isFalse(yield* fs.exists(path.join(finalDir, "stale.txt")));
      assert.isTrue(yield* fs.exists(path.join(finalDir, "index.html")));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("leaves a previously published bundle untouched when a new one is rejected", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const base = yield* fs.makeTempDirectoryScoped({ prefix: "ui-bundle-extract-test-" });
      const finalDir = path.join(base, "v");
      yield* fs.makeDirectory(finalDir);
      yield* fs.writeFileString(path.join(finalDir, "index.html"), "old");
      const zip = buildZip([
        { name: "index.html", data: "new" },
        compatFile({ contractsHash: "x" }),
      ]);
      const error = yield* extractUiBundle({
        zipBytes: zip,
        manifest: manifestFor(zip),
        stagingDir: path.join(base, "staging", "v"),
        finalDir,
      }).pipe(Effect.flip);
      assert.strictEqual(error.reason, "compat-mismatch");
      assert.strictEqual(yield* fs.readFileString(path.join(finalDir, "index.html")), "old");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("leaves the previous bundle intact when the final rename fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const base = yield* fs.makeTempDirectoryScoped({ prefix: "ui-bundle-extract-test-" });
      const finalDir = path.join(base, "v");
      yield* fs.makeDirectory(finalDir);
      yield* fs.writeFileString(path.join(finalDir, "index.html"), "old");
      const zip = buildZip(validFiles);
      // Fails only the rename that publishes the new bundle; parking and restoring the old one succeed.
      const failingPublish = {
        ...fs,
        rename: (from: string, to: string) =>
          to === finalDir && path.dirname(from) === path.join(base, "staging")
            ? fs.rename(path.join(base, "does-not-exist"), to)
            : fs.rename(from, to),
      };
      const error = yield* extractUiBundle({
        zipBytes: zip,
        manifest: manifestFor(zip),
        stagingDir: path.join(base, "staging", "v"),
        finalDir,
      }).pipe(Effect.provideService(FileSystem.FileSystem, failingPublish), Effect.flip);
      assert.strictEqual(error.reason, "io");
      assert.strictEqual(yield* fs.readFileString(path.join(finalDir, "index.html")), "old");
      assert.deepStrictEqual(yield* fs.readDirectory(path.join(base, "staging")), []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("leaves no parked copy behind after replacing a bundle", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const base = yield* fs.makeTempDirectoryScoped({ prefix: "ui-bundle-extract-test-" });
      const finalDir = path.join(base, "v");
      yield* fs.makeDirectory(finalDir);
      const zip = buildZip(validFiles);
      yield* extractUiBundle({
        zipBytes: zip,
        manifest: manifestFor(zip),
        stagingDir: path.join(base, "staging", "v"),
        finalDir,
      });
      assert.deepStrictEqual(yield* fs.readDirectory(path.join(base, "trash")), []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  describe("integrity", () => {
    it.live("rejects a size mismatch", () =>
      expectRejected(buildZip(validFiles), "size-mismatch", {
        size: buildZip(validFiles).length + 1,
      }),
    );

    it.live("rejects a sha256 mismatch", () =>
      expectRejected(buildZip(validFiles), "hash-mismatch", { sha256: "0".repeat(64) }),
    );

    it.live("checks the hash before parsing, so a tampered non-zip is a hash mismatch", () => {
      const garbage = Buffer.from("this is not a zip file at all");
      return expectRejected(garbage, "hash-mismatch", { sha256: "0".repeat(64) });
    });

    it.live("rejects bytes that match the manifest but are not a zip", () =>
      expectRejected(Buffer.from("this is not a zip file at all"), "invalid-archive"),
    );

    it.live("accepts an upper-case sha256 in the manifest", () =>
      Effect.gen(function* () {
        const zip = buildZip(validFiles);
        const result = yield* extract(zip, {
          sha256: NodeCrypto.createHash("sha256").update(zip).digest("hex").toUpperCase(),
        });
        assert.isUndefined(result.error);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  });

  describe("unsafe entries", () => {
    it.live.each([
      { label: "parent traversal", name: "../evil.txt" },
      { label: "nested traversal", name: "a/../../evil.txt" },
      { label: "absolute path", name: "/abs/evil.txt" },
      { label: "backslash traversal", name: "a\\..\\evil.txt" },
      { label: "drive letter", name: "C:evil.txt" },
      { label: "NUL byte", name: "evil\0.txt" },
      { label: "dot-only segment", name: "a/.../evil.txt" },
      { label: "trailing dot", name: "evil.txt." },
      { label: "trailing space", name: "dir /evil.txt" },
      { label: "Windows device name", name: "CON" },
      { label: "Windows device name with extension", name: "assets/nul.txt" },
      { label: "lower-case numbered device", name: "com1.js" },
      { label: "upper-case numbered device", name: "LPT9" },
    ])("rejects $label and leaves nothing behind", ({ name }) =>
      Effect.gen(function* () {
        const zip = buildZip([...validFiles, { name, data: "pwned" }]);
        yield* expectRejected(zip, "unsafe-entry");
        yield* expectNothingLeft(zip);
        const result = yield* extract(zip);
        assert.isFalse(yield* result.exists(`${result.base}/evil.txt`));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );

    it.live("rejects a symlink entry", () =>
      expectRejected(
        buildZip([...validFiles, { name: "link", data: "/etc/passwd", mode: 0o120777 }]),
        "unsafe-entry",
      ),
    );

    it.live("rejects a duplicate file entry", () =>
      expectRejected(
        buildZip([...validFiles, { name: "assets/app.js", data: "second" }]),
        "unsafe-entry",
      ),
    );
  });

  describe("size bounds", () => {
    it.live("rejects more than 8192 entries", () =>
      expectRejected(
        buildZip([
          ...validFiles,
          ...Array.from({ length: 8192 }, (_, index) => ({ name: `f/${index}`, data: "" })),
        ]),
        "too-large",
      ),
    );

    it.live("rejects a single entry over 50 MB", () => {
      const zip = buildZip([...validFiles, { name: "big.bin", data: 50 * MB + 1 }]);
      return Effect.gen(function* () {
        yield* expectRejected(zip, "too-large");
        yield* expectNothingLeft(zip);
      });
    });

    it.live("rejects a bundle whose entries total over 300 MB", () => {
      const zip = buildZip([
        ...validFiles,
        ...Array.from({ length: 7 }, (_, index) => ({ name: `chunk-${index}.bin`, data: 45 * MB })),
      ]);
      return Effect.gen(function* () {
        yield* expectRejected(zip, "too-large");
        yield* expectNothingLeft(zip);
      });
    });

    it.live("rejects an entry whose header understates its real size", () => {
      const zip = buildZip([...validFiles, { name: "bomb.bin", data: 4 * MB, declaredSize: 10 }]);
      return Effect.gen(function* () {
        yield* expectRejected(zip, "invalid-archive");
        yield* expectNothingLeft(zip);
      });
    });
  });

  describe("required files", () => {
    it.live("rejects a bundle without index.html", () =>
      expectRejected(
        buildZip([{ name: "assets/app.js", data: "x" }, compatFile()]),
        "missing-index",
      ),
    );

    it.live("does not accept a directory named index.html", () =>
      expectRejected(buildZip([{ name: "index.html/", data: "" }, compatFile()]), "missing-index"),
    );

    it.live("rejects a bundle without ui-compat.json", () =>
      expectRejected(buildZip([{ name: "index.html", data: "x" }]), "compat-mismatch"),
    );

    it.live("rejects a ui-compat.json that is not valid", () =>
      expectRejected(
        buildZip([
          { name: "index.html", data: "x" },
          { name: "ui-compat.json", data: "{not json" },
        ]),
        "compat-mismatch",
      ),
    );

    it.live("rejects an inner contractsHash that differs from the manifest", () =>
      expectRejected(
        buildZip([{ name: "index.html", data: "x" }, compatFile({ contractsHash: "hash-b" })]),
        "compat-mismatch",
      ),
    );

    it.live("rejects an inner versionCore that differs from the manifest", () =>
      expectRejected(
        buildZip([{ name: "index.html", data: "x" }, compatFile({ versionCore: "9.9.9" })]),
        "compat-mismatch",
      ),
    );
  });
});
