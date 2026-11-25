// @effect-diagnostics nodeBuiltinImport:off
/**
 * Real: box WatcherService, PeerMcpClient, PeerLinks and pairing, loopback HTTP, the laptop's MCP transport serving `layerWatcherPeerTools`, its runForPeer, and a node child.
 * Faked: Bot orchestration, the box's ProcessRunner (a counter), TestClock, and the laptop's sleep (the testkit's `asleep`).
 */
import { NodeHttpServer } from "@effect/platform-node";
import * as PlatformNodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as TestClock from "effect/testing/TestClock";
import { BotWatcherRemoteRun } from "@t3tools/contracts";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import {
  descriptorOf,
  layerLinkingEnvironment,
  linkTo,
  servePeer,
} from "../peer/PeerLinks.testkit.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as BotService from "./BotService.ts";
import { makeOrchestration } from "./BotTestkit.ts";
import * as WatcherService from "./WatcherService.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const laptop = descriptorOf("environment-laptop", "Laptop");
const LAPTOP: EnvironmentId = laptop.environmentId;
const sha256Hex = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");

const layerBase = () =>
  ServerSecretStore.layer.pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-watcher-peer-" })),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, PlatformNodeCrypto.layer)),
  );

/** Counts what reaches a `ProcessRunner`, which runs for real when `real` says so. */
const makeRunner = (real: boolean) => {
  const state = { runs: 0 };
  const layer = Layer.effect(
    ProcessRunner.ProcessRunner,
    Effect.gen(function* () {
      const runner = real ? yield* ProcessRunner.make() : undefined;
      return ProcessRunner.ProcessRunner.of({
        run: (input) => {
          state.runs += 1;
          return runner === undefined
            ? Effect.die("the box ran a script that belongs on the laptop")
            : runner.run(input);
        },
      });
    }),
  );
  return { state, layer };
};

const layerWatchers = (
  orchestration: ReturnType<typeof makeOrchestration>,
  runner: ReturnType<typeof makeRunner>["layer"],
  peers: Layer.Layer<PeerMcpClient.PeerMcpClient>,
) =>
  WatcherService.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(runner, peers, Scheduler.layer)),
    Layer.provideMerge(BotService.layer),
    Layer.provideMerge(orchestration.layer),
    Layer.provideMerge(ServerSettings.ServerSettingsService.layerTest()),
    Layer.provideMerge(layerBase()),
  );

/** The laptop: its watchers run scripts for real, and `/mcp` serves the production registration. */
const serveLaptop = Effect.gen(function* () {
  const runner = makeRunner(true);
  const context = yield* Layer.build(
    layerWatchers(makeOrchestration(), runner.layer, Layer.mock(PeerMcpClient.PeerMcpClient)({})),
  );
  const peer = yield* servePeer(
    laptop,
    McpHttpServer.layerWatcherPeerTools.pipe(Layer.provide(Layer.succeedContext(context))),
  );
  return { peer, runner };
});

/** An environment linked to the laptop as `access`, with its real client and links. */
const linkBox = Effect.fn("linkBox")(function* (
  name: string,
  laptopPeer: Effect.Success<typeof serveLaptop>["peer"],
  access: "full-access" | "auto",
) {
  const context = yield* Layer.build(layerLinkingEnvironment(descriptorOf(name, name)));
  const links = Context.get(context, PeerLinks.PeerLinks);
  const client = Context.get(context, PeerMcpClient.PeerMcpClient);
  yield* linkTo(links, laptopPeer, access);
  return { links, client };
});

const runOnLaptop = (
  client: PeerMcpClient.PeerMcpClient["Service"],
  source: string,
  overrides: {
    readonly hash?: string;
    readonly mode?: "full-access" | "approval-required";
  } = {},
) =>
  client.call({
    environmentId: LAPTOP,
    tool: "t3_watcher_run",
    arguments: {
      source,
      hash: overrides.hash ?? sha256Hex(source),
      runtime: "node",
      timeoutMs: 10_000,
      dryRun: false,
    },
    limits: { runtimeMode: overrides.mode ?? "full-access", interactionMode: "default" },
    success: BotWatcherRemoteRun,
  });

