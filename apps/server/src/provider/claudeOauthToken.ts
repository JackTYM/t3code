/**
 * Reads the Claude Code CLI's own OAuth access token.
 *
 * Claude Code keeps the token in the macOS Keychain, and in
 * `<config dir>/.credentials.json` elsewhere. `claudeResetCredits.ts` reads
 * only the file and so does nothing on macOS; this module covers both, for
 * callers that must work there too.
 *
 * Read-only by design: never refreshed and never written back, because a
 * refresh rotates the CLI's refresh token and can sign the user out of it.
 * An expired token simply reads as unavailable until the user runs `claude`.
 *
 * @module claudeOauthToken
 */
import * as HostProcess from "@t3tools/shared/HostProcess";
import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const KEYCHAIN_SERVICE = "Claude Code-credentials";
/** A token this close to expiry is treated as already gone. */
const EXPIRY_MARGIN_MS = 60_000;

const Credentials = Schema.Struct({
  claudeAiOauth: Schema.optional(
    Schema.Struct({
      accessToken: Schema.optional(Schema.String),
      expiresAt: Schema.optional(Schema.Finite),
      scopes: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
});
const decodeCredentials = Schema.decodeUnknownEffect(Schema.fromJsonString(Credentials));

export interface ClaudeOauthToken {
  readonly accessToken: Redacted.Redacted<string>;
  readonly scopes: ReadonlySet<string>;
}

/**
 * Parses a credentials document. Returns `undefined` for anything unusable —
 * absent, malformed, or expired — so a caller can only ever act on a token
 * that is currently good.
 */
export const parseClaudeOauthToken = Effect.fn("parseClaudeOauthToken")(function* (
  raw: string,
  nowMs: number,
) {
  const document = yield* decodeCredentials(raw).pipe(Effect.orElseSucceed(() => undefined));
  const oauth = document?.claudeAiOauth;
  const accessToken = oauth?.accessToken?.trim();
  if (!accessToken) return undefined;
  if (oauth?.expiresAt !== undefined && oauth.expiresAt - EXPIRY_MARGIN_MS <= nowMs) {
    return undefined;
  }
  return {
    accessToken: Redacted.make(accessToken),
    scopes: new Set(oauth?.scopes ?? []),
  } satisfies ClaudeOauthToken;
});

/**
 * The CLI's current token, or `undefined` when there is no usable one. Reads
 * the Keychain on macOS and the credentials file elsewhere. `configDir` is the
 * instance's Claude config directory; omit it for the default login.
 */
export const readClaudeOauthToken = Effect.fn("readClaudeOauthToken")(function* (
  configDir: string | undefined,
): Effect.fn.Return<
  ClaudeOauthToken | undefined,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const path = yield* Path.Path;
  const raw =
    (yield* HostProcess.Platform) === "darwin"
      ? yield* spawnAndCollect(
          "security",
          ChildProcess.make("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"]),
        ).pipe(
          Effect.map((result) => (result.code === 0 ? result.stdout.trim() : "")),
          Effect.orElseSucceed(() => ""),
        )
      : yield* (yield* FileSystem.FileSystem)
          .readFileString(
            path.join(configDir ?? (yield* HostProcess.HomeDirectory), ".credentials.json"),
          )
          .pipe(Effect.orElseSucceed(() => ""));
  if (raw.length === 0) return undefined;
  return yield* parseClaudeOauthToken(raw, yield* Clock.currentTimeMillis);
});
