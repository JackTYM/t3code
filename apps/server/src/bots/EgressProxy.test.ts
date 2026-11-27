import * as NodeNet from "node:net";
import * as NodeTls from "node:tls";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Exit from "effect/Exit";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as SecureRandom from "effect/crypto/SecureRandom";

import * as EgressProxy from "./EgressProxy.ts";

/** What every listener has been sent, so a test can show that nothing reached the host. */
const received = new WeakMap<NodeNet.Server, Array<Buffer>>();

/** A listener standing in for the declared host: it answers what it is sent, once connected. */
const listen = Effect.acquireRelease(
  Effect.callback<NodeNet.Server>((resume) => {
    const log: Array<Buffer> = [];
    const server = NodeNet.createServer((socket) => {
      socket.on("data", (data) => {
        log.push(data);
        socket.write(Buffer.concat([Buffer.from("echo:"), data]));
      });
      socket.on("error", () => socket.destroy());
    });
    received.set(server, log);
    server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
  }),
  (server) => Effect.sync(() => server.close()),
);

const portOf = (server: NodeNet.Server) => (server.address() as NodeNet.AddressInfo).port;

const u16 = (value: number) => Buffer.from([value >> 8, value & 0xff]);

/** A TLS ClientHello in one record, built by hand; `serverName` left out sends no SNI. */
const clientHello = (serverName?: string) => {
  const sni = serverName === undefined ? undefined : Buffer.from(serverName);
  const list = sni && Buffer.concat([Buffer.from([0]), u16(sni.length), sni]);
  const extensions = Buffer.concat([
    // Another extension first, so the parser has to walk past one.
    u16(10),
    u16(4),
    u16(2),
    u16(29),
    ...(list === undefined ? [] : [u16(0), u16(list.length + 2), u16(list.length), list]),
  ]);
  const body = Buffer.concat([
    Buffer.from([3, 3]),
    Buffer.alloc(32, 7),
    Buffer.from([2, 1, 2]),
    u16(2),
    Buffer.from([0x13, 0x01]),
    Buffer.from([1, 0]),
    u16(extensions.length),
    extensions,
  ]);
  const handshake = Buffer.concat([Buffer.from([1, 0]), u16(body.length), body]);
  return Buffer.concat([Buffer.from([0x16, 3, 1]), u16(handshake.length), handshake]);
};

/** Sends request text and returns the proxy's first reply line, with the socket if it is still open. */
const ask = (proxyPort: number, request: string) =>
  Effect.callback<{ readonly status: string; readonly socket: NodeNet.Socket }>((resume) => {
    const socket = NodeNet.connect(proxyPort, "127.0.0.1");
    socket.once("data", (data) => {
      resume(Effect.succeed({ status: data.toString().split("\r\n")[0]!, socket }));
    });
    // The proxy may reset a client it has refused, which is the answer, not a failure of the test.
    socket.on("error", () => undefined);
    socket.once("close", () => resume(Effect.succeed({ status: "closed", socket })));
    socket.write(request);
    return Effect.sync(() => socket.destroy());
  });

/** A CONNECT carrying the run's credentials, or the given Proxy-Authorization header (`null` for none). */
const connect = (proxy: EgressProxy.OpenedProxy, target: string, authorization?: string | null) => {
  const { password } = new URL(proxy.url);
  const header =
    authorization === null
      ? ""
      : `Proxy-Authorization: ${authorization ?? `Basic ${Buffer.from(`run:${password}`).toString("base64")}`}\r\n`;
  return ask(proxy.port, `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${header}\r\n`);
};

const roundTrip = (socket: NodeNet.Socket, data: Buffer) =>
  Effect.callback<Buffer>((resume) => {
    socket.once("data", (reply) => resume(Effect.succeed(reply)));
    socket.write(data);
  });

const closes = (socket: NodeNet.Socket) =>
  Effect.callback<void>((resume) => {
    if (socket.destroyed) resume(Effect.void);
    else socket.once("close", () => resume(Effect.void));
  });

const HOST = "api.example.com";

