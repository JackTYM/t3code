// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - plain Node release script that hashes a zip and prints ui-bundle.json; no Effect runtime.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import type { UiBundleManifest } from "@t3tools/contracts";

export function buildUiBundleManifest(input: {
  readonly clientDir: string;
  readonly zipPath: string;
  readonly version: string;
  readonly sha: string;
}): UiBundleManifest {
  const compat = JSON.parse(
    NodeFS.readFileSync(NodePath.join(input.clientDir, "ui-compat.json"), "utf8"),
  ) as { versionCore: string; contractsHash: string; version: string };
  // The server compares the manifest against what the client reports about itself, so the two
  // must name the same build; a mismatch means the zip was cut from a different build.
  if (compat.version !== input.version) {
    throw new Error(
      `ui-compat.json says version ${compat.version} but the release version is ${input.version}.`,
    );
  }
  const bytes = NodeFS.readFileSync(input.zipPath);
  return {
    schema: 1,
    version: input.version,
    versionCore: compat.versionCore,
    contractsHash: compat.contractsHash,
    sha: input.sha,
    sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
    assetName: NodePath.basename(input.zipPath),
  };
}

/** Usage: node scripts/make-ui-bundle-manifest.ts --client-dir <dir> --zip <file> --version <v> --sha <sha>  (JSON on stdout) */
if (import.meta.main) {
  const { values } = NodeUtil.parseArgs({
    options: {
      "client-dir": { type: "string" },
      zip: { type: "string" },
      version: { type: "string" },
      sha: { type: "string" },
    },
  });
  const clientDir = values["client-dir"];
  const zipPath = values.zip;
  const version = values.version;
  const sha = values.sha;
  if (!clientDir || !zipPath || !version || !sha) {
    throw new Error(
      "usage: make-ui-bundle-manifest.ts --client-dir <dir> --zip <file> --version <v> --sha <sha>",
    );
  }
  console.log(JSON.stringify(buildUiBundleManifest({ clientDir, zipPath, version, sha }), null, 2));
}
