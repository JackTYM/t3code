import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { UiBundleManifest, UiBundleState } from "./uiBundles.ts";

const decodeManifest = Schema.decodeUnknownEffect(UiBundleManifest);
const decodeState = Schema.decodeUnknownEffect(UiBundleState);

const manifest = {
  schema: 1,
  version: "1.4.0-fork.7",
  versionCore: "1.4.0",
  contractsHash: "abc123",
  sha: "deadbeef",
  sha256: "0".repeat(64),
  size: 1024,
  assetName: "t3-ui-1.4.0-fork.7.zip",
};

const state = {
  enabled: true,
  builtinVersion: "1.4.0",
  active: "builtin",
  previous: null,
  ready: { version: "1.4.0-fork.7", size: 1024 },
  incompatible: null,
  lastCheckedAt: null,
  lastError: null,
  bootPending: false,
};

it.effect("decodes a published manifest and rejects an unknown schema revision", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* decodeManifest(manifest), manifest);
    const future = yield* Effect.exit(decodeManifest({ ...manifest, schema: 2 }));
    assert.isTrue(Exit.isFailure(future));
  }),
);

it.effect("state accepts the builtin marker or an applied version, never blank", () =>
  Effect.gen(function* () {
    assert.strictEqual((yield* decodeState(state)).active, "builtin");
    assert.strictEqual(
      (yield* decodeState({ ...state, active: "1.4.0-fork.7" })).active,
      "1.4.0-fork.7",
    );
    const blank = yield* Effect.exit(decodeState({ ...state, active: "  " }));
    assert.isTrue(Exit.isFailure(blank));
  }),
);