/** One MCP request to the laptop with `token`, as an agent client sends it. */
const mcpSession = Effect.fn("mcpSession")(function* (url: string, token: string) {
  const http = yield* HttpClient.HttpClient;
  const post = (body: object, session?: string) =>
    http
      .execute(
        HttpClientRequest.post(`${url}/mcp`).pipe(
          HttpClientRequest.setHeaders({
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            ...(session === undefined
              ? {}
              : { "mcp-session-id": session, "mcp-protocol-version": "2025-06-18" }),
          }),
          HttpClientRequest.bodyText(JSON.stringify(body), "application/json"),
        ),
      )
      .pipe(
        Effect.flatMap((response) =>
          response.json.pipe(Effect.map((json) => ({ response, json }))),
        ),
      );
  const initialized = yield* post({
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "probe", version: "1" },
    },
  });
  const session = initialized.response.headers["mcp-session-id"]!;
  const rpc = (method: string, params: object) =>
    post({ jsonrpc: "2.0", id: 1, method, params }, session).pipe(Effect.map(({ json }) => json));
  const toolNames = rpc("tools/list", {}).pipe(
    Effect.map((json) =>
      (json as { result: { tools: ReadonlyArray<{ name: string }> } }).result.tools.map(
        (tool) => tool.name,
      ),
    ),
  );
  return { rpc, toolNames };
});

const bot = { enabled: true, muteChildren: false } as const;
const userMessage = { id: "message:user", createdBy: "user" } as const;

/** A Bot whose watcher the user dry-ran on the laptop and approved there. */
const installOnLaptop = Effect.fn("installOnLaptop")(function* (
  watchers: WatcherService.WatcherService["Service"],
  threadId: ThreadId,
  name: string,
  source: string,
  expect?: string,
) {
  const { hash } = yield* watchers.propose({
    botThreadId: threadId,
    name,
    runtime: "node",
    source,
    intervalSeconds: 3600,
    expect,
  });
  const dry = yield* watchers.dryRun({ botThreadId: threadId, name, hash, runsOn: LAPTOP });
  yield* watchers.approve({
    botThreadId: threadId,
    name,
    hash,
    runsOn: LAPTOP,
    approvedBy: "owner",
  });
  return dry;
});

const TRIPS = `console.log("disk 91%"); process.exit(1);\n`;

it.effect(
  "runs a node watcher on the laptop over the link and judges its output like a local run",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { peer, runner: laptopRunner } = yield* serveLaptop;
        const { client } = yield* linkBox("environment-box", peer, "full-access");
        const orchestration = makeOrchestration();
        const botThread = orchestration.addThread("thread:bot", { botConfig: bot });
        orchestration.startRun(botThread, userMessage);
        const boxRunner = makeRunner(false);
        const boxContext = yield* Layer.build(
          layerWatchers(
            orchestration,
            boxRunner.layer,
            Layer.succeed(PeerMcpClient.PeerMcpClient, client),
          ),
        );
        const watchers = Context.get(boxContext, WatcherService.WatcherService);

        const dry = yield* installOnLaptop(watchers, botThread.id, "disk", TRIPS, "^ok$");
        assert.deepStrictEqual(
          [dry.runsOn, dry.stdout, dry.healthy],
          [LAPTOP, "disk 91%\n", false],
        );
        assert.strictEqual(laptopRunner.state.runs, 1);

        yield* watchers.runDue;
        // The script ran there, in a real child, and nothing ran here.
        assert.strictEqual(laptopRunner.state.runs, 2);
        assert.strictEqual(boxRunner.state.runs, 0);
        assert.strictEqual((yield* watchers.list(botThread.id)).watchers[0]?.status, "tripped");
        assert.strictEqual(orchestration.sent.length, 1);
        assert.match(
          orchestration.sent[0]!.text,
          /exit: 1\nstdout:\ndisk 91%[\s\S]*<watcher-data-[0-9a-f-]+>/u,
        );
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeHttpServer.layerTest, FetchHttpClient.layer))),
);

it.effect(
  "runs only bytes that hash to what the box attested, and refuses a bad hash before any child",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { peer, runner } = yield* serveLaptop;
        const { client } = yield* linkBox("environment-box", peer, "full-access");

        const answered = yield* runOnLaptop(client, `console.log("hi")\n`);
        assert.deepStrictEqual(answered, { exit: "0", stdout: "hi\n", stderr: "" });
        assert.strictEqual(runner.state.runs, 1);

        const tampered = yield* runOnLaptop(client, `console.log("hi")\n`, {
          hash: sha256Hex(`console.log("not what was approved")\n`),
        }).pipe(Effect.flip);
        assert.strictEqual(tampered.code, "invalid_request");
        assert.include(tampered.message.toLowerCase(), "hash");
        // The refusal is an answer: it neither ran anything nor made the link look down.
        assert.isUndefined(tampered.unreachable);
        assert.strictEqual(runner.state.runs, 1);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeHttpServer.layerTest, FetchHttpClient.layer))),
);

