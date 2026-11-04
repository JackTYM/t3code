// @effect-diagnostics nodeBuiltinImport:off - Effect has no incremental digest; node:stream is type-only, to adapt a Node Readable.
import * as EffectNodeStream from "@effect/platform-node/NodeStream";
import type { UiBundleManifest } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { isWindowsRenameLock } from "@t3tools/shared/atomicWrite";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeCrypto from "node:crypto";
import type * as NodeStream from "node:stream";
import * as Yauzl from "yauzl";

const MAX_ENTRIES = 8192;
const MAX_ENTRY_BYTES = 50 * 1024 * 1024;
// The real web client is ~208 MB unzipped. This only bounds a zip bomb, it is not a size budget, so keep ample headroom over the shipped client.
const MAX_TOTAL_BYTES = 600 * 1024 * 1024;
const MAX_COMPAT_BYTES = 64 * 1024;
// A previous bundle is parked here, next to the published bundles, while its replacement is renamed in.
export const UI_BUNDLE_TRASH_DIR = "trash";
const LOCKED_RENAME_RETRIES = 20;
const LOCKED_RENAME_RETRY_DELAY = "100 millis";

export class UiBundleExtractError extends Schema.TaggedError<UiBundleExtractError>()(
  "UiBundleExtractError",
  {
    reason: Schema.Literals([
      "hash-mismatch",
      "size-mismatch",
      "unsafe-entry",
      "too-large",
      "missing-index",
      "compat-mismatch",
      "invalid-archive",
      "io",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "hash-mismatch":
        return "The UI bundle failed its SHA-256 check.";
      case "size-mismatch":
        return "The UI bundle is not the size its manifest declares.";
      case "unsafe-entry":
        return "The UI bundle contains an unsafe archive entry.";
      case "too-large":
        return "The UI bundle exceeds the allowed size or entry count.";
      case "missing-index":
        return "The UI bundle has no index.html.";
      case "compat-mismatch":
        return "The UI bundle's compatibility file does not match its manifest.";
      case "invalid-archive":
        return "The UI bundle is not a readable zip archive.";
      case "io":
        return "Could not write the UI bundle to disk.";
    }
  }
}

const InnerCompat = Schema.fromJsonString(
  Schema.Struct({ contractsHash: Schema.String, versionCore: Schema.String }),
);
const decodeInnerCompat = Schema.decodeUnknownEffect(InnerCompat);

const invalidArchive = (cause: unknown) =>
  new UiBundleExtractError({ reason: "invalid-archive", cause });

// Windows resolves these names, with or without an extension, to devices instead of files.
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9]|lpt[1-9])$/iu;

const isUnsafeSegment = (segment: string) =>
  // Windows drops trailing dots and spaces, so "a." and "a" would be the same file there.
  /^\.+$/u.test(segment) ||
  /[. ]$/u.test(segment) ||
  WINDOWS_DEVICE_NAME.test((segment.split(".")[0] ?? "").trimEnd());

/** Relative POSIX path inside the bundle, or null when the name could escape or confuse the root. */
const toSafePath = (name: string): string | null => {
  if (name.length === 0 || name.startsWith("/") || /[\\:\0]/u.test(name)) return null;
  // "." and empty segments (a//b, ./a) are harmless; collapse them. Every other segment must be safe on every OS.
  const segments = name.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.some(isUnsafeSegment)) return null;
  return segments.join("/") || ".";
};

const openZip = (bytes: Uint8Array) =>
  Effect.acquireRelease(
    Effect.callback<Yauzl.ZipFile, UiBundleExtractError>((resume) => {
      Yauzl.fromBuffer(
        Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        // yauzl rejects bad names itself, but only as an untyped error when it decodes them. Taking
        // raw names lets toSafePath report them as unsafe-entry.
        { lazyEntries: true, validateEntrySizes: true, decodeStrings: false },
        (cause, zip) =>
          resume(cause || !zip ? Effect.fail(invalidArchive(cause)) : Effect.succeed(zip)),
      );
    }),
    (zip) => Effect.sync(() => zip.close()),
  );

