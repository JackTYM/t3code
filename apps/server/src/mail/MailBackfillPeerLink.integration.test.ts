/**
 * Real: PeerMcpClient, PeerLinks and pairing, loopback HTTP, the laptop's MCP transport serving
 * `layerMailPeerTools`, its MailAppReader over a Mail-shaped store in a temp directory.
 * Faked: nothing but the clock (TestClock) and, where a test needs to count or fail reads, the
 * reader itself.
 */
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { BotMailBackfillPage, type EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as TestClock from "effect/testing/TestClock";

import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import {
  descriptorOf,
  layerLinkingEnvironment,
  linkTo,
  servePeer,
} from "../peer/PeerLinks.testkit.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import * as MailAppReader from "./MailAppReader.ts";
import { layerFake, layerOnPlatform, rfc822, writeMailStore } from "./MailAppReader.testkit.ts";

const laptop = descriptorOf("environment-laptop", "Laptop");
const LAPTOP: EnvironmentId = laptop.environmentId;
const NOW = "2025-06-15T12:00:00.000Z";

const mail = (id: string, date: string) => ({
  id,
  downloadedAt: date,
  raw: rfc822(
    [
      ["Message-ID", `<${id}@news.test>`],
      ["From", "News <n@news.test>"],
      ["To", "me@gmail.test"],
      ["Delivered-To", "me@gmail.test"],
      ["Subject", `Subject ${id}`],
      ["Date", DateTime.toDateUtc(DateTime.makeUnsafe(date)).toUTCString()],
    ],
    `body of ${id}`,
  ),
});

const serveLaptop = <E, R>(reader: Layer.Layer<MailAppReader.MailAppReader, E, R>) =>
  servePeer(
    laptop,
    McpHttpServer.layerMailPeerTools.pipe(Layer.provide(reader), Layer.provide(NodeServices.layer)),
  );

/** An environment linked to the laptop as `access`, with its real client and links. */
const linkBox = Effect.fn("linkBox")(function* (
  name: string,
  laptopPeer: Effect.Success<ReturnType<typeof serveLaptop>>,
  access: "full-access" | "auto",
) {
  const context = yield* Layer.build(layerLinkingEnvironment(descriptorOf(name, name)));
  const links = Context.get(context, PeerLinks.PeerLinks);
  const client = Context.get(context, PeerMcpClient.PeerMcpClient);
  yield* linkTo(links, laptopPeer, access);
  return { links, client };
});

const backfillOnLaptop = (
  client: PeerMcpClient.PeerMcpClient["Service"],
  input: {
    readonly sinceDays: number;
    readonly cursor?: string | undefined;
    readonly limit?: number;
  },
  mode: "full-access" | "approval-required" = "full-access",
) =>
  client.call({
    environmentId: LAPTOP,
    tool: "t3_mail_backfill",
    arguments: input,
    limits: { runtimeMode: mode, interactionMode: "default" },
    success: BotMailBackfillPage,
  });

/** One MCP session to the laptop with `token`, as an agent client opens it. */
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

const served = Layer.mergeAll(NodeHttpServer.layerTest, FetchHttpClient.layer);

it.effect("returns pages of a Mail-shaped store to the box over a real peer link", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mail-peer-" });
      yield* writeMailStore(root, [
        {
          id: "AAAAAAAA-0000-4000-8000-000000000001",
          mailboxes: [
            {
              folder: ["INBOX"],
              messages: [
                mail("a", "2025-06-14T09:00:00Z"),
                mail("b", "2025-06-13T09:00:00Z"),
                mail("c", "2025-06-12T09:00:00Z"),
              ],
            },
          ],
        },
      ]);
      yield* TestClock.setTime(Date.parse(NOW));
      const peer = yield* serveLaptop(layerOnPlatform("darwin", root));
      const { client } = yield* linkBox("environment-box", peer, "full-access");

      const first = yield* backfillOnLaptop(client, { sinceDays: 30, limit: 2 });
      assert.deepStrictEqual(
        first.messages.map((message) => message.messageId),
        ["a@news.test", "b@news.test"],
      );
      assert.deepStrictEqual(first.accounts, ["me@gmail.test"]);
      assert.strictEqual(first.messages[0]?.mailbox, "me@gmail.test");
      assert.strictEqual(first.messages[0]?.origin, "backfill");

      const second = yield* backfillOnLaptop(client, {
        sinceDays: 30,
        limit: 2,
        cursor: first.nextCursor,
      });
      assert.deepStrictEqual(
        second.messages.map((message) => message.messageId),
        ["c@news.test"],
      );
      assert.isUndefined(second.nextCursor);

      // Bad input is the box's mistake, refused before the laptop reads anything.
      const outOfRange = yield* backfillOnLaptop(client, { sinceDays: 400 }).pipe(Effect.flip);
      assert.strictEqual(outOfRange.unreachable, undefined);
      const badCursor = yield* backfillOnLaptop(client, { sinceDays: 30, cursor: "junk" }).pipe(
        Effect.flip,
      );
      assert.strictEqual(badCursor.code, "invalid_request");
    }),
  ).pipe(Effect.provide(Layer.mergeAll(served, NodeServices.layer))),
);

