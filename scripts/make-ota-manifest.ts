// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off - plain Node release script that turns an `expo export` dir into a static Expo Updates tree; no Effect runtime.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".ttc": "font/collection",
  ".json": "application/json",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
};

export interface OtaAsset {
  readonly key: string;
  readonly contentType: string;
  readonly url: string;
  readonly hash: string;
  readonly fileExtension: string;
}

export interface OtaManifest {
  readonly id: string;
  readonly createdAt: string;
  readonly runtimeVersion: string;
  readonly launchAsset: OtaAsset;
  readonly assets: ReadonlyArray<OtaAsset>;
  readonly metadata: Record<string, never>;
  readonly extra: { readonly expoClient: unknown };
}

export interface OtaTree {
  readonly manifest: OtaManifest;
  /** Bytes to publish, keyed by path relative to the output dir (`assets/<key><ext>`). */
  readonly files: ReadonlyMap<string, Uint8Array>;
}

interface IosMetadata {
  readonly bundle: string;
  readonly assets: ReadonlyArray<{ readonly path: string; readonly ext: string }>;
}

// `ext` in metadata.json is `asset.type` without a leading dot, and `path` is the extensionless
// `assets/<metro hash>` file, so the dotted extension has to come from `ext`.
function readIosMetadata(metadata: unknown): IosMetadata {
  const ios = (metadata as { fileMetadata?: { ios?: Partial<IosMetadata> } } | null)?.fileMetadata
    ?.ios;
  if (!ios || typeof ios.bundle !== "string" || !Array.isArray(ios.assets)) {
    throw new Error("metadata.json has no fileMetadata.ios.bundle / fileMetadata.ios.assets.");
  }
  for (const asset of ios.assets) {
    if (typeof asset?.path !== "string" || typeof asset.ext !== "string") {
      throw new Error("metadata.json has an ios asset without a string path and ext.");
    }
  }
  return { bundle: ios.bundle, assets: ios.assets };
}

function uuidFromDigest(digest: Buffer): string {
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function buildOtaManifest(input: {
  /** Parsed `dist/metadata.json`. */
  readonly metadata: unknown;
  readonly expoConfig: unknown;
  readonly runtimeVersion: string;
  readonly baseUrl: string;
  readonly createdAt: string;
  /** Returns the bytes of a path relative to the export dir, or undefined when it does not exist. */
  readonly readFile: (relativePath: string) => Uint8Array | undefined;
}): OtaTree {
  if (!input.runtimeVersion) throw new Error("runtime version must not be empty.");
  const baseUrl = input.baseUrl.replace(/\/+$/, "");
  if (!baseUrl || !baseUrl.startsWith("https://")) {
    throw new Error(`base url must be an https URL, got "${input.baseUrl}".`);
  }
  const ios = readIosMetadata(input.metadata);

  const files = new Map<string, Uint8Array>();
  const describe = (relativePath: string, extension: string, contentType: string) => {
    const bytes = input.readFile(relativePath);
    if (!bytes) throw new Error(`export is missing ${relativePath}.`);
    const key = NodeCrypto.createHash("md5").update(bytes).digest("hex");
    const sha256 = NodeCrypto.createHash("sha256").update(bytes).digest();
    const name = `${key}${extension}`;
    files.set(`assets/${name}`, bytes);
    const asset: OtaAsset = {
      key,
      contentType,
      url: `${baseUrl}/assets/${name}`,
      hash: sha256.toString("base64url"),
      fileExtension: extension,
    };
    return { asset, sha256 };
  };

  const launch = describe(ios.bundle, NodePath.extname(ios.bundle), "application/javascript");

  const assets = new Map<string, OtaAsset>();
  for (const entry of ios.assets) {
    const extension = entry.ext ? `.${entry.ext}` : "";
    const { asset } = describe(
      entry.path,
      extension,
      CONTENT_TYPES[extension.toLowerCase()] ?? "application/octet-stream",
    );
    if (!assets.has(asset.key)) assets.set(asset.key, asset);
  }

  return {
    manifest: {
      id: uuidFromDigest(launch.sha256),
      createdAt: input.createdAt,
      runtimeVersion: input.runtimeVersion,
      launchAsset: launch.asset,
      assets: [...assets.values()],
      metadata: {},
      extra: { expoClient: input.expoConfig },
    },
    files,
  };
}

/** Usage: node scripts/make-ota-manifest.ts --dist <dir> --out <dir> --runtime-version <v> --base-url <https url> --expo-config <file> [--created-at <iso>] */
if (import.meta.main) {
  const { values } = NodeUtil.parseArgs({
    options: {
      dist: { type: "string" },
      out: { type: "string" },
      "runtime-version": { type: "string" },
      "base-url": { type: "string" },
      "expo-config": { type: "string" },
      "created-at": { type: "string" },
    },
  });
  const dist = values.dist;
  const out = values.out;
  const runtimeVersion = values["runtime-version"];
  const baseUrl = values["base-url"];
  const expoConfigPath = values["expo-config"];
  if (!dist || !out || !runtimeVersion || !baseUrl || !expoConfigPath) {
    throw new Error(
      "usage: make-ota-manifest.ts --dist <dir> --out <dir> --runtime-version <v> --base-url <https url> --expo-config <file> [--created-at <iso>]",
    );
  }
  const { manifest, files } = buildOtaManifest({
    metadata: JSON.parse(NodeFS.readFileSync(NodePath.join(dist, "metadata.json"), "utf8")),
    expoConfig: JSON.parse(NodeFS.readFileSync(expoConfigPath, "utf8")),
    runtimeVersion,
    baseUrl,
    createdAt: values["created-at"] ?? new Date().toISOString(),
    readFile: (relativePath) => {
      const file = NodePath.join(dist, relativePath);
      return NodeFS.existsSync(file) ? NodeFS.readFileSync(file) : undefined;
    },
  });
  for (const [relativePath, bytes] of files) {
    const target = NodePath.join(out, relativePath);
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    NodeFS.writeFileSync(target, bytes);
  }
  NodeFS.mkdirSync(NodePath.join(out, "ios"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(out, "ios", "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
}
