import { assert, describe, it } from "@effect/vitest";
import type { ClaudeCloudSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import { CloudApiError, type ClaudeCloudApi } from "../claudeCloudApi.ts";
import {
  ClaudeCloudCredentialsError,
  type ClaudeCloudCredentialsReader,
} from "../claudeCloudCredentials.ts";
import { checkClaudeCloudProviderStatus } from "./ClaudeCloudProvider.ts";

const settings = (enabled: boolean): ClaudeCloudSettings => ({ enabled, customModels: [] });

const loggedIn = {
  accessToken: Redacted.make("token"),
  expiresAtMs: null,
  scopes: ["user:sessions:claude_code"],
};

/** Counts how often the login was read, so a disabled provider can be shown not to. */
const probe = (input: {
  readonly enabled: boolean;
  readonly credentials: ClaudeCloudCredentialsReader["read"];
  readonly profile?: ClaudeCloudApi["profile"];
}) =>
  Effect.gen(function* () {
    let reads = 0;
    const credentials: ClaudeCloudCredentialsReader = {
      read: Effect.suspend(() => {
        reads += 1;
        return input.credentials;
      }),
      invalidate: Effect.void,
    };
    const api = {
      profile: input.profile ?? Effect.succeed({ email: "a@b.c", orgUuid: "org" }),
    } as unknown as ClaudeCloudApi;
    const draft = yield* checkClaudeCloudProviderStatus({
      settings: settings(input.enabled),
      credentials,
      api,
    });
    return { draft, reads };
  });

describe("checkClaudeCloudProviderStatus", () => {
  it.effect("does not read the login while disabled", () =>
    Effect.gen(function* () {
      const { draft, reads } = yield* probe({
        enabled: false,
        credentials: Effect.succeed(loggedIn),
      });
      assert.strictEqual(reads, 0);
      assert.strictEqual(draft.enabled, false);
      assert.strictEqual(draft.status, "disabled");
    }),
  );

  it.effect("is ready and shows the account email when the login works", () =>
    Effect.gen(function* () {
      const { draft } = yield* probe({ enabled: true, credentials: Effect.succeed(loggedIn) });
      assert.strictEqual(draft.status, "ready");
      assert.strictEqual(draft.auth.status, "authenticated");
      assert.strictEqual(draft.auth.email, "a@b.c");
      assert.strictEqual(draft.badgeLabel, "Early Access");
      assert.strictEqual(draft.supportsTextGeneration, false);
      assert.isAbove(draft.models.length, 0);
    }),
  );

  it.effect("asks the user to sign in when the login is missing, expired, or lacks the scope", () =>
    Effect.gen(function* () {
      for (const reason of ["Missing", "Expired", "MissingScope", "Malformed"] as const) {
        const error = new ClaudeCloudCredentialsError({ reason });
        const { draft } = yield* probe({ enabled: true, credentials: Effect.fail(error) });
        assert.strictEqual(draft.status, "error", reason);
        assert.strictEqual(draft.auth.status, "unauthenticated", reason);
        assert.strictEqual(draft.message, error.message, reason);
        assert.include(draft.message ?? "", "claude");
      }
    }),
  );

  it.effect("treats a rejected login as unauthenticated and a network failure as a warning", () =>
    Effect.gen(function* () {
      const rejected = yield* probe({
        enabled: true,
        credentials: Effect.succeed(loggedIn),
        profile: Effect.fail(new CloudApiError({ kind: "auth", status: 401, detail: "no" })),
      });
      assert.strictEqual(rejected.draft.status, "error");
      assert.strictEqual(rejected.draft.auth.status, "unauthenticated");

      const offline = yield* probe({
        enabled: true,
        credentials: Effect.succeed(loggedIn),
        profile: Effect.fail(new CloudApiError({ kind: "transport", detail: "offline" })),
      });
      assert.strictEqual(offline.draft.status, "warning");
      assert.strictEqual(offline.draft.auth.status, "unknown");
    }),
  );
});
