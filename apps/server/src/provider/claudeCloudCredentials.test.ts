import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import {
  CLAUDE_CLOUD_REQUIRED_SCOPE,
  ClaudeCloudCredentialsError,
  parseClaudeCredentials,
} from "./claudeCloudCredentials.ts";

const NOW = 1_800_000_000_000;
const SECRET = "sk-ant-oat01-super-secret-token";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const document = (oauth: Record<string, unknown>) => encodeJson({ claudeAiOauth: oauth });

const failureReason = (raw: string) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(parseClaudeCredentials(raw, NOW));
    assert.isTrue(Exit.isFailure(exit));
    const error = Exit.isFailure(exit) ? Exit.findErrorOption(exit) : undefined;
    assert.isTrue(error?._tag === "Some" && Schema.is(ClaudeCloudCredentialsError)(error.value));
    return error?._tag === "Some"
      ? { reason: error.value.reason, text: String(error.value) + error.value.message }
      : undefined;
  });

describe("parseClaudeCredentials", () => {
  it.effect("accepts a valid login and keeps the token redacted", () =>
    Effect.gen(function* () {
      const credentials = yield* parseClaudeCredentials(
        document({
          accessToken: SECRET,
          expiresAt: NOW + 3_600_000,
          scopes: [CLAUDE_CLOUD_REQUIRED_SCOPE, "user:inference"],
        }),
        NOW,
      );
      assert.strictEqual(Redacted.value(credentials.accessToken), SECRET);
      assert.notInclude(String(credentials.accessToken), SECRET);
      assert.strictEqual(credentials.expiresAtMs, NOW + 3_600_000);
    }),
  );

  it.effect("rejects an expired token and one inside the safety margin", () =>
    Effect.gen(function* () {
      const scopes = [CLAUDE_CLOUD_REQUIRED_SCOPE];
      assert.strictEqual(
        (yield* failureReason(document({ accessToken: SECRET, expiresAt: NOW - 1, scopes })))
          ?.reason,
        "Expired",
      );
      assert.strictEqual(
        (yield* failureReason(document({ accessToken: SECRET, expiresAt: NOW + 30_000, scopes })))
          ?.reason,
        "Expired",
      );
    }),
  );

  it.effect("requires the cloud session scope", () =>
    Effect.gen(function* () {
      const failure = yield* failureReason(
        document({ accessToken: SECRET, expiresAt: NOW + 3_600_000, scopes: ["user:inference"] }),
      );
      assert.strictEqual(failure?.reason, "MissingScope");
    }),
  );

  it.effect("rejects malformed content and an empty token without echoing the input", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* failureReason("not json"))?.reason, "Malformed");
      assert.strictEqual((yield* failureReason(encodeJson({ mcpOAuth: {} })))?.reason, "Malformed");
      assert.strictEqual((yield* failureReason(document({ accessToken: "" })))?.reason, "Missing");
    }),
  );

  it.effect("never puts token text in an error", () =>
    Effect.gen(function* () {
      const failures = [
        yield* failureReason(document({ accessToken: SECRET, expiresAt: NOW - 1, scopes: [] })),
        yield* failureReason(
          document({ accessToken: SECRET, expiresAt: NOW + 3_600_000, scopes: [] }),
        ),
        yield* failureReason(`{"claudeAiOauth":{"accessToken":"${SECRET}",`),
      ];
      for (const failure of failures) assert.notInclude(failure?.text ?? "", SECRET);
    }),
  );
});
