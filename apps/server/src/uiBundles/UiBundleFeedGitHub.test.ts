import { assert, describe, it } from "@effect/vitest";
import type { UiBundleManifest } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { HttpClient, HttpClientResponse } from "effect/http";

import { UiBundleFeed } from "./UiBundleFeed.ts";
import * as UiBundleFeedGitHub from "./UiBundleFeedGitHub.ts";

const MANIFEST: UiBundleManifest = {
  schema: 1,
  version: "1.2.3-fork.6",
  versionCore: "1.2.3",
  contractsHash: "hash-a",
  sha: "sha",
  sha256: "0".repeat(64),
  size: 10,
  assetName: "ui-bundle.zip",
};

const RELEASE_URL = "https://api.github.com/repos/owner/repo/releases/latest";
const MANIFEST_URL = "https://example.test/ui-bundle.json";
const ZIP_URL = "https://example.test/ui-bundle.zip";

const release = (assets: ReadonlyArray<{ name: string; browser_download_url: string }>) =>
  Response.json({ assets });
const standardAssets = [
  { name: "ui-bundle.json", browser_download_url: MANIFEST_URL },
  { name: "ui-bundle.zip", browser_download_url: ZIP_URL },
];

/** Serves `routes` by exact URL; anything else is a 404, like GitHub for an unknown asset. */
const openFeed = (
  routes: Readonly<Record<string, () => Response>>,
  env: Record<string, string> = {},
) =>
  Effect.gen(function* () {
    const requested: Array<string> = [];
    const client = HttpClient.make((request) => {
      requested.push(request.url);
      const respond = routes[request.url];
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          respond ? respond() : new Response("not found", { status: 404 }),
        ),
      );
    });
    const context = yield* Layer.build(
      UiBundleFeedGitHub.layer.pipe(
        Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
      ),
    );
    return { feed: Context.get(context, UiBundleFeed), requested };
  }).pipe(Effect.scoped);

