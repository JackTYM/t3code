import * as NodeDnsPromises from "node:dns/promises";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect has no server for CONNECT, which the proxy answers on the raw socket.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

/**
 * The only way out for a script that holds a secret: a per-run loopback CONNECT proxy that tunnels
 * HTTPS on 443 to the declared hosts. It resolves and checks each name itself, then connects to
 * that address, so a private or later-changed DNS answer cannot redirect a declared host.
 */
const MAX_TUNNELS = 16;
// A server holds a connection for a request line that never ends, so those are bounded too.
const MAX_CONNECTIONS = 64;
const IDLE_TIMEOUT = Duration.seconds(60);
const LOOKUP_TIMEOUT = Duration.seconds(10);
const MAX_BLOCKED_HOSTS = 8;
const MAX_HOSTNAME_LENGTH = 253;
const MAX_HEADER_BYTES = 8 * 1024;

export class EgressProxyError extends Schema.TaggedError<EgressProxyError>()("EgressProxyError", {
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return "The egress proxy for a script could not start.";
  }
}

export interface OpenedProxy {
  readonly port: number;
  /** Hostnames the script asked for and was refused, as `[a-z0-9.-]` only, at most eight. */
  readonly blocked: Effect.Effect<ReadonlyArray<string>>;
}

/** What a test replaces to tunnel to a listener of its own; the defaults are the strict ones. */
export interface EgressPolicy {
  readonly lookup: (hostname: string) => Promise<ReadonlyArray<string>>;
  readonly isAllowedAddress: (address: string) => boolean;
  readonly port: number;
}

const NOT_PUBLIC = new NodeNet.BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  NOT_PUBLIC.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  // Unspecified, loopback and the deprecated IPv4-compatible form. A mapped IPv4 address
  // (`::ffff:a.b.c.d`) is judged by the IPv4 rules above: the list applies them to it.
  ["::", 96],
  // NAT64, 6to4 and Teredo embed an IPv4 address that the network may route anywhere.
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["2002::", 16],
  ["2001::", 32],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  NOT_PUBLIC.addSubnet(network, prefix, "ipv6");
}

export const isPublicAddress = (address: string): boolean => {
  const family = NodeNet.isIPv4(address) ? "ipv4" : NodeNet.isIPv6(address) ? "ipv6" : undefined;
  return family !== undefined && !NOT_PUBLIC.check(address, family);
};

const systemLookup = async (hostname: string): Promise<ReadonlyArray<string>> =>
  (await NodeDnsPromises.lookup(hostname, { all: true, verbatim: true })).map(
    ({ address }) => address,
  );

const STRICT_POLICY: EgressPolicy = {
  lookup: systemLookup,
  isAllowedAddress: isPublicAddress,
  port: 443,
};

// The hostname comes from the script, and goes into text the Bot reads, so only plain name
// characters survive and the length is bounded.
const sanitizeHostname = (hostname: string): string =>
  hostname
    .toLowerCase()
    .replace(/[^a-z0-9.-]/gu, "")
    .slice(0, MAX_HOSTNAME_LENGTH);

const parseTarget = (target: string): { hostname: string; port: number } | undefined => {
  const match = /^([^:[\]/@\s]+):(\d{1,5})$/u.exec(target);
  return match === null ? undefined : { hostname: match[1]!.toLowerCase(), port: Number(match[2]) };
};