/** Tunnels to `target` as if it were the declared host's port 443, with every address allowed. */
const toLocal = (target: NodeNet.Server) =>
  EgressProxy.layerWith({
    lookup: async () => ["127.0.0.1"],
    isAllowedAddress: () => true,
    port: portOf(target),
  });

const openProxy = (layer: ReturnType<typeof EgressProxy.layerWith>) =>
  Effect.gen(function* () {
    const service = yield* EgressProxy.EgressProxy;
    return yield* service.open({ hosts: [HOST] });
  }).pipe(Effect.provide(Layer.provideMerge(layer, SecureRandom.layerWebCrypto)));

const withProxy = <A, E>(
  body: (proxy: EgressProxy.OpenedProxy, target: NodeNet.Server) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const target = yield* listen;
    return yield* body(yield* openProxy(toLocal(target)), target);
  }).pipe(Effect.scoped);

it.effect("tunnels a declared host, whatever the case of its name", () =>
  withProxy((proxy, target) =>
    Effect.gen(function* () {
      for (const name of [HOST, "API.Example.COM"]) {
        const { status, socket } = yield* connect(proxy, `${name}:${portOf(target)}`);
        assert.strictEqual(status, "HTTP/1.1 200 Connection Established");
        const hello = clientHello(name.toLowerCase());
        assert.deepStrictEqual(
          yield* roundTrip(socket, hello),
          Buffer.concat([Buffer.from("echo:"), hello]),
        );
        socket.destroy();
      }
      assert.deepStrictEqual(yield* proxy.blocked, []);
    }),
  ),
);

it.effect("refuses what the declared hosts do not cover, and names the host it refused", () =>
  withProxy((proxy, target) =>
    Effect.gen(function* () {
      const port = portOf(target);
      const other = yield* connect(proxy, `evil.example.net:${port}`);
      assert.strictEqual(other.status, "HTTP/1.1 403 Forbidden");
      // A parent or a child of a declared name is another host.
      const parent = yield* connect(proxy, `example.com:${port}`);
      assert.strictEqual(parent.status, "HTTP/1.1 403 Forbidden");
      const child = yield* connect(proxy, `x.${HOST}:${port}`);
      assert.strictEqual(child.status, "HTTP/1.1 403 Forbidden");
      // The right host on any other port is refused.
      const wrongPort = yield* connect(proxy, `${HOST}:${port + 1}`);
      assert.strictEqual(wrongPort.status, "HTTP/1.1 403 Forbidden");
      // Plain HTTP is not tunnelled, even to a declared host.
      const plain = yield* ask(
        proxy.port,
        `GET http://${HOST}/secret HTTP/1.1\r\nHost: ${HOST}\r\n\r\n`,
      );
      assert.strictEqual(plain.status, "HTTP/1.1 405 Method Not Allowed");
      assert.deepStrictEqual(yield* proxy.blocked, [
        "evil.example.net",
        "example.com",
        `x.${HOST}`,
        HOST,
      ]);
    }),
  ),
);

it.effect("refuses a declared host that resolves to anything but public addresses", () => {
  const cases = [
    ["loopback", ["127.0.0.1"]],
    ["private", ["10.1.2.3"]],
    ["cloud metadata", ["169.254.169.254"]],
    ["one public and one private", ["93.184.216.34", "192.168.1.5"]],
    ["IPv4-mapped loopback", ["::ffff:127.0.0.1"]],
    ["IPv6 loopback", ["::1"]],
    ["IPv6 unique local", ["fd00::1"]],
    ["carrier-grade NAT", ["100.64.0.1"]],
    ["no address at all", []],
  ] as const;
  return Effect.forEach(cases, ([label, addresses]) =>
    Effect.gen(function* () {
      const target = yield* listen;
      // The strict address policy, with only the answer and the port replaced.
      const proxy = yield* openProxy(
        EgressProxy.layerWith({ lookup: async () => addresses, port: portOf(target) }),
      );
      const { status } = yield* connect(proxy, `${HOST}:${portOf(target)}`);
      assert.strictEqual(status, "HTTP/1.1 403 Forbidden", label);
      assert.deepStrictEqual(yield* proxy.blocked, [HOST], label);
    }).pipe(Effect.scoped),
  );
});

