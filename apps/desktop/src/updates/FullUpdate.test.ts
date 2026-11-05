// @effect-diagnostics nodeBuiltinImport:off -- The download tests serve known bytes from a loopback node:http server.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import {
  downloadInstaller,
  FullUpdateDownloadError,
  parseCodesignOutput,
  resolveInstallerUrl,
  selectInstallerFile,
  type FullUpdateFile,
} from "./FullUpdate.ts";

const file = (url: string): FullUpdateFile => ({ url, sha512: "AAAA" });

describe("selectInstallerFile", () => {
  it("ignores everything but .dmg files, including blockmaps", () => {
    const files = [
      file("T3-Code-1.0.0-arm64.zip"),
      file("T3-Code-1.0.0-arm64.dmg.blockmap"),
      file("T3-Code-1.0.0-arm64.DMG"),
    ];
    assert.deepStrictEqual(
      Option.map(selectInstallerFile(files, "arm64"), (picked) => picked.url),
      Option.some("T3-Code-1.0.0-arm64.DMG"),
    );
    assert.isTrue(Option.isNone(selectInstallerFile(files.slice(0, 2), "arm64")));
  });

  it("prefers the file named for the arch when several dmgs exist", () => {
    const files = [file("T3-Code-1.0.0-x64.dmg"), file("T3-Code-1.0.0-arm64.dmg")];
    const urlFor = (arch: "arm64" | "x64") =>
      Option.map(selectInstallerFile(files, arch), (picked) => picked.url);
    assert.deepStrictEqual(urlFor("arm64"), Option.some("T3-Code-1.0.0-arm64.dmg"));
    assert.deepStrictEqual(urlFor("x64"), Option.some("T3-Code-1.0.0-x64.dmg"));
  });

  it("accepts x86_64 and amd64 as x64 and universal as both", () => {
    const urlFor = (files: ReadonlyArray<FullUpdateFile>, arch: "arm64" | "x64") =>
      Option.map(selectInstallerFile(files, arch), (picked) => picked.url);
    const intel = [file("App-x86_64.dmg"), file("App-arm64.dmg")];
    assert.deepStrictEqual(urlFor(intel, "x64"), Option.some("App-x86_64.dmg"));
    const amd = [file("App-amd64.dmg"), file("App-arm64.dmg")];
    assert.deepStrictEqual(urlFor(amd, "x64"), Option.some("App-amd64.dmg"));
    const universal = [file("App-universal.dmg"), file("App-other.dmg")];
    assert.deepStrictEqual(urlFor(universal, "arm64"), Option.some("App-universal.dmg"));
    assert.deepStrictEqual(urlFor(universal, "x64"), Option.some("App-universal.dmg"));
  });

  it("takes a lone dmg whatever its name, and none when several are ambiguous", () => {
    assert.isTrue(Option.isSome(selectInstallerFile([file("App.dmg")], "arm64")));
    assert.isTrue(Option.isNone(selectInstallerFile([file("A.dmg"), file("B.dmg")], "x64")));
    assert.isTrue(Option.isNone(selectInstallerFile([], "arm64")));
  });
});

