import type { UiBundleManifest } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class UiBundleFeedError extends Schema.TaggedError<UiBundleFeedError>()(
  "UiBundleFeedError",
  {
    reason: Schema.Literals(["request", "invalid-response", "too-large"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "request":
        return "Could not reach the UI update feed.";
      case "invalid-response":
        return "The UI update feed returned something unexpected.";
      case "too-large":
        return "The UI bundle download is larger than its manifest declares.";
    }
  }
}

/** Where published UI bundles come from; injected so the lifecycle is testable without a network. */
export class UiBundleFeed extends Context.Service<
  UiBundleFeed,
  {
    /** Latest release's manifest and the URL of its zip asset, or null when it has no bundle. */
    readonly latest: (
      repository: string,
    ) => Effect.Effect<
      { readonly manifest: UiBundleManifest; readonly zipUrl: string } | null,
      UiBundleFeedError
    >;
    readonly download: (
      url: string,
      maxBytes: number,
    ) => Effect.Effect<Uint8Array, UiBundleFeedError>;
  }
>()("t3/uiBundles/UiBundleFeed") {}
