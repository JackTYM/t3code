import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { makeClaudeAccountModelsReader } from "./claudeAccountModels.ts";
import {
  ClaudeCloudCredentialsError,
  type ClaudeCloudCredentialsReader,
} from "./claudeCloudCredentials.ts";

const TOKEN = "sk-ant-oat01-test";

const credentials = (
  read: ClaudeCloudCredentialsReader["read"] = Effect.succeed({
    accessToken: Redacted.make(TOKEN),
    expiresAtMs: null,
    scopes: ["user:sessions:claude_code"],
  }),
): ClaudeCloudCredentialsReader => ({ read, invalidate: Effect.void });

const reader = (respond: () => Response | Error, creds = credentials()) => {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const httpClient = HttpClient.make((request) =>
    Effect.suspend(() => {
      seen.push({ url: request.url, headers: { ...request.headers } });
      const answer = respond();
      return answer instanceof Error
        ? Effect.die(answer)
        : Effect.succeed(HttpClientResponse.fromWeb(request, answer));
    }),
  );
  return { reader: makeClaudeAccountModelsReader({ httpClient, credentials: creds }), seen };
};

describe("makeClaudeAccountModelsReader", () => {
  it.effect("returns the model ids the account can use, sending the login", () =>
    Effect.gen(function* () {
      const { reader: subject, seen } = reader(() =>
        Response.json({
          data: [
            { id: "claude-mythos-5-1" },
            { id: "claude-fable-5-1" },
            { id: "claude-haiku-4-5" },
          ],
        }),
      );
      const ids = yield* subject.read;
      assert.deepStrictEqual([...ids].toSorted(), [
        "claude-fable-5-1",
        "claude-haiku-4-5",
        "claude-mythos-5-1",
      ]);
      assert.strictEqual(seen[0]?.headers.authorization, `Bearer ${TOKEN}`);
      assert.strictEqual(seen[0]?.headers["anthropic-beta"], "oauth-2025-04-20");
      assert.include(seen[0]?.url ?? "", "/v1/models");
    }),
  );

  it.effect("reports no models for any failure rather than failing the health check", () =>
    Effect.gen(function* () {
      const none = (set: ReadonlySet<string>) => assert.strictEqual(set.size, 0);
      none(yield* reader(() => Response.json({ error: "no" }, { status: 401 })).reader.read);
      none(yield* reader(() => Response.json({ data: "nope" })).reader.read);
      none(yield* reader(() => new Response("not json", { status: 200 })).reader.read);
      none(
        yield* reader(
          () => Response.json({ data: [] }),
          credentials(Effect.fail(new ClaudeCloudCredentialsError({ reason: "Expired" }))),
        ).reader.read,
      );
    }),
  );
});