const refuse = (socket: { end: (chunk: string) => unknown }, status: string, extra = "") => {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n${extra}\r\n`);
};

const open = (policy: EgressPolicy) =>
  Effect.fn("EgressProxy.open")(function* (input: { readonly hosts: ReadonlyArray<string> }) {
    const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
    const declared = new Set(input.hosts.map((host) => host.toLowerCase()));
    const blocked = new Set<string>();
    const sockets = new Set<NodeNet.Socket>();
    let tunnels = 0;
    let closed = false;

    const block = (hostname: string) => {
      const safe = sanitizeHostname(hostname);
      if (safe !== "" && blocked.size < MAX_BLOCKED_HOSTS) blocked.add(safe);
    };

    const tunnel = async (client: NodeNet.Socket, head: Buffer, target: string) => {
      const parsed = parseTarget(target);
      if (parsed === undefined) {
        refuse(client, "400 Bad Request");
        return;
      }
      const { hostname, port } = parsed;
      if (port !== policy.port || !declared.has(hostname)) {
        block(hostname);
        refuse(client, "403 Forbidden");
        return;
      }
      if (tunnels >= MAX_TUNNELS) {
        refuse(client, "503 Service Unavailable");
        return;
      }
      tunnels += 1;
      let upstream: NodeNet.Socket | undefined;
      let established = false;
      try {
        // The server callback is the boundary: a lookup that fails or hangs is no address.
        const addresses = await runPromise(
          Effect.promise(() => policy.lookup(hostname).catch((): ReadonlyArray<string> => [])).pipe(
            Effect.timeout(LOOKUP_TIMEOUT),
            Effect.orElseSucceed((): ReadonlyArray<string> => []),
          ),
        );
        // Every answer must be allowed: a name that has one public and one private address could
        // be connected to either by the next resolver.
        const [first] = addresses;
        if (
          closed ||
          client.destroyed ||
          first === undefined ||
          !addresses.every(policy.isAllowedAddress)
        ) {
          block(hostname);
          refuse(client, "403 Forbidden");
          return;
        }
        const connected = await new Promise<NodeNet.Socket | undefined>((resolve) => {
          const socket = NodeNet.connect({ host: first, port });
          upstream = socket;
          sockets.add(socket);
          socket.setTimeout(Duration.toMillis(IDLE_TIMEOUT));
          socket.once("connect", () => resolve(socket));
          socket.once("error", () => resolve(undefined));
          socket.once("timeout", () => resolve(undefined));
        });
        if (connected === undefined || closed || client.destroyed) {
          refuse(client, "502 Bad Gateway");
          return;
        }
        established = true;
        for (const socket of [client, connected]) {
          socket.on("timeout", () => socket.destroy());
          socket.on("error", () => socket.destroy());
        }
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) connected.write(head);
        client.pipe(connected);
        connected.pipe(client);
        await new Promise<void>((resolve) => {
          const done = () => resolve();
          // Either may have closed while this was waiting its turn, and then no event is coming.
          if (client.destroyed || connected.destroyed) return done();
          client.once("close", done);
          connected.once("close", done);
        });
      } finally {
        tunnels -= 1;
        upstream?.destroy();
        if (upstream !== undefined) sockets.delete(upstream);
        // A refusal is still being written; the idle timeout ends a client that never hangs up.
        if (established) client.destroy();
      }
    };

    const server = NodeHttp.createServer(
      { maxHeaderSize: MAX_HEADER_BYTES },
      (request, response) => {
        // A plain HTTP request would carry its own text past the tunnel's rules.
        try {
          block(new URL(request.url ?? "").hostname);
        } catch {
          // No host to name: a request that is not in absolute form.
        }
        response.writeHead(405, { Allow: "CONNECT", Connection: "close", "Content-Length": 0 });
        response.end();
      },
    );
    server.maxConnections = MAX_CONNECTIONS;
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.on("error", () => socket.destroy());
      socket.setTimeout(Duration.toMillis(IDLE_TIMEOUT), () => socket.destroy());
    });
    server.on("connect", (request, socket, head) => {
      if (!(socket instanceof NodeNet.Socket)) {
        socket.destroy();
        return;
      }
      void tunnel(socket, head, request.url ?? "").catch(() => socket.destroy());
    });
    server.on("clientError", (_error, socket) => refuse(socket, "400 Bad Request"));

    yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", () => {
              server.off("error", reject);
              resolve();
            });
          }),
        catch: (cause) => new EgressProxyError({ cause }),
      }),
      () =>
        Effect.sync(() => {
          closed = true;
          server.close();
          for (const socket of sockets) socket.destroy();
        }),
    );
    const address = server.address();
    if (address === null || typeof address === "string") {
      return yield* new EgressProxyError({ cause: new Error("no port") });
    }
    return {
      port: address.port,
      blocked: Effect.sync(() => [...blocked]),
    } satisfies OpenedProxy;
  });

export class EgressProxy extends Context.Service<
  EgressProxy,
  {
    /** Open for the scope of a run, which closes it and every tunnel it still holds. */
    readonly open: (input: {
      readonly hosts: ReadonlyArray<string>;
    }) => Effect.Effect<OpenedProxy, EgressProxyError, Scope.Scope>;
  }
>()("t3/bots/EgressProxy") {}

export const layer = Layer.succeed(EgressProxy, EgressProxy.of({ open: open(STRICT_POLICY) }));

/** For tests that tunnel to a listener of their own. */
export const layerWith = (policy: Partial<EgressPolicy>) =>
  Layer.succeed(EgressProxy, EgressProxy.of({ open: open({ ...STRICT_POLICY, ...policy }) }));
