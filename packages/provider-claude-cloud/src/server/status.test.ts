import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { ClaudeCloudSettings } from "../settings.ts";
import { ClaudeCloudApiError } from "./cloudApi.ts";
import { ClaudeCloudSignInError, type ClaudeCloudCredentialStore } from "./credentials.ts";
import { checkClaudeCloudProviderStatus } from "./status.ts";

const decodeSettings = Schema.decodeSync(ClaudeCloudSettings);
const MODELS = [{ slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", isCustom: false }].map(
  (model) => ({ ...model, capabilities: null }),
);

const credentialStore = (
  read: ClaudeCloudCredentialStore["read"],
): ClaudeCloudCredentialStore & { readonly reads: () => number } => {
  let reads = 0;
  return {
    read: Effect.suspend(() => {
      reads += 1;
      return read;
    }),
    invalidate: Effect.void,
    reads: () => reads,
  };
};
const signedIn = Effect.succeed({ accessToken: Redacted.make("token") });

describe("checkClaudeCloudProviderStatus", () => {
  it.effect("never reads the login while disabled", () =>
    Effect.gen(function* () {
      const credentials = credentialStore(signedIn);
      const snapshot = yield* checkClaudeCloudProviderStatus({
        settings: decodeSettings({}),
        models: MODELS,
        credentials,
        api: { profile: Effect.die("profile must not be called") },
      });
      assert.strictEqual(credentials.reads(), 0);
      assert.strictEqual(snapshot.status, "disabled");
      assert.strictEqual(snapshot.badgeLabel, "Early Access");
      assert.strictEqual(snapshot.supportsTextGeneration, false);
      assert.deepEqual(snapshot.supportedRuntimeModes, ["full-access"]);
    }),
  );

  it.effect("reports the account when the login and profile are good", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkClaudeCloudProviderStatus({
        settings: decodeSettings({ enabled: true }),
        models: MODELS,
        credentials: credentialStore(signedIn),
        api: { profile: Effect.succeed({ email: "dev@example.com", orgUuid: "org" }) },
      });
      assert.strictEqual(snapshot.status, "ready");
      assert.deepEqual(snapshot.auth, { status: "authenticated", email: "dev@example.com" });
      assert.deepEqual(
        snapshot.models.map((model) => model.slug),
        ["claude-sonnet-4-6"],
      );
    }),
  );

  it.effect("asks the user to sign in for a missing, expired, or under-scoped login", () =>
    Effect.gen(function* () {
      for (const reason of ["missing", "expired", "missingScope"] as const) {
        const error = new ClaudeCloudSignInError({ reason });
        const snapshot = yield* checkClaudeCloudProviderStatus({
          settings: decodeSettings({ enabled: true }),
          models: MODELS,
          credentials: credentialStore(Effect.fail(error)),
          api: { profile: Effect.die("profile must not be called") },
        });
        assert.strictEqual(snapshot.status, "error");
        assert.strictEqual(snapshot.auth.status, "unauthenticated");
        assert.strictEqual(snapshot.message, error.message);
      }
    }),
  );

  it.effect("treats a rejected token as signed out and a network failure as unknown", () =>
    Effect.gen(function* () {
      const rejected = yield* checkClaudeCloudProviderStatus({
        settings: decodeSettings({ enabled: true }),
        models: MODELS,
        credentials: credentialStore(signedIn),
        api: {
          profile: Effect.fail(
            new ClaudeCloudApiError({ kind: "auth", status: 401, detail: "nope" }),
          ),
        },
      });
      assert.strictEqual(rejected.status, "error");
      assert.strictEqual(rejected.auth.status, "unauthenticated");

      const offline = yield* checkClaudeCloudProviderStatus({
        settings: decodeSettings({ enabled: true }),
        models: MODELS,
        credentials: credentialStore(signedIn),
        api: {
          profile: Effect.fail(new ClaudeCloudApiError({ kind: "transport", detail: "offline" })),
        },
      });
      assert.strictEqual(offline.status, "warning");
      assert.strictEqual(offline.auth.status, "unknown");
    }),
  );
});
