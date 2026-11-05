// @effect-diagnostics nodeBuiltinImport:off - plain Node release script; the test builds a temp expo export dir.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { buildOtaManifest } from "./make-ota-manifest.ts";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) NodeFS.rmSync(root, { recursive: true, force: true });
});

const md5 = (bytes: Uint8Array) => NodeCrypto.createHash("md5").update(bytes).digest("hex");
const sha256b64url = (bytes: Uint8Array) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("base64url");

const BUNDLE_PATH = "_expo/static/js/ios/entry-abc.hbc";
const ICON = Buffer.from("png-bytes");
const FONT = Buffer.from("font-bytes");

function fixture(bundle = "hermes bytecode v1") {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ota-manifest-"));
  roots.push(root);
  const dist = NodePath.join(root, "dist");
  const write = (relativePath: string, bytes: string | Buffer) => {
    const file = NodePath.join(dist, relativePath);
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    NodeFS.writeFileSync(file, bytes);
  };
  write(BUNDLE_PATH, bundle);
  write("assets/hash-icon", ICON);
  write("assets/hash-font", FONT);
  const metadata = {
    version: 0,
    bundler: "metro",
    fileMetadata: {
      ios: {
        bundle: BUNDLE_PATH,
        assets: [
          { path: "assets/hash-icon", ext: "png" },
          { path: "assets/hash-font", ext: "ttf" },
          { path: "assets/hash-icon", ext: "png" },
        ],
      },
    },
  };
  write("metadata.json", JSON.stringify(metadata));
  const readFile = (relativePath: string) => {
    const file = NodePath.join(dist, relativePath);
    return NodeFS.existsSync(file) ? NodeFS.readFileSync(file) : undefined;
  };
  return { root, dist, metadata, readFile, write };
}

const baseInput = {
  expoConfig: { name: "T3", extra: { eas: { projectId: "p" } } },
  runtimeVersion: "1.2.3",
  baseUrl: "https://example.github.io/ota",
  createdAt: "2026-11-05T00:00:00.000Z",
};

