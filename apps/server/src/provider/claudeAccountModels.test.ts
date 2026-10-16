import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientResponse } from "effect/http";

import { claudeAccountModelIds } from "./claudeAccountModels.ts";
import { parseClaudeOauthToken } from "./claudeOauthToken.ts";

const TOKEN = "sk-ant-oat01-test-token";
const token = { accessToken: Redacted.make(TOKEN), scopes: new Set<string>() };
const NOW = 1_800_000_000_000;

const stubbed = (respond: () => Response) => {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      seen.push({ url: request.url, headers: { ...request.headers } });
      return HttpClientResponse.fromWeb(request, respond());
    }),
  );
  return {
    seen,
    run: claudeAccountModelIds(token).pipe(Effect.provideService(HttpClient.HttpClient, client)),
  };
};

describe("claudeAccountModelIds", () => {
  it.effect("returns the ids the account may use and sends the login", () =>
    Effect.gen(function* () {
      const { seen, run } = stubbed(() =>
        Response.json({ data: [{ id: "claude-mythos-5-1" }, { id: "claude-fable-5-1" }] }),
      );
      assert.deepStrictEqual([...(yield* run)].toSorted(), [
        "claude-fable-5-1",
        "claude-mythos-5-1",
      ]);
      assert.include(seen[0]?.url ?? "", "/v1/models");
      assert.strictEqual(seen[0]?.headers.authorization, `Bearer ${TOKEN}`);
      assert.strictEqual(seen[0]?.headers["anthropic-beta"], "oauth-2025-04-20");
    }),
  );

  it.effect("knows no models when the account cannot be read", () =>
    Effect.gen(function* () {
      // A rejected login, a server error, and a shape we do not recognise all
      // mean "offer nothing extra" rather than a failed status check.
      for (const respond of [
        () => Response.json({ error: "no" }, { status: 401 }),
        () => Response.json({}, { status: 500 }),
        () => Response.json({ data: "not-a-list" }),
      ]) {
        assert.strictEqual((yield* stubbed(respond).run).size, 0);
      }
    }),
  );
});

describe("parseClaudeOauthToken", () => {
  const document = (oauth: Record<string, unknown>) => JSON.stringify({ claudeAiOauth: oauth });

  it.effect("reads a live token and keeps it redacted", () =>
    Effect.gen(function* () {
      const parsed = yield* parseClaudeOauthToken(
        document({ accessToken: TOKEN, expiresAt: NOW + 3_600_000, scopes: ["user:inference"] }),
        NOW,
      );
      assert.strictEqual(Redacted.value(parsed!.accessToken), TOKEN);
      assert.notInclude(String(parsed!.accessToken), TOKEN);
      assert.isTrue(parsed!.scopes.has("user:inference"));
    }),
  );

  it.effect("treats expired, absent and malformed credentials as no token", () =>
    Effect.gen(function* () {
      const none = [
        document({ accessToken: TOKEN, expiresAt: NOW - 1 }),
        // Inside the expiry margin: about to lapse mid-request.
        document({ accessToken: TOKEN, expiresAt: NOW + 30_000 }),
        document({ accessToken: "" }),
        JSON.stringify({ mcpOAuth: {} }),
        "not json at all",
      ];
      for (const raw of none) {
        assert.isUndefined(yield* parseClaudeOauthToken(raw, NOW));
      }
    }),
  );

  it.effect("accepts a token with no stated expiry", () =>
    Effect.gen(function* () {
      assert.isDefined(yield* parseClaudeOauthToken(document({ accessToken: TOKEN }), NOW));
    }),
  );
});