describe("UiBundleFeedGitHub", () => {
  describe("latest", () => {
    it.effect("returns the manifest and the zip asset's URL", () =>
      Effect.gen(function* () {
        const { feed, requested } = yield* openFeed({
          [RELEASE_URL]: () => release(standardAssets),
          [MANIFEST_URL]: () => Response.json(MANIFEST),
        });
        assert.deepStrictEqual(yield* feed.latest("owner/repo"), {
          manifest: MANIFEST,
          zipUrl: ZIP_URL,
        });
        assert.deepStrictEqual(requested, [RELEASE_URL, MANIFEST_URL]);
      }),
    );

    it.effect("treats a repository without any release (404) as having no bundle", () =>
      Effect.gen(function* () {
        const { feed } = yield* openFeed({});
        assert.isNull(yield* feed.latest("owner/repo"));
      }),
    );

    it.effect("treats a release without a manifest asset as having no bundle", () =>
      Effect.gen(function* () {
        const { feed, requested } = yield* openFeed({
          [RELEASE_URL]: () => release([{ name: "ui-bundle.zip", browser_download_url: ZIP_URL }]),
        });
        assert.isNull(yield* feed.latest("owner/repo"));
        assert.deepStrictEqual(requested, [RELEASE_URL]);
      }),
    );

    it.effect("fails with invalid-response when the manifest names a zip the release lacks", () =>
      Effect.gen(function* () {
        const { feed } = yield* openFeed({
          [RELEASE_URL]: () =>
            release([{ name: "ui-bundle.json", browser_download_url: MANIFEST_URL }]),
          [MANIFEST_URL]: () => Response.json(MANIFEST),
        });
        const error = yield* feed.latest("owner/repo").pipe(Effect.flip);
        assert.strictEqual(error.reason, "invalid-response");
      }),
    );

    it.effect.each([
      { label: "not JSON", respond: () => new Response("<html>") },
      { label: "the wrong shape", respond: () => Response.json({ version: "1.0.0" }) },
    ])("fails with invalid-response when the manifest is $label", ({ respond }) =>
      Effect.gen(function* () {
        const { feed } = yield* openFeed({
          [RELEASE_URL]: () => release(standardAssets),
          [MANIFEST_URL]: respond,
        });
        const error = yield* feed.latest("owner/repo").pipe(Effect.flip);
        assert.strictEqual(error.reason, "invalid-response");
      }),
    );

    it.effect("fails with invalid-response when the release is not the expected shape", () =>
      Effect.gen(function* () {
        const { feed } = yield* openFeed({ [RELEASE_URL]: () => Response.json({ assets: 5 }) });
        const error = yield* feed.latest("owner/repo").pipe(Effect.flip);
        assert.strictEqual(error.reason, "invalid-response");
      }),
    );

    it.effect("fails with request on a server error", () =>
      Effect.gen(function* () {
        const { feed } = yield* openFeed({
          [RELEASE_URL]: () => new Response("boom", { status: 500 }),
        });
        const error = yield* feed.latest("owner/repo").pipe(Effect.flip);
        assert.strictEqual(error.reason, "request");
      }),
    );

    it.effect("reads the release from the override URL and warns that it is set", () =>
      Effect.gen(function* () {
        const warnings: Array<unknown> = [];
        const logger = Logger.make(({ message, logLevel }) => {
          if (logLevel === "Warn") warnings.push(message);
        });
        const overrideUrl = "https://feed.example.test/latest.json";
        const { feed, requested } = yield* openFeed(
          {
            [overrideUrl]: () => release(standardAssets),
            [MANIFEST_URL]: () => Response.json(MANIFEST),
          },
          { T3CODE_UI_UPDATE_FEED_URL: overrideUrl },
        ).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));

        assert.strictEqual((yield* feed.latest("owner/repo"))?.manifest.version, MANIFEST.version);
        assert.strictEqual(requested[0], overrideUrl);
        assert.lengthOf(warnings, 1);
        assert.include(String(warnings[0]), "T3CODE_UI_UPDATE_FEED_URL");
      }),
    );

    it.effect("does not warn without an override", () =>
      Effect.gen(function* () {
        const warnings: Array<unknown> = [];
        const logger = Logger.make(({ message, logLevel }) => {
          if (logLevel === "Warn") warnings.push(message);
        });
        yield* openFeed({}).pipe(
          Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
        );
        assert.lengthOf(warnings, 0);
      }),
    );
  });

  describe("download", () => {
    it.effect("returns the bytes of the asset", () =>
      Effect.gen(function* () {
        const { feed } = yield* openFeed({
          [ZIP_URL]: () => new Response(new Uint8Array([1, 2, 3, 4])),
        });
        assert.deepStrictEqual([...(yield* feed.download(ZIP_URL, 10))], [1, 2, 3, 4]);
      }),
    );

    it.effect("fails with too-large once the body exceeds the cap", () =>
      Effect.gen(function* () {
        const { feed } = yield* openFeed({
          [ZIP_URL]: () => new Response(new Uint8Array(11)),
        });
        const error = yield* feed.download(ZIP_URL, 10).pipe(Effect.flip);
        assert.strictEqual(error.reason, "too-large");
      }),
    );

    it.effect("accepts a body exactly at the cap", () =>
      Effect.gen(function* () {
        const { feed } = yield* openFeed({
          [ZIP_URL]: () => new Response(new Uint8Array(10)),
        });
        assert.lengthOf(yield* feed.download(ZIP_URL, 10), 10);
      }),
    );

    it.effect("fails with request when the asset cannot be fetched", () =>
      Effect.gen(function* () {
        const { feed } = yield* openFeed({});
        const error = yield* feed.download(ZIP_URL, 10).pipe(Effect.flip);
        assert.strictEqual(error.reason, "request");
      }),
    );
  });
});
