// @effect-diagnostics nodeBuiltinImport:off - CLI integration exercises the filesystem boundary.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";

import { cli } from "../binCli.ts";

const runCli = (args: ReadonlyArray<string>) =>
  Command.runWith(cli, { version: "0.0.0" })(args).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer, TestConsole.layer)),
  );

const makeBaseDir = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-ui-cli-"));

const seedBundles = (baseDir: string) => {
  const root = NodePath.join(baseDir, "userdata", "ui-bundles");
  NodeFS.mkdirSync(NodePath.join(root, "0.1.6-fork.9"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(root, "0.1.6-fork.9", "index.html"), "<html></html>");
  NodeFS.mkdirSync(NodePath.join(root, "staging", "0.1.6-fork.10"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(root, "trash"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(root, "state.json"),
    JSON.stringify({
      active: "0.1.6-fork.9",
      previous: null,
      ready: null,
      incompatible: null,
      bootPendingSince: null,
    }),
  );
  return root;
};

describe("t3 ui reset", () => {
  it.effect("removes every downloaded bundle and says nothing to reset the second time", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      const root = seedBundles(baseDir);

      yield* runCli(["ui", "reset", "--base-dir", baseDir]);
      assert.isFalse(NodeFS.existsSync(root));
      assert.isTrue(NodeFS.existsSync(NodePath.join(baseDir, "userdata")));
      const first = (yield* TestConsole.logLines).join("\n");
      assert.include(first, "Removed");

      yield* runCli(["ui", "reset", "--base-dir", baseDir]);
      const second = (yield* TestConsole.logLines).join("\n");
      assert.include(second, "Nothing to reset");
    }),
  );

  it.effect("refuses while a server owns the state directory", () =>
    Effect.gen(function* () {
      const baseDir = makeBaseDir();
      const root = seedBundles(baseDir);
      NodeFS.writeFileSync(
        NodePath.join(baseDir, "userdata", "server-runtime.json"),
        JSON.stringify({
          version: 1,
          pid: process.pid,
          port: 3773,
          origin: "http://127.0.0.1:3773",
          startedAt: "2026-01-01T00:00:00.000Z",
        }),
      );

      const error = yield* runCli(["ui", "reset", "--base-dir", baseDir]).pipe(Effect.flip);
      assert.include(String(error), "is running");
      assert.isTrue(NodeFS.existsSync(root));
    }),
  );
});