it.effect("hides the tool from an outside client and refuses a link that is not full access", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const reads = yield* Ref.make(0);
      const peer = yield* serveLaptop(
        layerFake(() =>
          Ref.update(reads, (count) => count + 1).pipe(
            Effect.as({ messages: [], accounts: ["me@gmail.test"] }),
          ),
        ),
      );
      const full = yield* linkBox("environment-box-full", peer, "full-access");
      const auto = yield* linkBox("environment-box-auto", peer, "auto");

      // An outside agent signed in at full access: not listed, and a call reads nothing.
      const outside = yield* peer.auth.issueMcpClientSession({
        label: "Outside agent",
        access: "full-access",
        peerLink: false,
        client: { deviceType: "bot" },
      });
      const outsideSession = yield* mcpSession(peer.url, outside.token);
      assert.notInclude(yield* outsideSession.toolNames, "t3_mail_backfill");
      yield* outsideSession.rpc("tools/call", {
        name: "t3_mail_backfill",
        arguments: { sinceDays: 30 },
      });
      assert.strictEqual(yield* Ref.get(reads), 0);

      // A link paired below full access, and a full-access one a caller narrows, are refused.
      const narrow = yield* backfillOnLaptop(auto.client, { sinceDays: 30 }).pipe(Effect.flip);
      assert.strictEqual(narrow.code, "capability_denied");
      const limited = yield* backfillOnLaptop(
        full.client,
        { sinceDays: 30 },
        "approval-required",
      ).pipe(Effect.flip);
      assert.strictEqual(limited.code, "capability_denied");
      assert.strictEqual(yield* Ref.get(reads), 0);

      // The linked, full-access, un-narrowed session sees the tool and reads.
      const linkToken = (yield* full.links.resolve(LAPTOP)).token;
      assert.include(yield* (yield* mcpSession(peer.url, linkToken)).toolNames, "t3_mail_backfill");
      assert.deepStrictEqual((yield* backfillOnLaptop(full.client, { sinceDays: 30 })).accounts, [
        "me@gmail.test",
      ]);
      assert.strictEqual(yield* Ref.get(reads), 1);
    }),
  ).pipe(Effect.provide(served)),
);

it.effect("tells the box what to enable when macOS blocks the laptop's Mail folder", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const peer = yield* serveLaptop(
        layerFake(() =>
          Effect.fail(new MailAppReader.MailAppAccessDeniedError({ cause: "EPERM" })),
        ),
      );
      const { client } = yield* linkBox("environment-box", peer, "full-access");
      const failure = yield* backfillOnLaptop(client, { sinceDays: 30 }).pipe(Effect.flip);
      assert.strictEqual(failure.code, "capability_denied");
      assert.isUndefined(failure.unreachable);
      assert.include(failure.message, "Full Disk Access");
      assert.include(failure.message, "T3 Code server");
    }),
  ).pipe(Effect.provide(served)),
);
