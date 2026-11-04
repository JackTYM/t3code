import { UiBundleManifest } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { UiBundleFeed, UiBundleFeedError } from "./UiBundleFeed.ts";

const API_TIMEOUT_MS = 10_000;
// A ~64 MB zip over a slow remote link (Tailscale, T3 Connect) needs more than ~4 Mbps to finish within 120 s.
const DOWNLOAD_TIMEOUT_MS = 300_000;
const MANIFEST_ASSET_NAME = "ui-bundle.json";
// Tests and dev point this at a JSON document shaped like the GitHub "latest release" response.
const FEED_URL_ENV = "T3CODE_UI_UPDATE_FEED_URL";

const Release = Schema.Struct({
  assets: Schema.Array(Schema.Struct({ name: Schema.String, browser_download_url: Schema.String })),
});
const decodeRelease = Schema.decodeUnknownEffect(Release);
const decodeManifest = Schema.decodeUnknownEffect(UiBundleManifest);

const make = Effect.gen(function* () {
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const feedUrlOverride = yield* Config.String(FEED_URL_ENV).pipe(
    Config.option,
    Effect.orElseSucceed(() => Option.none<string>()),
  );
  // The override replaces the GitHub release feed entirely, so whoever controls it controls which
  // UI the server may download; it is meant for tests and development only.
  if (Option.isSome(feedUrlOverride)) {
    yield* Effect.logWarning(`${FEED_URL_ENV} is set; UI updates use that feed instead of GitHub.`);
  }

  const request = (url: string, timeoutMs: number) =>
    client
      .execute(
        HttpClientRequest.get(url).pipe(
          HttpClientRequest.setHeaders({
            Accept: "application/vnd.github+json, application/json, application/octet-stream",
            "User-Agent": "t3code-ui-update",
          }),
        ),
      )
      .pipe(Effect.timeout(timeoutMs));

  const requestError = (cause: unknown) => new UiBundleFeedError({ reason: "request", cause });
  const invalidResponse = (cause: unknown) =>
    new UiBundleFeedError({ reason: "invalid-response", cause });

  // A body that is not JSON is the feed's fault, not the network's.
  const readJson = (response: HttpClientResponse.HttpClientResponse) =>
    response.json.pipe(
      Effect.timeout(API_TIMEOUT_MS),
      Effect.mapError((cause) =>
        cause._tag === "HttpClientError" && cause.reason._tag === "DecodeError"
          ? invalidResponse(cause)
          : requestError(cause),
      ),
    );

  const getManifest = (url: string) =>
    request(url, API_TIMEOUT_MS).pipe(
      Effect.mapError(requestError),
      Effect.flatMap(readJson),
      Effect.flatMap((json) => decodeManifest(json).pipe(Effect.mapError(invalidResponse))),
    );

  // A repository that has never published a release answers 404; that is "no bundle", not a failure.
  const getRelease = (url: string) =>
    request(url, API_TIMEOUT_MS).pipe(
      Effect.asSome,
      Effect.catchTags({
        HttpClientError: (error) =>
          error.response?.status === 404 ? Effect.succeedNone : Effect.fail(error),
      }),
      Effect.mapError(requestError),
      Effect.flatMap((response) =>
        Option.isNone(response)
          ? Effect.succeedNone
          : readJson(response.value).pipe(
              Effect.flatMap((json) => decodeRelease(json).pipe(Effect.mapError(invalidResponse))),
              Effect.asSome,
            ),
      ),
    );

  return UiBundleFeed.of({
    latest: Effect.fn("UiBundleFeedGitHub.latest")(function* (repository: string) {
      const releaseUrl = Option.getOrElse(
        feedUrlOverride,
        () => `https://api.github.com/repos/${repository}/releases/latest`,
      );
      const release = yield* getRelease(releaseUrl);
      const manifestAsset = Option.getOrUndefined(release)?.assets.find(
        (asset) => asset.name === MANIFEST_ASSET_NAME,
      );
      if (Option.isNone(release) || !manifestAsset) return null;

      const manifest = yield* getManifest(manifestAsset.browser_download_url);
      const zipAsset = release.value.assets.find((asset) => asset.name === manifest.assetName);
      if (!zipAsset) return yield* new UiBundleFeedError({ reason: "invalid-response" });
      return { manifest, zipUrl: zipAsset.browser_download_url };
    }),

    download: Effect.fn("UiBundleFeedGitHub.download")(function* (url: string, maxBytes: number) {
      const response = yield* request(url, DOWNLOAD_TIMEOUT_MS).pipe(Effect.mapError(requestError));
      const chunks: Array<Uint8Array> = [];
      let received = 0;
      // The manifest's size is untrusted until the hash check, so stop reading as soon as it is exceeded.
      yield* response.stream.pipe(
        Stream.mapError(requestError),
        Stream.tap((chunk) => {
          received += chunk.byteLength;
          if (received > maxBytes)
            return Effect.fail(new UiBundleFeedError({ reason: "too-large" }));
          chunks.push(chunk);
          return Effect.void;
        }),
        Stream.runDrain,
        Effect.timeout(DOWNLOAD_TIMEOUT_MS),
        Effect.catchTags({ TimeoutError: (cause) => Effect.fail(requestError(cause)) }),
      );
      const bytes = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes;
    }),
  });
});

export const layer = Layer.effect(UiBundleFeed, make);
