// @effect-diagnostics nodeBuiltinImport:off - plain Node build script that hashes files and writes ui-compat.json; no Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { buildUiCompat, computeContractsHash, versionCore } from "./compute-ui-compat.ts";

function fixture(files: Record<string, string>) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ui-compat-"));
  for (const [rel, text] of Object.entries(files)) {
    const full = NodePath.join(root, rel);
    NodeFS.mkdirSync(NodePath.join(full, ".."), { recursive: true });
    NodeFS.writeFileSync(full, text);
  }
  return root;
}

const inputs = {
  "packages/contracts/src/a.ts": "export const a = 1;\n",
  "packages/contracts/src/sub/b.ts": "export const b = 2;\n",
  "apps/desktop/src/preload.ts": "export {};\n",
  "apps/desktop/src/ipc/channels.ts": "export const c = 'x';\n",
};

describe("computeContractsHash", () => {
  it("changes when a contract or the desktop bridge changes", () => {
    const base = computeContractsHash(fixture(inputs));
    expect(
      computeContractsHash(
        fixture({ ...inputs, "packages/contracts/src/a.ts": "export const a = 2;\n" }),
      ),
    ).not.toBe(base);
    expect(
      computeContractsHash(
        fixture({ ...inputs, "apps/desktop/src/preload.ts": "export const x = 1;\n" }),
      ),
    ).not.toBe(base);
  });
  it("ignores tests and unrelated files", () => {
    const base = computeContractsHash(fixture(inputs));
    const withNoise = fixture({
      ...inputs,
      "packages/contracts/src/a.test.ts": "x",
      "apps/web/src/anything.ts": "y",
    });
    expect(computeContractsHash(withNoise)).toBe(base);
  });
  it("does not depend on line endings", () => {
    const crlf = Object.fromEntries(
      Object.entries(inputs).map(([k, v]) => [k, v.replaceAll("\n", "\r\n")]),
    );
    expect(computeContractsHash(fixture(crlf))).toBe(computeContractsHash(fixture(inputs)));
  });
});

describe("buildUiCompat", () => {
  it("records the version core and the repository", () => {
    const compat = buildUiCompat(fixture(inputs), {
      version: "0.1.6-fork.12",
      sha: "deadbeef",
      env: { GITHUB_REPOSITORY: "JackTYM/t3code" },
    });
    expect(compat).toMatchObject({
      schema: 1,
      versionCore: "0.1.6",
      version: "0.1.6-fork.12",
      repository: "JackTYM/t3code",
    });
  });
  it("versionCore drops prerelease and build", () => {
    expect(versionCore("1.2.3-nightly.20260101.4+abc")).toBe("1.2.3");
  });
});