const nextEntry = (zip: Yauzl.ZipFile) =>
  Effect.callback<Yauzl.Entry | null, UiBundleExtractError>((resume) => {
    const cleanup = () => {
      zip.removeListener("entry", onEntry);
      zip.removeListener("end", onEnd);
      zip.removeListener("error", onError);
    };
    const onEntry = (entry: Yauzl.Entry) => {
      cleanup();
      resume(Effect.succeed(entry));
    };
    const onEnd = () => {
      cleanup();
      resume(Effect.succeed(null));
    };
    const onError = (cause: unknown) => {
      cleanup();
      resume(Effect.fail(invalidArchive(cause)));
    };
    zip.once("entry", onEntry);
    zip.once("end", onEnd);
    zip.once("error", onError);
    zip.readEntry();
    return Effect.sync(cleanup);
  });

const openEntryStream = (zip: Yauzl.ZipFile, entry: Yauzl.Entry) =>
  Effect.acquireRelease(
    Effect.callback<NodeStream.Readable, UiBundleExtractError>((resume) => {
      zip.openReadStream(entry, (cause, readable) =>
        resume(cause || !readable ? Effect.fail(invalidArchive(cause)) : Effect.succeed(readable)),
      );
    }),
    (readable) => Effect.sync(() => readable.destroy()),
  );

/** Windows open-file locks make renames fail transiently; retry only there, and only for those codes. */
const renameWithRetry = Effect.fn("renameWithRetry")(function* (from: string, to: string) {
  const fs = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const rename = fs.rename(from, to);
  if (platform !== "win32") return yield* rename;
  return yield* rename.pipe(
    Effect.retry({
      while: isWindowsRenameLock,
      schedule: Schedule.spaced(LOCKED_RENAME_RETRY_DELAY),
      times: LOCKED_RENAME_RETRIES,
    }),
  );
});

/**
 * Verifies the zip against its manifest, extracts it into a private directory derived from
 * `stagingDir`, and renames it to `finalDir`, parking any existing bundle under `trash/` and
 * restoring it if the rename fails. Callers serialize extractions that share a `finalDir`.
 */