it.effect("hides the tool from an outside client and refuses a link that is not full access", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { peer, runner } = yield* serveLaptop;
      const full = yield* linkBox("environment-box-full", peer, "full-access");
      const auto = yield* linkBox("environment-box-auto", peer, "auto");
      const source = `console.log("hi")\n`;

      // An outside agent signed in at full access: not listed, and a call does not reach a child.
      const outside = yield* peer.auth.issueMcpClientSession({
        label: "Outside agent",
        access: "full-access",
        peerLink: false,
        client: { deviceType: "bot" },
      });
      const outsideSession = yield* mcpSession(peer.url, outside.token);
      assert.notInclude(yield* outsideSession.toolNames, "t3_watcher_run");
      const attempt = yield* outsideSession.rpc("tools/call", {
        name: "t3_watcher_run",
        arguments: { source, hash: sha256Hex(source), runtime: "node", timeoutMs: 10_000 },
      });
      assert.notInclude(JSON.stringify(attempt), "hi\\n");
      assert.strictEqual(runner.state.runs, 0);

      // A link paired below full access is listed the tool but refused every call.
      const narrow = yield* runOnLaptop(auto.client, source).pipe(Effect.flip);
      assert.strictEqual(narrow.code, "capability_denied");
      assert.include(narrow.message, "full access");

      // A full-access link that a caller narrows to approval-required is refused too.
      const limited = yield* runOnLaptop(full.client, source, { mode: "approval-required" }).pipe(
        Effect.flip,
      );
      assert.strictEqual(limited.code, "capability_denied");
      assert.strictEqual(runner.state.runs, 0);

      // The linked, full-access, un-narrowed session sees the tool and runs it.
      const linkToken = (yield* full.links.resolve(LAPTOP)).token;
      assert.include(yield* (yield* mcpSession(peer.url, linkToken)).toolNames, "t3_watcher_run");
      assert.strictEqual((yield* runOnLaptop(full.client, source)).stdout, "hi\n");
      assert.strictEqual(runner.state.runs, 1);
    }),
  ).pipe(Effect.provide(Layer.mergeAll(NodeHttpServer.layerTest, FetchHttpClient.layer))),
);

it.effect(
  "waits for a laptop that does not answer without counting it, and runs once it does",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { peer } = yield* serveLaptop;
        const { client } = yield* linkBox("environment-box", peer, "full-access");
        const orchestration = makeOrchestration();
        const botThread = orchestration.addThread("thread:bot", { botConfig: bot });
        orchestration.startRun(botThread, userMessage);
        const boxContext = yield* Layer.build(
          layerWatchers(
            orchestration,
            makeRunner(false).layer,
            Layer.succeed(PeerMcpClient.PeerMcpClient, client),
          ),
        );
        const watchers = Context.get(boxContext, WatcherService.WatcherService);
        const listed = () =>
          watchers.list(botThread.id).pipe(Effect.map(({ watchers }) => watchers[0]!));
        yield* installOnLaptop(watchers, botThread.id, "disk", TRIPS);

        yield* watchers.runDue;
        assert.strictEqual(orchestration.sent.length, 1);
        const tripped = yield* listed();

        // The laptop goes to sleep: its descriptor never answers, so the link's probe times out.
        yield* Ref.set(peer.asleep, true);
        yield* TestClock.adjust(HOUR);
        const sleeping = yield* Effect.forkChild(watchers.runDue);
        yield* Queue.take(peer.unanswered);
        yield* TestClock.adjust(Duration.seconds(3));
        yield* Fiber.join(sleeping);
        const waiting = yield* listed();
        assert.strictEqual(waiting.status, "waiting");
        assert.strictEqual(waiting.failingSince, tripped.failingSince);
        assert.strictEqual(waiting.nextWakeAt, tripped.nextWakeAt);
        assert.strictEqual(orchestration.sent.length, 1);

        // It answers again; a minute later, not an hour, the watcher runs there and continues its
        // failure with one more wake.
        yield* Ref.set(peer.asleep, false);
        yield* TestClock.adjust(MINUTE);
        yield* watchers.runDue;
        const recovered = yield* listed();
        assert.strictEqual(recovered.status, "tripped");
        assert.isUndefined(recovered.waiting);
        assert.strictEqual(recovered.failingSince, tripped.failingSince);
        assert.strictEqual(orchestration.sent.length, 2);
        assert.include(orchestration.sent[1]?.text, "wake 2");
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeHttpServer.layerTest, FetchHttpClient.layer))),
);
