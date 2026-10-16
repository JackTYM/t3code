import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { ClaudeCloudSignInError, parseClaudeCloudCredentials } from "./credentials.ts";

const NOW = 1_800_000_000_000;
const TOKEN = "sk-ant-oat01-super-secret";
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const document = (oauth: Record<string, unknown>) => encode({ claudeAiOauth: oauth });
const live = {
  accessToken: TOKEN,
  expiresAt: NOW + 3_600_000,
  scopes: ["user:sessions:claude_code"],
};

const refusal = (raw: string) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(parseClaudeCloudCredentials(raw, NOW));
    assert.isTrue(Exit.isFailure(exit));
    const error = Exit.isFailure(exit) ? Exit.findErrorOption(exit) : undefined;
    assert.isTrue(error?._tag === "Some" && Schema.is(ClaudeCloudSignInError)(error.value));
    return error?._tag === "Some" && Schema.is(ClaudeCloudSignInError)(error.value)
      ? { reason: error.value.reason, text: `${String(error.value)}${error.value.message}` }
      : undefined;
  });

describe("parseClaudeCloudCredentials", () => {
  it.effect("accepts a live login and keeps the token redacted", () =>
    Effect.gen(function* () {
      const credentials = yield* parseClaudeCloudCredentials(document(live), NOW);
      assert.strictEqual(Redacted.value(credentials.accessToken), TOKEN);
      assert.notInclude(String(credentials.accessToken), TOKEN);
    }),
  );

  it.effect("refuses a login that is missing, expired, or lacks cloud session access", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        (yield* refusal(document({ ...live, accessToken: "" })))?.reason,
        "missing",
      );
      assert.strictEqual((yield* refusal(encode({ mcpOAuth: {} })))?.reason, "missing");
      assert.strictEqual((yield* refusal("not json"))?.reason, "missing");
      assert.strictEqual(
        (yield* refusal(document({ ...live, expiresAt: NOW - 1 })))?.reason,
        "expired",
      );
      // Inside the margin: it would lapse mid-request.
      assert.strictEqual(
        (yield* refusal(document({ ...live, expiresAt: NOW + 30_000 })))?.reason,
        "expired",
      );
      assert.strictEqual(
        (yield* refusal(document({ ...live, scopes: ["user:inference"] })))?.reason,
        "missingScope",
      );
    }),
  );

  it.effect("never puts credential text in a refusal", () =>
    Effect.gen(function* () {
      for (const raw of [
        document({ ...live, expiresAt: NOW - 1 }),
        document({ ...live, scopes: [] }),
        `{"claudeAiOauth":{"accessToken":"${TOKEN}",`,
      ]) {
        assert.notInclude((yield* refusal(raw))?.text ?? "", TOKEN);
      }
    }),
  );

  it.effect("accepts a login with no stated expiry", () =>
    Effect.gen(function* () {
      const { expiresAt: _omitted, ...noExpiry } = live;
      assert.isDefined(yield* parseClaudeCloudCredentials(document(noExpiry), NOW));
    }),
  );
});