export const extractUiBundle = Effect.fn("extractUiBundle")(
  function* (input: {
    readonly zipBytes: Uint8Array;
    readonly manifest: UiBundleManifest;
    readonly stagingDir: string;
    readonly finalDir: string;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { manifest, finalDir } = input;
    // Unique per call so two extractions of one version can never write into the same directory.
    const stagingDir = `${input.stagingDir}.${NodeCrypto.randomUUID()}`;

    // Cheap integrity checks come first so a tampered or truncated download never reaches the zip parser.
    if (input.zipBytes.byteLength !== manifest.size) {
      return yield* new UiBundleExtractError({ reason: "size-mismatch" });
    }
    const digest = NodeCrypto.createHash("sha256").update(input.zipBytes).digest("hex");
    if (digest !== manifest.sha256.toLowerCase()) {
      return yield* new UiBundleExtractError({ reason: "hash-mismatch" });
    }

    const stagingRoot = path.resolve(stagingDir);
    yield* Effect.gen(function* () {
      yield* fs.remove(stagingDir, { recursive: true, force: true });
      yield* fs.makeDirectory(stagingDir, { recursive: true });

      const files = new Set<string>();
      let totalBytes = 0;
      yield* Effect.gen(function* () {
        const zip = yield* openZip(input.zipBytes);
        if (zip.entryCount > MAX_ENTRIES) {
          return yield* new UiBundleExtractError({ reason: "too-large" });
        }
        for (;;) {
          const entry = yield* nextEntry(zip);
          if (entry === null) break;

          // With decodeStrings off this is a Buffer at runtime although yauzl types it as a string.
          const name = Buffer.from(entry.fileName).toString("utf8");
          const relative = toSafePath(name);
          const unixType = (entry.externalFileAttributes >>> 16) & 0o170000;
          const isDirectory = name.endsWith("/");
          if (
            relative === null ||
            (entry.generalPurposeBitFlag & 1) !== 0 ||
            // 0 means the archiver recorded no unix mode (e.g. Windows); anything but a regular file or directory is a link or device.
            (unixType !== 0 && unixType !== 0o100000 && unixType !== 0o040000) ||
            (!isDirectory && (unixType === 0o040000 || files.has(relative)))
          ) {
            return yield* new UiBundleExtractError({ reason: "unsafe-entry" });
          }
          if (relative === ".") continue;

          const destination = path.join(stagingRoot, ...relative.split("/"));
          if (!destination.startsWith(stagingRoot + path.sep)) {
            return yield* new UiBundleExtractError({ reason: "unsafe-entry" });
          }
          if (isDirectory) {
            yield* fs.makeDirectory(destination, { recursive: true });
            continue;
          }
          if (entry.uncompressedSize > MAX_ENTRY_BYTES) {
            return yield* new UiBundleExtractError({ reason: "too-large" });
          }
          files.add(relative);
          yield* fs.makeDirectory(path.dirname(destination), { recursive: true });

          // Header sizes are attacker-controlled, so the caps are enforced on bytes actually produced.
          let entryBytes = 0;
          yield* Effect.gen(function* () {
            const readable = yield* openEntryStream(zip, entry);
            yield* EffectNodeStream.fromReadable<Uint8Array, UiBundleExtractError>({
              evaluate: () => readable,
              onError: invalidArchive,
            }).pipe(
              Stream.tap((chunk) => {
                entryBytes += chunk.byteLength;
                totalBytes += chunk.byteLength;
                return entryBytes > MAX_ENTRY_BYTES || totalBytes > MAX_TOTAL_BYTES
                  ? Effect.fail(new UiBundleExtractError({ reason: "too-large" }))
                  : Effect.void;
              }),
              Stream.run(fs.sink(destination, { flag: "wx" })),
            );
          }).pipe(Effect.scoped);
        }
      }).pipe(Effect.scoped);

      if (!files.has("index.html")) {
        return yield* new UiBundleExtractError({ reason: "missing-index" });
      }
      const innerCompat = yield* Effect.gen(function* () {
        if (!files.has("ui-compat.json")) return null;
        const compatPath = path.join(stagingRoot, "ui-compat.json");
        const info = yield* fs.stat(compatPath);
        if (info.size > BigInt(MAX_COMPAT_BYTES)) return null;
        return yield* fs
          .readFileString(compatPath)
          .pipe(
            Effect.flatMap(decodeInnerCompat),
            Effect.catchTags({ SchemaError: () => Effect.succeed(null) }),
          );
      });
      if (
        innerCompat === null ||
        innerCompat.contractsHash !== manifest.contractsHash ||
        innerCompat.versionCore !== manifest.versionCore
      ) {
        return yield* new UiBundleExtractError({ reason: "compat-mismatch" });
      }

      yield* fs.makeDirectory(path.dirname(finalDir), { recursive: true });
      const hadPrevious = yield* fs.exists(finalDir);
      const parked = path.join(
        path.dirname(finalDir),
        UI_BUNDLE_TRASH_DIR,
        NodeCrypto.randomUUID(),
      );
      if (hadPrevious) {
        yield* fs.makeDirectory(path.dirname(parked), { recursive: true });
        yield* renameWithRetry(finalDir, parked);
      }
      yield* renameWithRetry(stagingDir, finalDir).pipe(
        Effect.onError(() =>
          hadPrevious ? renameWithRetry(parked, finalDir).pipe(Effect.ignore) : Effect.void,
        ),
      );
      if (hadPrevious) {
        yield* fs
          .remove(parked, { recursive: true, force: true })
          .pipe(Effect.ignore({ log: true }));
      }
    }).pipe(
      Effect.onError(() =>
        fs.remove(stagingDir, { recursive: true, force: true }).pipe(Effect.ignore),
      ),
    );
  },
  Effect.catchTags({
    PlatformError: (cause) => Effect.fail(new UiBundleExtractError({ reason: "io", cause })),
  }),
);
