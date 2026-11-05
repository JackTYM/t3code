// @effect-diagnostics nodeBuiltinImport:off -- The installer digest is computed incrementally while streaming; no Effect hashing service streams.
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

/** One entry of electron-updater's `UpdateInfo.files`: `url` is relative to the release, `sha512` is base64. */
export interface FullUpdateFile {
  readonly url: string;
  readonly sha512: string;
  readonly size?: number | undefined;
}

export type FullUpdateArch = "arm64" | "x64";

const CODESIGN_TIMEOUT = "10 seconds";
const SAFE_REPO_SEGMENT = /^[A-Za-z0-9._-]+$/;
const SAFE_VERSION = /^[A-Za-z0-9._+-]+$/;
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const PARENT_SEGMENT = /(^|[\\/])\.\.([\\/]|$)/;
const DEVELOPER_ID_AUTHORITY = /^\s*Authority=Developer ID Application/m;

const ARCH_TOKENS: Record<FullUpdateArch, ReadonlyArray<string>> = {
  arm64: ["arm64", "universal"],
  x64: ["x64", "x86_64", "amd64", "universal"],
};

export class FullUpdateDownloadError extends Schema.TaggedError<FullUpdateDownloadError>()(
  "FullUpdateDownloadError",
  {
    reason: Schema.Literals(["http-status", "size-mismatch", "hash-mismatch", "network", "io"]),
    detail: Schema.optionalKey(Schema.String),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    const detail = this.detail === undefined ? "" : `: ${this.detail}`;
    return `Failed to download the update installer (${this.reason}${detail}).`;
  }
}

export class FullUpdateOpenError extends Schema.TaggedError<FullUpdateOpenError>()(
  "FullUpdateOpenError",
  {
    reason: Schema.Literals(["spawn", "exit-code"]),
    exitCode: Schema.optionalKey(Schema.Number),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    const exitCode = this.exitCode === undefined ? "" : `, exit code ${this.exitCode}`;
    return `Failed to open the downloaded update installer (${this.reason}${exitCode}).`;
  }
}

const isFullUpdateDownloadError = Schema.is(FullUpdateDownloadError);

