// @effect-diagnostics nodeBuiltinImport:off - plain Node release script; the test builds a temp client dir and zip.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { UiBundleManifest } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { buildUiBundleManifest } from "./make-ui-bundle-manifest.ts";

const decodeManifest = Schema.decodeSync(UiBundleManifest);

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) NodeFS.rmSync(root, { recursive: true, force: true });
});

function fixture(compatVersion: string) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ui-bundle-manifest-"));
  roots.push(root);
  const clientDir = NodePath.join(root, "client");
  NodeFS.mkdirSync(clientDir);
  NodeFS.writeFileSync(
    NodePath.join(clientDir, "ui-compat.json"),
    JSON.stringify({
      schema: 1,
      contractsHash: "abc123",
      versionCore: "0.1.6",
      version: compatVersion,
      sha: "",
      repository: "",
    }),
  );
  const zipPath = NodePath.join(root, "ui-bundle-0.1.6-fork.9.zip");
  NodeFS.writeFileSync(zipPath, "not really a zip, only its bytes matter here");
  return { clientDir, zipPath };
}

describe("buildUiBundleManifest", () => {
  it("describes the zip and carries the client's compat fields", () => {
    const { clientDir, zipPath } = fixture("0.1.6-fork.9");
    const manifest = buildUiBundleManifest({
      clientDir,
      zipPath,
      version: "0.1.6-fork.9",
      sha: "deadbeef",
    });

    const bytes = NodeFS.readFileSync(zipPath);
    expect(manifest).toEqual({
      schema: 1,
      version: "0.1.6-fork.9",
      versionCore: "0.1.6",
      contractsHash: "abc123",
      sha: "deadbeef",
      sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
      assetName: "ui-bundle-0.1.6-fork.9.zip",
    });
    expect(() => decodeManifest(manifest)).not.toThrow();
  });

  it("refuses a client built as a different version than the release", () => {
    const { clientDir, zipPath } = fixture("0.1.6");
    expect(() =>
      buildUiBundleManifest({ clientDir, zipPath, version: "0.1.6-fork.9", sha: "deadbeef" }),
    ).toThrow(/0\.1\.6.*0\.1\.6-fork\.9/);
  });
});