it("tells public addresses from the rest", () => {
  for (const address of ["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
    assert.isTrue(EgressProxy.isPublicAddress(address), address);
  }
  for (const address of [
    "0.0.0.0",
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.0.1",
    "169.254.169.254",
    "100.127.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:7f00:1",
    "::ffff:10.0.0.1",
    "fe80::1",
    "fc00::1",
    "ff02::1",
    "64:ff9b::7f00:1",
    "not an address",
  ]) {
    assert.isFalse(EgressProxy.isPublicAddress(address), address);
  }
});

it.effect("holds at most sixteen tunnels at once", () =>
  withProxy((proxy, target) =>
    Effect.gen(function* () {
      const target443 = `${HOST}:${portOf(target)}`;
      const open = yield* Effect.forEach(
        Array.from({ length: 16 }),
        () => connect(proxy, target443),
        { concurrency: "unbounded" },
      );
      assert.isTrue(open.every(({ status }) => status.includes("200")));
      const over = yield* connect(proxy, target443);
      assert.strictEqual(over.status, "HTTP/1.1 503 Service Unavailable");
      // A tunnel that ends makes room for the next.
      open[0]!.socket.destroy();
      yield* closes(open[0]!.socket);
      const again = yield* Effect.retry(
        connect(proxy, target443).pipe(Effect.filterOrFail(({ status }) => status.includes("200"))),
        { times: 200, schedule: Schedule.spaced("5 millis") },
      );
      assert.include(again.status, "200");
      // Being over the cap says nothing about the host.
      assert.deepStrictEqual(yield* proxy.blocked, []);
      for (const { socket } of [...open, again]) socket.destroy();
    }),
  ),
);

it.effect("lists a few refused hostnames, once each, as plain name characters", () =>
  withProxy((proxy, target) =>
    Effect.gen(function* () {
      const port = portOf(target);
      yield* connect(proxy, `${"a".repeat(300)}:${port}`);
      yield* connect(proxy, `Evil_Host!$&'x.net:${port}`);
      // The same name once the odd characters are gone, so it is one entry.
      yield* connect(proxy, `evilhostx.net:${port}`);
      for (let index = 0; index < 12; index += 1) {
        yield* connect(proxy, `host-${index}.example.net:${port}`);
      }
      const blocked = yield* proxy.blocked;
      assert.lengthOf(blocked, 8);
      assert.strictEqual(new Set(blocked).size, 8);
      assert.strictEqual(blocked[0], "a".repeat(253));
      assert.strictEqual(blocked[1], "evilhostx.net");
      assert.isTrue(blocked.every((host) => /^[a-z0-9.-]{1,253}$/u.test(host)));
    }),
  ),
);

it.effect("closes with its scope: no new connection, and an open tunnel ends", () =>
  Effect.gen(function* () {
    const target = yield* listen;
    const scope = yield* Scope.make();
    const proxy = yield* openProxy(toLocal(target)).pipe(Scope.provide(scope));
    const tunnel = yield* connect(proxy, `${HOST}:${portOf(target)}`);
    assert.include(tunnel.status, "200");
    const ended = Effect.callback<void>((resume) => {
      tunnel.socket.once("close", () => resume(Effect.void));
    });
    yield* Scope.close(scope, Exit.void);
    yield* ended;
    const refused = yield* Effect.callback<string>((resume) => {
      const socket = NodeNet.connect(proxy.port, "127.0.0.1");
      socket.once("error", (error: NodeJS.ErrnoException) => resume(Effect.succeed(error.code!)));
    });
    assert.strictEqual(refused, "ECONNREFUSED");
  }).pipe(Effect.scoped),
);

it.effect("forwards nothing unless the TLS server name is the declared host", () =>
  withProxy((proxy, target) =>
    Effect.gen(function* () {
      const log = received.get(target)!;
      const refused = (label: string, send: ReadonlyArray<Buffer>) =>
        Effect.gen(function* () {
          const { status, socket } = yield* connect(proxy, `${HOST}:${portOf(target)}`);
          assert.strictEqual(status, "HTTP/1.1 200 Connection Established", label);
          const ended = closes(socket);
          for (const chunk of send) socket.write(chunk);
          yield* ended;
          assert.lengthOf(log, 0, label);
        });
      // Another tenant of the same address, no name at all, and bytes that are not TLS.
      yield* refused("other name", [clientHello("other.example.net")]);
      yield* refused("a longer name", [clientHello(`x.${HOST}`)]);
      yield* refused("no name", [clientHello()]);
      yield* refused("not TLS", [Buffer.from("GET / HTTP/1.1\r\n\r\n")]);
      assert.deepStrictEqual(yield* proxy.blocked, [HOST]);

      // The same name, split over two writes, goes through whole.
      const hello = clientHello(HOST.toUpperCase());
      const { status, socket } = yield* connect(proxy, `${HOST}:${portOf(target)}`);
      assert.include(status, "200");
      socket.write(hello.subarray(0, 20));
      const reply = yield* roundTrip(socket, hello.subarray(20));
      assert.deepStrictEqual(reply, Buffer.concat([Buffer.from("echo:"), hello]));
      socket.destroy();
    }),
  ),
);

it.effect("tunnels a TLS handshake a real client starts, for its own server name only", () =>
  withProxy((proxy, target) =>
    Effect.gen(function* () {
      const log = received.get(target)!;
      const handshake = (servername: string) =>
        Effect.gen(function* () {
          const { socket } = yield* connect(proxy, `${HOST}:${portOf(target)}`);
          const tls = NodeTls.connect({ socket, servername });
          tls.on("error", () => undefined);
          yield* closes(socket).pipe(
            Effect.race(
              Effect.callback<void>((resume) => {
                socket.once("data", () => resume(Effect.void));
              }),
            ),
          );
          tls.destroy();
        });
      yield* handshake(HOST);
      assert.strictEqual(log[0]?.[0], 0x16);
      const before = log.length;
      yield* handshake("other.example.net");
      assert.lengthOf(log, before);
    }),
  ),
);

it.effect("answers a CONNECT only when it carries this run's credentials", () =>
  withProxy((proxy, target) =>
    Effect.gen(function* () {
      const authority = `${HOST}:${portOf(target)}`;
      const { password } = new URL(proxy.url);
      const wrong = Buffer.from(
        `run:${password.replace(/.$/u, (last) => (last === "0" ? "1" : "0"))}`,
      ).toString("base64");
      for (const authorization of [null, "Basic", `Basic ${wrong}`, `Bearer ${password}`]) {
        const { status } = yield* connect(proxy, authority, authorization);
        assert.strictEqual(status, "HTTP/1.1 407 Proxy Authentication Required");
      }
      // Whoever else is on the machine cannot fill the Bot's list of refused hosts either.
      const stranger = yield* connect(proxy, `evil.example.net:${portOf(target)}`, null);
      assert.include(stranger.status, "407");
      assert.deepStrictEqual(yield* proxy.blocked, []);
      assert.strictEqual(new URL(proxy.url).username, "run");
      assert.match(password, /^[0-9a-f]{32}$/u);
    }),
  ),
);

it.effect("does not wait for a ClientHello that claims to be bigger than one record", () =>
  withProxy((proxy, target) =>
    Effect.gen(function* () {
      const { socket } = yield* connect(proxy, `${HOST}:${portOf(target)}`);
      const ended = closes(socket);
      socket.write(Buffer.concat([Buffer.from([0x16, 3, 1, 0x7f, 0xff]), Buffer.alloc(100)]));
      yield* ended;
      // Refused at once as not a ClientHello it will hold, not left to the quiet-client timeout.
      assert.deepStrictEqual(yield* proxy.blocked, [HOST]);
    }),
  ),
);