const fileNameOf = (url: string) => {
  const path = url.split(/[?#]/)[0] ?? "";
  return path.slice(path.lastIndexOf("/") + 1).toLowerCase();
};

/**
 * Picks the DMG for `arch`: the arch-named one when several exist, a lone DMG otherwise.
 * `.blockmap` siblings never qualify because only a `.dmg` extension matches.
 */
export function selectInstallerFile(
  files: ReadonlyArray<FullUpdateFile>,
  arch: FullUpdateArch,
): Option.Option<FullUpdateFile> {
  const dmgs = files.filter((file) => fileNameOf(file.url).endsWith(".dmg"));
  if (dmgs.length === 1) return Option.some(dmgs[0]!);
  return Option.fromNullishOr(
    dmgs.find((file) => ARCH_TOKENS[arch].some((token) => fileNameOf(file.url).includes(token))),
  );
}

const hasTraversal = (value: string) => {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // Malformed escapes are checked as written.
  }
  return PARENT_SEGMENT.test(value) || PARENT_SEGMENT.test(decoded);
};

/**
 * Resolves a feed file to its download URL, or none when it is unsafe.
 * A relative `url` is one file name under the GitHub release for `version` (a name containing a
 * path separator is rejected); an absolute `url` must be `https:` without credentials.
 */
export function resolveInstallerUrl(input: {
  readonly file: FullUpdateFile;
  readonly owner: string;
  readonly repo: string;
  readonly version: string;
}): Option.Option<URL> {
  const { file, owner, repo, version } = input;
  const safeSegment = (value: string) => SAFE_REPO_SEGMENT.test(value) && !/^\.+$/.test(value);
  if (!safeSegment(owner) || !safeSegment(repo) || !SAFE_VERSION.test(version)) {
    return Option.none();
  }
  const raw = file.url;
  if (raw.length === 0 || hasTraversal(raw)) return Option.none();

  if (URL_SCHEME.test(raw) || raw.startsWith("//")) {
    const parsed = URL.parse(raw);
    return parsed !== null &&
      parsed.protocol === "https:" &&
      parsed.username === "" &&
      parsed.password === ""
      ? Option.some(parsed)
      : Option.none();
  }

  if (/[\\/]/.test(raw)) return Option.none();
  return Option.fromNullishOr(
    URL.parse(
      `https://github.com/${owner}/${repo}/releases/download/v${version}/${encodeURIComponent(raw)}`,
    ),
  );
}

export interface DownloadInstallerArgs {
  readonly url: string;
  readonly destination: string;
  readonly sha512: string;
  readonly size?: number | undefined;
  readonly onProgress: (percent: number) => Effect.Effect<void>;
}

/**
 * Streams the installer to `${destination}.part`, verifies size and sha512, then renames it into place.
 * Plain fetch and FileSystem only: Electron's `session.downloadURL` can tag files with the macOS
 * quarantine attribute, which makes Gatekeeper reject the unsigned app once it is copied out.
 */
export const downloadInstaller = Effect.fn("desktop.fullUpdate.downloadInstaller")(function* (
  args: DownloadInstallerArgs,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const partPath = `${args.destination}.part`;

  const io = (error: unknown) =>
    new FullUpdateDownloadError({ reason: "io", detail: String(error), cause: error });
  const network = (error: unknown) =>
    new FullUpdateDownloadError({ reason: "network", detail: String(error), cause: error });

  const transfer = Effect.gen(function* () {
    const signal = yield* Effect.abortSignal;
    yield* fs
      .makeDirectory(path.dirname(args.destination), { recursive: true })
      .pipe(Effect.mapError(io));
    const response = yield* Effect.tryPromise({
      // @effect-diagnostics-next-line globalFetchInEffect:off -- HttpClient would add an Electron-agnostic layer for one GET; this must stay plain Node networking.
      try: () => fetch(args.url, { signal }),
      catch: network,
    });
    const body = response.body;
    if (!response.ok || body === null) {
      return yield* new FullUpdateDownloadError({
        reason: response.ok ? "network" : "http-status",
        detail: response.ok ? "empty response body" : `HTTP ${response.status}`,
      });
    }

    const contentLength = Number(response.headers.get("content-length"));
    const total = contentLength > 0 ? contentLength : args.size;
    const hash = NodeCrypto.createHash("sha512");
    let received = 0;
    let lastPercent = -1;

    yield* Stream.fromReadableStream({ evaluate: () => body, onError: network }).pipe(
      Stream.tap((chunk) =>
        Effect.suspend(() => {
          hash.update(chunk);
          received += chunk.byteLength;
          const percent =
            total === undefined ? lastPercent : Math.min(100, Math.floor((received / total) * 100));
          if (percent === lastPercent) return Effect.void;
          lastPercent = percent;
          return args.onProgress(percent);
        }),
      ),
      Stream.run(fs.sink(partPath)),
      Effect.mapError((error) => (isFullUpdateDownloadError(error) ? error : io(error))),
    );

    if (args.size !== undefined && received !== args.size) {
      return yield* new FullUpdateDownloadError({
        reason: "size-mismatch",
        detail: `expected ${args.size} bytes, received ${received}`,
      });
    }
    if (!hash.digest().equals(Buffer.from(args.sha512, "base64"))) {
      return yield* new FullUpdateDownloadError({ reason: "hash-mismatch" });
    }
    yield* fs.rename(partPath, args.destination).pipe(Effect.mapError(io));
  });

  // The scope aborts the fetch on success, failure, and interrupt alike.
  yield* Effect.scoped(transfer).pipe(
    Effect.onExit((exit) =>
      Exit.isSuccess(exit) ? Effect.void : fs.remove(partPath, { force: true }).pipe(Effect.ignore),
    ),
  );
});

/** True when `codesign -dvv` output names a Developer ID Application signing authority. */
export function parseCodesignOutput(output: string): boolean {
  return DEVELOPER_ID_AUTHORITY.test(output);
}

/** False when the bundle is ad-hoc signed, unsigned, or `codesign` could not answer in time. */
export const isDeveloperIdSigned = Effect.fn("desktop.fullUpdate.isDeveloperIdSigned")(function* (
  appBundlePath: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make("/usr/bin/codesign", ["-dvv", appBundlePath], { stdin: "ignore" }),
      );
      const [output, exitCode] = yield* Effect.all(
        [handle.all.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode],
        { concurrency: "unbounded" },
      );
      return exitCode === 0 && parseCodesignOutput(output);
    }),
  ).pipe(
    Effect.timeout(CODESIGN_TIMEOUT),
    Effect.orElseSucceed(() => false),
  );
});

export const openInstaller = Effect.fn("desktop.fullUpdate.openInstaller")(function* (
  dmgPath: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const exitCode = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make("/usr/bin/open", [dmgPath], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }),
      );
      return yield* handle.exitCode;
    }),
  ).pipe(Effect.mapError((cause) => new FullUpdateOpenError({ reason: "spawn", cause })));
  if (exitCode !== 0) {
    return yield* new FullUpdateOpenError({ reason: "exit-code", exitCode });
  }
});