describe("resolveInstallerUrl", () => {
  const resolve = (
    url: string,
    overrides: Partial<Parameters<typeof resolveInstallerUrl>[0]> = {},
  ) =>
    resolveInstallerUrl({
      file: file(url),
      owner: "pingdotgg",
      repo: "t3code",
      version: "1.2.3",
      ...overrides,
    }).pipe(Option.map((resolved) => resolved.href));

  it("resolves a relative file name against the release download path", () => {
    assert.deepStrictEqual(
      resolve("T3-Code-1.2.3-arm64.dmg"),
      Option.some(
        "https://github.com/pingdotgg/t3code/releases/download/v1.2.3/T3-Code-1.2.3-arm64.dmg",
      ),
    );
  });

  it("encodes the file name as a single path segment", () => {
    assert.deepStrictEqual(
      resolve("T3 Code#1.dmg"),
      Option.some("https://github.com/pingdotgg/t3code/releases/download/v1.2.3/T3%20Code%231.dmg"),
    );
  });

  it("accepts an absolute https url and rejects other schemes", () => {
    assert.deepStrictEqual(
      resolve("https://cdn.example.com/a/App.dmg"),
      Option.some("https://cdn.example.com/a/App.dmg"),
    );
    for (const url of [
      "http://cdn.example.com/App.dmg",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "ftp://cdn.example.com/App.dmg",
      "//cdn.example.com/App.dmg",
      "https://user:pass@cdn.example.com/App.dmg",
    ]) {
      assert.isTrue(Option.isNone(resolve(url)), url);
    }
  });

  it("rejects path traversal and nested relative paths", () => {
    for (const url of [
      "../App.dmg",
      "..",
      "a/../App.dmg",
      "%2e%2e/App.dmg",
      "sub/App.dmg",
      "sub\\App.dmg",
      "https://cdn.example.com/a/../App.dmg",
      "",
    ]) {
      assert.isTrue(Option.isNone(resolve(url)), url);
    }
  });

  it("rejects an owner, repo, or version that could change the path", () => {
    for (const overrides of [
      { owner: "a/b" },
      { owner: ".." },
      { owner: "" },
      { repo: "t3code/../x" },
      { repo: ".." },
      { repo: "re po" },
      { version: "1/../2" },
      { version: "" },
    ]) {
      assert.isTrue(Option.isNone(resolve("App.dmg", overrides)), JSON.stringify(overrides));
    }
  });
});

describe("parseCodesignOutput", () => {
  const adhoc = `Executable=/Applications/T3 Code.app/Contents/MacOS/T3 Code
Identifier=com.t3tools.t3code
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20400 size=1234 flags=0x20002(adhoc,linker-signed) hashes=30+7 location=embedded
Signature=adhoc
Info.plist entries=30
TeamIdentifier=not set
Sealed Resources version=2 rules=13 files=120
Internal requirements count=0 size=12
`;
  const developerId = `Executable=/Applications/T3 Code.app/Contents/MacOS/T3 Code
Identifier=com.t3tools.t3code
Format=app bundle with Mach-O universal (x86_64 arm64)
CodeDirectory v=20500 size=5678 flags=0x10000(runtime) hashes=170+7 location=embedded
Signature size=9012
Authority=Developer ID Application: T3 Tools Inc (ABCDE12345)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
Timestamp=Nov 5, 2026 at 10:00:00 AM
TeamIdentifier=ABCDE12345
`;
  const appleDevelopment = `Executable=/Users/dev/Build/T3 Code.app/Contents/MacOS/T3 Code
Identifier=com.t3tools.t3code
CodeDirectory v=20400 size=1234 flags=0x0(none) hashes=30+7 location=embedded
Signature size=4800
Authority=Apple Development: dev@example.com (XYZ987654)
Authority=Apple Worldwide Developer Relations Certification Authority
Authority=Apple Root CA
TeamIdentifier=ABCDE12345
`;

  it("is true only for a Developer ID Application authority", () => {
    assert.isTrue(parseCodesignOutput(developerId));
    assert.isFalse(parseCodesignOutput(adhoc));
    assert.isFalse(parseCodesignOutput(appleDevelopment));
    assert.isFalse(parseCodesignOutput("code object is not signed at all"));
    assert.isFalse(parseCodesignOutput(""));
  });

  it("ignores the phrase when it is not an Authority line", () => {
    assert.isFalse(parseCodesignOutput("Identifier=Authority=Developer ID Application: x"));
  });
});

const BODY = NodeCrypto.randomBytes(300_000);
const sha512Of = (bytes: Uint8Array) =>
  NodeCrypto.createHash("sha512").update(bytes).digest("base64");

const serveBytes = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{ readonly origin: string; readonly server: NodeHttp.Server }>((resolve) => {
        const server = NodeHttp.createServer((request, response) => {
          if (request.url === "/redirect") {
            response.writeHead(302, { location: "/asset" }).end();
          } else if (request.url === "/asset") {
            response.writeHead(200, { "content-length": BODY.byteLength });
            for (let offset = 0; offset < BODY.byteLength; offset += 50_000) {
              response.write(BODY.subarray(offset, offset + 50_000));
            }
            response.end();
          } else {
            response.writeHead(404).end("missing");
          }
        });
        server.listen(0, "127.0.0.1", () => {
          resolve({
            origin: `http://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}`,
            server,
          });
        });
      }),
  ),
  ({ server }) =>
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
);

