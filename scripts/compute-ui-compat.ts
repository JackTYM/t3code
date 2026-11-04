// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - plain Node build script that hashes files and writes ui-compat.json; no Effect runtime.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { UiCompat } from "@t3tools/shared/uiCompat";

const CONTRACT_ROOT = "packages/contracts/src";
// The Electron preload and its channel names are the desktop bridge the UI calls through; a
// swapped UI cannot update them, so they count as wire contract.
const BRIDGE_FILES = [
  "apps/desktop/src/preload.ts",
  "apps/desktop/src/ipc/channels.ts",
  // The sandboxed preload imports and runs it, so a swapped UI cannot change what it does.
  "apps/desktop/src/legacyLocalStorageMerge.ts",
] as const;

function listTs(dir: string): string[] {
  return NodeFS.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = NodePath.join(dir, entry.name);
    if (entry.isDirectory()) return listTs(full);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : [];
  });
}

export function listCompatInputs(repoRoot: string): string[] {
  return [
    ...listTs(NodePath.join(repoRoot, CONTRACT_ROOT)),
    ...BRIDGE_FILES.map((f) => NodePath.join(repoRoot, f)),
  ]
    .map((full) => NodePath.relative(repoRoot, full).split(NodePath.sep).join("/"))
    .sort();
}

export function computeContractsHash(repoRoot: string): string {
  const hash = NodeCrypto.createHash("sha256");
  for (const rel of listCompatInputs(repoRoot)) {
    hash.update(`${rel}\0`);
    hash.update(NodeFS.readFileSync(NodePath.join(repoRoot, rel), "utf8").replaceAll("\r\n", "\n"));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export const versionCore = (version: string) => version.replace(/[-+].*$/, "");

export function buildUiCompat(
  repoRoot: string,
  input: { version: string; sha: string; env: Readonly<Record<string, string | undefined>> },
): UiCompat {
  const repository =
    input.env.T3CODE_DESKTOP_UPDATE_REPOSITORY?.trim() || input.env.GITHUB_REPOSITORY?.trim() || "";
  return {
    schema: 1,
    contractsHash: computeContractsHash(repoRoot),
    versionCore: versionCore(input.version),
    version: input.version,
    sha: input.sha,
    repository,
  };
}

/** Usage: node scripts/compute-ui-compat.ts <clientDir>  (version from apps/desktop/package.json) */
if (import.meta.main) {
  const clientDir = process.argv[2];
  if (!clientDir) throw new Error("usage: compute-ui-compat.ts <clientDir>");
  const repoRoot = NodePath.join(import.meta.dirname, "..");
  const pkg = JSON.parse(
    NodeFS.readFileSync(NodePath.join(repoRoot, "apps/desktop/package.json"), "utf8"),
  ) as {
    version: string;
  };
  const sha = process.env.GITHUB_SHA ?? "";
  const compat = buildUiCompat(repoRoot, { version: pkg.version, sha, env: process.env });
  NodeFS.mkdirSync(clientDir, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(clientDir, "ui-compat.json"),
    `${JSON.stringify(compat, null, 2)}\n`,
  );
  console.log(`ui-compat.json written to ${clientDir} (${compat.contractsHash.slice(0, 12)})`);
}
