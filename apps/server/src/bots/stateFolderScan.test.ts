// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

import { hideInStateFolder } from "./stateFolderScan.ts";

const SECRET = "ghp_Sup3rS3cretValue-0123456789";
const secrets = [{ name: "GITHUB_TOKEN", value: SECRET }];
const CHUNK = 1024 * 1024;

const inFolder = async (body: (root: string, outside: string) => Promise<void>) => {
  const base = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-scan-"));
  const root = NodePath.join(base, "state");
  const outside = NodePath.join(base, "outside");
  await NodeFSP.mkdir(root);
  await NodeFSP.mkdir(outside);
  try {
    await body(root, outside);
  } finally {
    await NodeFSP.rm(base, { recursive: true, force: true });
  }
};
const exists = (target: string) =>
  NodeFSP.access(target).then(
    () => true,
    () => false,
  );
const padding = (bytes: number) => "x".repeat(bytes);

it("replaces a value in a text file in place, and leaves other files as they were", () =>
  inFolder(async (root) => {
    await NodeFSP.mkdir(NodePath.join(root, "sub"));
    await NodeFSP.writeFile(NodePath.join(root, "a"), `token=${SECRET}\n`);
    await NodeFSP.writeFile(NodePath.join(root, "sub", "b"), SECRET);
    await NodeFSP.writeFile(NodePath.join(root, "clean"), "fine");
    assert.isTrue(await hideInStateFolder(root, secrets));
    assert.strictEqual(
      await NodeFSP.readFile(NodePath.join(root, "a"), "utf8"),
      "token=[secret GITHUB_TOKEN]\n",
    );
    assert.strictEqual(
      await NodeFSP.readFile(NodePath.join(root, "sub", "b"), "utf8"),
      "[secret GITHUB_TOKEN]",
    );
    assert.strictEqual(await NodeFSP.readFile(NodePath.join(root, "clean"), "utf8"), "fine");
    assert.isFalse(await hideInStateFolder(root, secrets));
  }));

it("treats a file it cannot open as a hit, and removes it", () =>
  inFolder(async (root) => {
    const hidden = NodePath.join(root, "hidden");
    await NodeFSP.writeFile(hidden, SECRET);
    await NodeFSP.chmod(hidden, 0o000);
    assert.isTrue(await hideInStateFolder(root, secrets));
    assert.isFalse(await exists(hidden));
  }));

it("never rewrites a file it read only part of: a hit past the first chunk removes the file", () =>
  inFolder(async (root) => {
    const big = NodePath.join(root, "big");
    await NodeFSP.writeFile(big, `${padding(CHUNK + 5000)}${SECRET}${padding(2000)}`);
    const clean = NodePath.join(root, "big-clean");
    await NodeFSP.writeFile(clean, padding(CHUNK * 2 + 77));
    assert.isTrue(await hideInStateFolder(root, secrets));
    assert.isFalse(await exists(big));
    assert.strictEqual((await NodeFSP.stat(clean)).size, CHUNK * 2 + 77);
  }));

it("finds a value that straddles two chunks", () =>
  inFolder(async (root) => {
    const straddling = NodePath.join(root, "straddling");
    await NodeFSP.writeFile(straddling, `${padding(CHUNK - 10)}${SECRET}${padding(CHUNK)}`);
    assert.isTrue(await hideInStateFolder(root, secrets));
    assert.isFalse(await exists(straddling));
  }));

it("removes a binary file with a hit instead of rewriting it through text", () =>
  inFolder(async (root) => {
    const binary = NodePath.join(root, "binary");
    await NodeFSP.writeFile(
      binary,
      Buffer.concat([Buffer.from([0xff, 0xfe, 0x00]), Buffer.from(SECRET)]),
    );
    const harmless = NodePath.join(root, "harmless");
    const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x80]);
    await NodeFSP.writeFile(harmless, bytes);
    assert.isTrue(await hideInStateFolder(root, secrets));
    assert.isFalse(await exists(binary));
    assert.deepStrictEqual(await NodeFSP.readFile(harmless), bytes);
  }));

it("does not follow a link, and a directory swapped for one between listing and reading is a hit", () =>
  inFolder(async (root, outside) => {
    const elsewhere = NodePath.join(outside, "file");
    await NodeFSP.writeFile(elsewhere, SECRET);
    await NodeFSP.symlink(elsewhere, NodePath.join(root, "link"));
    assert.isFalse(await hideInStateFolder(root, secrets));

    const sub = NodePath.join(root, "sub");
    await NodeFSP.mkdir(sub);
    await NodeFSP.writeFile(NodePath.join(sub, "inside"), "fine");
    const swapped = await hideInStateFolder(root, secrets, {
      listed: async (directory) => {
        if (directory !== root) return;
        await NodeFSP.rm(sub, { recursive: true });
        await NodeFSP.symlink(outside, sub);
      },
    });
    assert.isTrue(swapped);
    assert.strictEqual(await NodeFSP.readFile(elsewhere, "utf8"), SECRET);
  }));
