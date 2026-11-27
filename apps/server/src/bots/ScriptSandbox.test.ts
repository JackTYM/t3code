import * as NodeNet from "node:net";
import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SecureRandom from "effect/crypto/SecureRandom";

import * as ProcessRunner from "../processRunner.ts";
import * as EgressProxy from "./EgressProxy.ts";
import * as ScriptSandbox from "./ScriptSandbox.ts";

const layer = ScriptSandbox.layer.pipe(
  Layer.provideMerge(ProcessRunner.layer),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(SecureRandom.layerWebCrypto),
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

// A listener that records what it is sent, standing in for a declared host and for a service on
// the machine the script has no business reaching.
const listenRecording = Effect.acquireRelease(
  Effect.callback<{ server: NodeNet.Server; received: Array<Buffer> }>((resume) => {
    const received: Array<Buffer> = [];
    const server = NodeNet.createServer((socket) => {
      socket.on("data", (data) => {
        received.push(data);
        socket.write("hello from the listener\n");
      });
      socket.on("error", () => socket.destroy());
    });
    server.listen(0, "127.0.0.1", () => resume(Effect.succeed({ server, received })));
  }),
  ({ server }) => Effect.sync(() => server.close()),
);

const portOf = (server: NodeNet.Server) => (server.address() as NodeNet.AddressInfo).port;

it.effect("lets a script reach only its proxy, and the proxy only the declared host", () =>
  Effect.gen(function* () {
    const sandbox = yield* ScriptSandbox.ScriptSandbox;
    const runner = yield* ProcessRunner.ProcessRunner;
    if (!(yield* sandbox.available)) return;

    const { server, received } = yield* listenRecording;
    const target = portOf(server);
    // The listener plays the declared host's port 443, at an address the strict policy would refuse.
    const proxy = yield* Effect.gen(function* () {
      const service = yield* EgressProxy.EgressProxy;
      return yield* service.open({ hosts: ["api.example.com"] });
    }).pipe(
      Effect.provide(
        EgressProxy.layerWith({
          lookup: async () => ["127.0.0.1"],
          isAllowedAddress: () => true,
          port: target,
        }),
      ),
    );

    const run = (command: string, args: ReadonlyArray<string>, env: Record<string, string> = {}) =>
      runner.run({
        ...sandbox.wrap({ command, args, hidden: [], allowed: [], proxyPort: proxy.port }),
        inheritEnv: false,
        env,
        timeout: Duration.seconds(20),
        timeoutBehavior: "timedOutResult",
      });
    const node = (script: string, env?: Record<string, string>) =>
      run(process.execPath, ["-e", script], env);
    const { password } = new URL(proxy.url);
    const authorization = `Proxy-Authorization: Basic ${Buffer.from(`run:${password}`).toString("base64")}\r\n`;
    const connectScript = (port: number, send: string) => `
      const socket = require("node:net").connect(${port}, "127.0.0.1");
      socket.on("error", (error) => { console.log("error " + error.code); });
      socket.on("data", (data) => { console.log(data.toString().split("\\r\\n")[0]); socket.destroy(); });
      socket.on("connect", () => socket.write(${JSON.stringify(send)}));
    `;

    // Straight to the listener, or to anywhere else, is refused.
    const direct = yield* node(connectScript(target, "direct"));
    assert.include(direct.stdout, "error EPERM");
    assert.lengthOf(received, 0);
    const outside = yield* node(connectScript(443, "outside"));
    assert.include(outside.stdout, "error EPERM");
    const listen = yield* node(
      `require("node:net").createServer().listen(0, "127.0.0.1").on("error", (e) => console.log("listen " + e.code))`,
    );
    assert.include(listen.stdout, "listen EPERM");
    const udp = yield* node(
      `const s = require("node:dgram").createSocket("udp4"); s.on("error", (e) => console.log("udp " + e.code)); s.bind(0)`,
    );
    assert.include(udp.stdout, "udp EPERM");
    const unix = yield* node(
      `require("node:net").connect("/var/run/mDNSResponder").on("error", (e) => console.log("unix " + e.code))`,
    );
    assert.include(unix.stdout, "unix EPERM");

    // Through the proxy, the declared host is reached; the proxy's answer is the tunnel's.
    const tunnelled = yield* node(
      connectScript(
        proxy.port,
        `CONNECT api.example.com:${target} HTTP/1.1\r\n${authorization}\r\n`,
      ),
    );
    assert.include(tunnelled.stdout, "HTTP/1.1 200 Connection Established");
    // Any other host is refused by the proxy, and named for the Bot.
    const refused = yield* node(
      connectScript(
        proxy.port,
        `CONNECT evil.example.net:${target} HTTP/1.1\r\n${authorization}\r\n`,
      ),
    );
    assert.include(refused.stdout, "HTTP/1.1 403 Forbidden");
    assert.deepStrictEqual(yield* proxy.blocked, ["evil.example.net"]);

    // The two clients a Bot's script is most likely to use take the proxy from the environment.
    const before = received.length;
    const proxyEnv = { HTTPS_PROXY: proxy.url, NODE_USE_ENV_PROXY: "1" };
    yield* node(
      `fetch("https://api.example.com:${target}/").catch(() => console.log("fetch ended"))`,
      proxyEnv,
    );
    const afterFetch = received.length;
    yield* run("/usr/bin/curl", ["-sS", "-m", "5", `https://api.example.com:${target}/`], proxyEnv);
    // The listener is not a TLS server, so neither request succeeds; each began a TLS handshake
    // there, which the proxy lets through only for a client that sends the credentials in the
    // proxy URL and the declared name as its server name.
    assert.isAbove(afterFetch, before);
    assert.isAbove(received.length, afterFetch);
    assert.strictEqual(received[before]![0], 0x16);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

const PROBE_PLIST =
  '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>probe</string><key>CFBundleIdentifier</key><string>t3code.egress.probe</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/></dict></plist>';

// Each line is something a script that holds a secret could do to hand data to code outside the
// sandbox, which has the network, or to a later run that has no proxy. The outcome is judged from
// what is left outside, not from the script's say-so.
const ESCAPES = [
  // A file anywhere but its own folders, which a login item, a git hook or a later script would read.
  '/bin/echo x > "$OUTSIDE/file" 2>/dev/null && echo wrote-outside || echo write-denied',
  '/bin/echo x > "$SCRATCH/file" && /bin/echo x > "$STATE/file" && echo wrote-own || echo own-denied',
  "/bin/echo x > /dev/null && /bin/echo x > /dev/stderr 2>/dev/null && echo wrote-dev || echo dev-denied",
  // The preferences daemon writes the plist on the caller's behalf.
  '/usr/bin/defaults write "$DOMAIN" key value 2>/dev/null && echo prefs-wrote || echo prefs-denied',
  // The clipboard outlives the run.
  "/usr/bin/printf x | /usr/bin/pbcopy 2>/dev/null && echo clipboard-wrote || echo clipboard-denied",
  // An app the script wrote itself, started by LaunchServices outside the sandbox.
  `APP="$SCRATCH/Probe.app"; /bin/mkdir -p "$APP/Contents/MacOS"
   /usr/bin/printf '%s' '${PROBE_PLIST}' > "$APP/Contents/Info.plist"
   /usr/bin/printf '#!/bin/sh\n/usr/bin/touch "%s"\n' "$MARKER" > "$APP/Contents/MacOS/probe"
   /bin/chmod +x "$APP/Contents/MacOS/probe"
   if /usr/bin/open -g -j -n "$APP" 2>/dev/null; then
     for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
       [ -e "$MARKER" ] && { echo app-ran-outside; exit 0; }; /bin/sleep 0.25
     done
   fi
   echo app-not-run`,
];

it.effect(
  "keeps a script that holds a secret from handing data to anything outside its folders",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sandbox = yield* ScriptSandbox.ScriptSandbox;
      const runner = yield* ProcessRunner.ProcessRunner;
      if (!(yield* sandbox.available)) return;

      const root = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
      const [scratch, state, outside] = ["scratch", "state", "outside"].map((name) =>
        path.join(root, name),
      ) as [string, string, string];
      for (const folder of [scratch, state, outside]) yield* fileSystem.makeDirectory(folder);
      const domain = `t3code.egress.test.${path.basename(root)}`;
      // Only reached by a sandbox that fails to hold: the preferences daemon writes it for the script.
      yield* Effect.addFinalizer(() =>
        fileSystem
          .remove(path.join(NodeOS.homedir(), "Library", "Preferences", `${domain}.plist`), {
            force: true,
          })
          .pipe(Effect.ignore),
      );
      const env = {
        PATH: "/usr/bin:/bin",
        SCRATCH: scratch,
        STATE: state,
        OUTSIDE: outside,
        MARKER: path.join(outside, "app-ran"),
        DOMAIN: domain,
      };
      const run = (proxyPort: number | undefined, scripts: ReadonlyArray<string>) =>
        runner.run({
          ...sandbox.wrap({
            command: "/bin/sh",
            args: ["-c", scripts.join("\n")],
            hidden: [],
            allowed: [scratch, state],
            proxyPort,
          }),
          inheritEnv: false,
          env,
          timeout: Duration.seconds(30),
          timeoutBehavior: "timedOutResult",
        });

      const held = (yield* run(1, ESCAPES)).stdout.trim().split("\n");
      assert.deepStrictEqual(held, [
        "write-denied",
        "wrote-own",
        "wrote-dev",
        "prefs-denied",
        "clipboard-denied",
        "app-not-run",
      ]);
      assert.isFalse(yield* fileSystem.exists(path.join(outside, "file")));

      // A script without a secret keeps working as it did: it may write elsewhere (`gh` keeps its
      // config in the home). The other escapes are not run unsandboxed here, as they would change
      // the clipboard and the preferences of whoever runs the tests.
      const plain = (yield* run(undefined, [ESCAPES[0]!])).stdout.trim();
      assert.strictEqual(plain, "wrote-outside");
    }).pipe(Effect.scoped, Effect.provide(layer)),
);
