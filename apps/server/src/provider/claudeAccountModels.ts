/**
 * Which models the signed-in Claude account can use, from the Models API.
 *
 * The Claude CLI never lists limited-access models such as Mythos, but the
 * Models API does for an account that has them. Used only to decide whether to
 * offer those models, so every failure collapses to "none known": a missing
 * login, a network error, or an unexpected response must never break the
 * provider's health check.
 *
 * @module claudeAccountModels
 */
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import type { ClaudeCloudCredentialsReader } from "./claudeCloudCredentials.ts";

const MODELS_URL = "https://api.anthropic.com/v1/models?limit=100";

const ModelsBody = Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) });

export interface ClaudeAccountModelsReader {
  readonly read: Effect.Effect<ReadonlySet<string>>;
}

export const makeClaudeAccountModelsReader = (input: {
  readonly httpClient: HttpClient.HttpClient;
  readonly credentials: ClaudeCloudCredentialsReader;
}): ClaudeAccountModelsReader => ({
  read: Effect.gen(function* () {
    const credentials = yield* input.credentials.read;
    const request = HttpClientRequest.get(MODELS_URL).pipe(
      HttpClientRequest.bearerToken(Redacted.value(credentials.accessToken)),
      HttpClientRequest.setHeaders({
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
      }),
    );
    const response = yield* input.httpClient.execute(request);
    if (response.status < 200 || response.status >= 300) {
      return new Set<string>();
    }
    const body = yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(ModelsBody)));
    return new Set(body.data.map((model) => model.id));
  }).pipe(Effect.orElseSucceed(() => new Set<string>())),
});