describe("buildOtaManifest", () => {
  it("describes the bundle and assets with content-addressed names, keys and hashes", () => {
    const { metadata, readFile } = fixture();
    const { manifest, files } = buildOtaManifest({ ...baseInput, metadata, readFile });
    const bundle = Buffer.from("hermes bytecode v1");

    expect(manifest.launchAsset).toEqual({
      key: md5(bundle),
      contentType: "application/javascript",
      url: `https://example.github.io/ota/assets/${md5(bundle)}.hbc`,
      hash: sha256b64url(bundle),
      fileExtension: ".hbc",
    });
    expect(manifest.assets).toEqual([
      {
        key: md5(ICON),
        contentType: "image/png",
        url: `https://example.github.io/ota/assets/${md5(ICON)}.png`,
        hash: sha256b64url(ICON),
        fileExtension: ".png",
      },
      {
        key: md5(FONT),
        contentType: "font/ttf",
        url: `https://example.github.io/ota/assets/${md5(FONT)}.ttf`,
        hash: sha256b64url(FONT),
        fileExtension: ".ttf",
      },
    ]);
    expect(manifest.runtimeVersion).toBe("1.2.3");
    expect(manifest.createdAt).toBe("2026-11-05T00:00:00.000Z");
    expect(manifest.metadata).toEqual({});
    expect(manifest.extra).toEqual({ expoClient: baseInput.expoConfig });
    expect([...files.keys()].toSorted()).toEqual(
      [
        `assets/${md5(bundle)}.hbc`,
        `assets/${md5(ICON)}.png`,
        `assets/${md5(FONT)}.ttf`,
      ].toSorted(),
    );
    expect(Buffer.from(files.get(`assets/${md5(ICON)}.png`)!)).toEqual(ICON);
  });

  it("derives a stable v4-shaped UUID from the bundle bytes", () => {
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const a = fixture();
    const b = fixture();
    const changed = fixture("hermes bytecode v2");
    const idOf = (f: ReturnType<typeof fixture>) =>
      buildOtaManifest({ ...baseInput, metadata: f.metadata, readFile: f.readFile }).manifest.id;

    expect(idOf(a)).toMatch(uuidPattern);
    expect(idOf(a)).toBe(idOf(b));
    expect(idOf(changed)).toMatch(uuidPattern);
    expect(idOf(changed)).not.toBe(idOf(a));
  });

  it("falls back to octet-stream for unknown extensions", () => {
    const { metadata, readFile, write } = fixture();
    write("assets/hash-blob", "x");
    metadata.fileMetadata.ios.assets = [{ path: "assets/hash-blob", ext: "xyz" }];
    const { manifest } = buildOtaManifest({ ...baseInput, metadata, readFile });
    expect(manifest.assets[0]?.contentType).toBe("application/octet-stream");
    expect(manifest.assets[0]?.fileExtension).toBe(".xyz");
  });

  it("strips a trailing slash from the base url", () => {
    const { metadata, readFile } = fixture();
    const { manifest } = buildOtaManifest({
      ...baseInput,
      baseUrl: "https://example.github.io/ota/",
      metadata,
      readFile,
    });
    expect(manifest.launchAsset.url).toMatch(/^https:\/\/example\.github\.io\/ota\/assets\//);
  });

  it("fails clearly on a missing bundle or asset file", () => {
    const missingAsset = fixture();
    NodeFS.rmSync(NodePath.join(missingAsset.dist, "assets/hash-font"));
    expect(() =>
      buildOtaManifest({
        ...baseInput,
        metadata: missingAsset.metadata,
        readFile: missingAsset.readFile,
      }),
    ).toThrow(/missing assets\/hash-font/);

    const missingBundle = fixture();
    NodeFS.rmSync(NodePath.join(missingBundle.dist, BUNDLE_PATH));
    expect(() =>
      buildOtaManifest({
        ...baseInput,
        metadata: missingBundle.metadata,
        readFile: missingBundle.readFile,
      }),
    ).toThrow(/missing _expo\/static\/js\/ios\/entry-abc\.hbc/);
  });

  it("rejects an empty runtime version and a non-https or empty base url", () => {
    const { metadata, readFile } = fixture();
    const build = (override: { runtimeVersion?: string; baseUrl?: string }) => () =>
      buildOtaManifest({ ...baseInput, ...override, metadata, readFile });
    expect(build({ runtimeVersion: "" })).toThrow(/runtime version/);
    expect(build({ baseUrl: "" })).toThrow(/https/);
    expect(build({ baseUrl: "http://example.com/ota" })).toThrow(/https/);
  });

  it("rejects metadata without an ios section", () => {
    const { readFile } = fixture();
    expect(() =>
      buildOtaManifest({ ...baseInput, metadata: { fileMetadata: {} }, readFile }),
    ).toThrow(/fileMetadata\.ios/);
  });
});

describe("make-ota-manifest CLI", () => {
  it("writes ios/manifest.json and the content-addressed assets", () => {
    const { root, dist } = fixture();
    const out = NodePath.join(root, "out");
    const configPath = NodePath.join(root, "expo-config.json");
    NodeFS.writeFileSync(configPath, JSON.stringify(baseInput.expoConfig));

    NodeChildProcess.execFileSync(
      process.execPath,
      [
        NodePath.join(import.meta.dirname, "make-ota-manifest.ts"),
        "--dist",
        dist,
        "--out",
        out,
        "--runtime-version",
        "1.2.3",
        "--base-url",
        "https://example.github.io/ota",
        "--expo-config",
        configPath,
        "--created-at",
        "2026-11-05T00:00:00.000Z",
      ],
      { stdio: "pipe" },
    );

    const manifest = JSON.parse(
      NodeFS.readFileSync(NodePath.join(out, "ios/manifest.json"), "utf8"),
    );
    expect(manifest.createdAt).toBe("2026-11-05T00:00:00.000Z");
    expect(manifest.extra.expoClient).toEqual(baseInput.expoConfig);
    expect(NodeFS.readFileSync(NodePath.join(out, "assets", `${md5(ICON)}.png`))).toEqual(ICON);
    expect(NodeFS.readdirSync(NodePath.join(out, "assets"))).toHaveLength(3);
  });
});
