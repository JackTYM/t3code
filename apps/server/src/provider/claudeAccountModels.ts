/**
 * Model ids the signed-in Claude account may use.
 *
 * Some models are limited to approved organizations and the Claude CLI never
 * lists them, but the Models API does for an account that has them. Used only
 * to decide whether to offer such a model, so every failure means "none
 * known": a provider health check must never fail because of this.
 *
 * Mirrors `CodexChatGptModels.ts`, which does the same for Codex.
 *
 * @module claudeAccountModels
 */
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

import type { ClaudeOauthToken } from "./claudeOauthToken.ts";

const MODELS_URL = "https://api.anthropic.com/v1/models?limit=100";

const Catalog = Schema.Struct({
  data: Schema.Array(Schema.Struct({ id: Schema.NonEmptyString })),
});

export const claudeAccountModelIds = Effect.fn("claudeAccountModelIds")(
  function* (token: ClaudeOauthToken) {
    const http = yield* HttpClient.HttpClient;
    const response = yield* http.execute(
      HttpClientRequest.get(MODELS_URL).pipe(
        HttpClientRequest.bearerToken(Redacted.value(token.accessToken)),
        HttpClientRequest.setHeaders({
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "oauth-2025-04-20",
        }),
      ),
    );
    if (response.status !== 200) return new Set<string>();
    const catalog = yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Catalog)));
    return new Set(catalog.data.map((model) => model.id));
  },
  Effect.timeout("15 seconds"),
  // Never a reason to fail a status check: an unknown account offers nothing extra.
  Effect.orElseSucceed(() => new Set<string>()),
);
