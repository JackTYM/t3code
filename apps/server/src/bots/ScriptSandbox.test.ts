import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import * as ScriptSandbox from "./ScriptSandbox.ts";

const layer = ScriptSandbox.layer.pipe(
  Layer.provideMerge(ProcessRunner.layer),
  Layer.provideMerge(NodeServices.layer),
);

// The wrapper is macOS's own `sandbox-exec`, so only a Mac can show that it keeps a file out.
it.effect("keeps a script out of the T3 home except its own folders", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const sandbox = yield* ScriptSandbox.ScriptSandbox;
    const runner = yield* ProcessRunner.ProcessRunner;
    // A server that is itself sandboxed cannot nest another, and says so.
    if (!(yield* sandbox.available)) return;

    const root = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
    const home = path.join(root, "home");
    const state = path.join(home, "bots", "state");
    const scratch = path.join(root, "scratch");
    yield* fileSystem.makeDirectory(path.join(home, "secrets"), { recursive: true });
    yield* fileSystem.makeDirectory(state, { recursive: true });
    yield* fileSystem.makeDirectory(scratch);
    yield* fileSystem.writeFileString(path.join(home, "secrets", "grant.bin"), "TOPSECRET");
    yield* fileSystem.writeFileString(path.join(state, "mine"), "my own state");

    const run = (script: string) => {
      const launch = sandbox.wrap({
        command: "/bin/sh",
        args: ["-c", script],
        hidden: [home],
        allowed: [scratch, state],
      });
      return runner.run({ ...launch, inheritEnv: false });
    };

    const secret = yield* run(`cat ${path.join(home, "secrets", "grant.bin")}`);
    assert.notStrictEqual(secret.code, 0);
    assert.notInclude(secret.stdout, "TOPSECRET");
    const listing = yield* run(`ls ${path.join(home, "secrets")}`);
    assert.notStrictEqual(listing.code, 0);
    const overwrite = yield* run(`echo x > ${path.join(home, "secrets", "grant.bin")}`);
    assert.notStrictEqual(overwrite.code, 0);
    assert.strictEqual(
      yield* fileSystem.readFileString(path.join(home, "secrets", "grant.bin")),
      "TOPSECRET",
    );

    const own = yield* run(`cat ${path.join(state, "mine")} && echo more > ${state}/new`);
    assert.strictEqual(own.code, 0);
    assert.include(own.stdout, "my own state");
    assert.strictEqual(yield* fileSystem.readFileString(path.join(state, "new")), "more\n");
    // A script can still resolve where it is, though it cannot look around its parents.
    const resolve = yield* run(`cd ${state} && pwd -P`);
    assert.strictEqual(resolve.code, 0);
    assert.include(resolve.stdout, state);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