const withDownload = <A, E>(
  run: (context: {
    readonly origin: string;
    readonly destination: string;
    readonly fs: FileSystem.FileSystem;
  }) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { origin } = yield* serveBytes;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "full-update-test-" });
      const destination = path.join(directory, "nested", "Installer.dmg");
      return yield* run({ origin, destination, fs });
    }),
  ).pipe(Effect.provide(NodeServices.layer));

describe("downloadInstaller", () => {
  const noneLeft = (fs: FileSystem.FileSystem, destination: string) =>
    Effect.gen(function* () {
      assert.isFalse(yield* fs.exists(destination));
      assert.isFalse(yield* fs.exists(`${destination}.part`));
    });

  const isDownloadError = Schema.is(FullUpdateDownloadError);

  const failureOf = <A>(exit: Exit.Exit<A, FullUpdateDownloadError>) => {
    assert.isTrue(Exit.isFailure(exit));
    const error = Exit.isFailure(exit) ? exit.cause.reasons : [];
    return error
      .map((reason) => ("error" in reason ? reason.error : undefined))
      .find((value) => isDownloadError(value));
  };

  it.effect("writes the verified file and reports progress up to 100", () =>
    withDownload(({ origin, destination, fs }) =>
      Effect.gen(function* () {
        const percents: Array<number> = [];
        yield* downloadInstaller({
          url: `${origin}/asset`,
          destination,
          sha512: sha512Of(BODY),
          size: BODY.byteLength,
          onProgress: (percent) => Effect.sync(() => void percents.push(percent)),
        });
        assert.deepStrictEqual(Buffer.from(yield* fs.readFile(destination)), BODY);
        assert.isFalse(yield* fs.exists(`${destination}.part`));
        assert.strictEqual(percents.at(-1), 100);
        assert.deepStrictEqual(
          percents,
          [...new Set(percents)].toSorted((a, b) => a - b),
        );
        assert.isTrue(percents.every((percent) => Number.isInteger(percent)));
      }),
    ),
  );

  it.effect("follows a redirect to the asset", () =>
    withDownload(({ origin, destination, fs }) =>
      Effect.gen(function* () {
        yield* downloadInstaller({
          url: `${origin}/redirect`,
          destination,
          sha512: sha512Of(BODY),
          onProgress: () => Effect.void,
        });
        assert.strictEqual((yield* fs.readFile(destination)).byteLength, BODY.byteLength);
      }),
    ),
  );

  it.effect("fails on a wrong sha512 and leaves no files behind", () =>
    withDownload(({ origin, destination, fs }) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          downloadInstaller({
            url: `${origin}/asset`,
            destination,
            sha512: sha512Of(Buffer.from("other bytes")),
            size: BODY.byteLength,
            onProgress: () => Effect.void,
          }),
        );
        assert.strictEqual(failureOf(exit)?.reason, "hash-mismatch");
        yield* noneLeft(fs, destination);
      }),
    ),
  );

  it.effect("fails on a size mismatch and leaves no files behind", () =>
    withDownload(({ origin, destination, fs }) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          downloadInstaller({
            url: `${origin}/asset`,
            destination,
            sha512: sha512Of(BODY),
            size: BODY.byteLength + 1,
            onProgress: () => Effect.void,
          }),
        );
        assert.strictEqual(failureOf(exit)?.reason, "size-mismatch");
        yield* noneLeft(fs, destination);
      }),
    ),
  );

  it.effect("fails on a 404 and leaves no files behind", () =>
    withDownload(({ origin, destination, fs }) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          downloadInstaller({
            url: `${origin}/nope`,
            destination,
            sha512: sha512Of(BODY),
            onProgress: () => Effect.void,
          }),
        );
        assert.strictEqual(failureOf(exit)?.reason, "http-status");
        yield* noneLeft(fs, destination);
      }),
    ),
  );

  it.effect("fails with a network error when the server is unreachable", () =>
    withDownload(({ destination, fs }) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          downloadInstaller({
            url: "http://127.0.0.1:1/asset",
            destination,
            sha512: sha512Of(BODY),
            onProgress: () => Effect.void,
          }),
        );
        assert.strictEqual(failureOf(exit)?.reason, "network");
        yield* noneLeft(fs, destination);
      }),
    ),
  );
});
