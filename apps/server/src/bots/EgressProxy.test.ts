import * as NodeNet from "node:net";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";

import * as EgressProxy from "./EgressProxy.ts";

/** A listener standing in for the declared host: it answers what it is sent, once connected. */
const listen = Effect.acquireRelease(
  Effect.callback<NodeNet.Server>((resume) => {
    const server = NodeNet.createServer((socket) => {
      socket.on("data", (data) => socket.write(`echo:${data.toString()}`));
      socket.on("error", () => socket.destroy());
    });
    server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
  }),
  (server) => Effect.sync(() => server.close()),
);

const portOf = (server: NodeNet.Server) => (server.address() as NodeNet.AddressInfo).port;

/** Sends request text and returns the proxy's first reply line, with the socket if it is still open. */
const ask = (proxyPort: number, request: string) =>
  Effect.callback<{ readonly status: string; readonly socket: NodeNet.Socket }>((resume) => {
    const socket = NodeNet.connect(proxyPort, "127.0.0.1");
    socket.once("data", (data) => {
      resume(Effect.succeed({ status: data.toString().split("\r\n")[0]!, socket }));
    });
    socket.once("close", () => resume(Effect.succeed({ status: "closed", socket })));
    socket.write(request);
    return Effect.sync(() => socket.destroy());
  });

const connect = (proxyPort: number, target: string) =>
  ask(proxyPort, `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);

const roundTrip = (socket: NodeNet.Socket, text: string) =>
  Effect.callback<string>((resume) => {
    socket.once("data", (data) => resume(Effect.succeed(data.toString())));
    socket.write(text);
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
  }).pipe(Effect.provide(layer));

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
        const { status, socket } = yield* connect(proxy.port, `${name}:${portOf(target)}`);
        assert.strictEqual(status, "HTTP/1.1 200 Connection Established");
        assert.strictEqual(yield* roundTrip(socket, "hello"), "echo:hello");
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
      const other = yield* connect(proxy.port, `evil.example.net:${port}`);
      assert.strictEqual(other.status, "HTTP/1.1 403 Forbidden");
      // A parent or a child of a declared name is another host.
      const parent = yield* connect(proxy.port, `example.com:${port}`);
      assert.strictEqual(parent.status, "HTTP/1.1 403 Forbidden");
      const child = yield* connect(proxy.port, `x.${HOST}:${port}`);
      assert.strictEqual(child.status, "HTTP/1.1 403 Forbidden");
      // The right host on any other port is refused.
      const wrongPort = yield* connect(proxy.port, `${HOST}:${port + 1}`);
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
      const { status } = yield* connect(proxy.port, `${HOST}:${portOf(target)}`);
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
        () => connect(proxy.port, target443),
        { concurrency: "unbounded" },
      );
      assert.isTrue(open.every(({ status }) => status.includes("200")));
      const over = yield* connect(proxy.port, target443);
      assert.strictEqual(over.status, "HTTP/1.1 503 Service Unavailable");
      // A tunnel that ends makes room for the next.
      const closed = Effect.callback<void>((resume) => {
        open[0]!.socket.once("close", () => resume(Effect.void));
      });
      open[0]!.socket.destroy();
      yield* closed;
      const again = yield* Effect.retry(
        connect(proxy.port, target443).pipe(
          Effect.filterOrFail(({ status }) => status.includes("200")),
        ),
        { times: 50 },
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
      yield* connect(proxy.port, `${"a".repeat(300)}:${port}`);
      yield* connect(proxy.port, `Evil_Host!$&'x.net:${port}`);
      // The same name once the odd characters are gone, so it is one entry.
      yield* connect(proxy.port, `evilhostx.net:${port}`);
      for (let index = 0; index < 12; index += 1) {
        yield* connect(proxy.port, `host-${index}.example.net:${port}`);
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
    const tunnel = yield* connect(proxy.port, `${HOST}:${portOf(target)}`);
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
