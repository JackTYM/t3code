/**
 * Reads the Claude Code CLI's own OAuth login, which is how this provider
 * authenticates: cloud sessions belong to the user's Claude subscription, and
 * an API key cannot reach them.
 *
 * Read-only by design. The token is never refreshed or written back, because a
 * refresh rotates the CLI's refresh token and can sign the user out of it. An
 * expired token reads as absent until the user runs `claude` again.
 *
 * @module credentials
 */
import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const KEYCHAIN_SERVICE = "Claude Code-credentials";
/** Scope the cloud session API requires. */
export const CLOUD_SESSION_SCOPE = "user:sessions:claude_code";
/** A token this close to expiry is treated as already gone. */
const EXPIRY_MARGIN_MS = 60_000;

export class ClaudeCloudSignInError extends Schema.TaggedError<ClaudeCloudSignInError>()(
  "ClaudeCloudSignInError",
  { reason: Schema.Literals(["missing", "expired", "missingScope"]) },
) {
  /** Fixed text only: credential content must never reach a message. */
  override get message(): string {
    switch (this.reason) {
      case "missing":
        return "Run `claude` and sign in to use Claude Cloud.";
      case "expired":
        return "Your Claude login has expired. Run `claude` to refresh it.";
      case "missingScope":
        return "Your Claude login cannot open cloud sessions. Run `claude` and /login again.";
    }
  }
}

export interface ClaudeCloudCredentials {
  readonly accessToken: Redacted.Redacted<string>;
}

const Document = Schema.Struct({
  claudeAiOauth: Schema.optional(
    Schema.Struct({
      accessToken: Schema.optional(Schema.String),
      expiresAt: Schema.optional(Schema.Finite),
      scopes: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
});
const decodeDocument = Schema.decodeUnknownEffect(Schema.fromJsonString(Document));

/** Parses a credentials document, rejecting anything not usable right now. */
export const parseClaudeCloudCredentials = Effect.fn("parseClaudeCloudCredentials")(function* (
  raw: string,
  nowMs: number,
): Effect.fn.Return<ClaudeCloudCredentials, ClaudeCloudSignInError> {
  const document = yield* decodeDocument(raw).pipe(Effect.orElseSucceed(() => undefined));
  const oauth = document?.claudeAiOauth;
  const accessToken = oauth?.accessToken?.trim();
  if (!accessToken) return yield* new ClaudeCloudSignInError({ reason: "missing" });
  if (oauth?.expiresAt !== undefined && oauth.expiresAt - EXPIRY_MARGIN_MS <= nowMs) {
    return yield* new ClaudeCloudSignInError({ reason: "expired" });
  }
  if (!(oauth?.scopes ?? []).includes(CLOUD_SESSION_SCOPE)) {
    return yield* new ClaudeCloudSignInError({ reason: "missingScope" });
  }
  return { accessToken: Redacted.make(accessToken) };
});

export interface ClaudeCloudCredentialStore {
  /** Cached until shortly before the token expires. */
  readonly read: Effect.Effect<ClaudeCloudCredentials, ClaudeCloudSignInError>;
  /** Drops the cache, for example after the API rejected the token. */
  readonly invalidate: Effect.Effect<void>;
}

/**
 * Claude Code keeps the login in the macOS Keychain and in
 * `~/.claude/.credentials.json` elsewhere, so both are read.
 */
export const makeClaudeCloudCredentialStore = Effect.fn("makeClaudeCloudCredentialStore")(
  function* (): Effect.fn.Return<
    ClaudeCloudCredentialStore,
    never,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
  > {
    const cache = yield* Ref.make<{ value: ClaudeCloudCredentials; expiresAtMs: number } | null>(
      null,
    );
    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const platform = yield* HostProcess.Platform;
    const homeDirectory = yield* HostProcess.HomeDirectory;

    const load = Effect.gen(function* () {
      const raw =
        platform === "darwin"
          ? yield* spawnAndCollect(
              "security",
              ChildProcess.make("security", [
                "find-generic-password",
                "-s",
                KEYCHAIN_SERVICE,
                "-w",
              ]),
            ).pipe(
              Effect.map((result) => (result.code === 0 ? result.stdout.trim() : "")),
              Effect.orElseSucceed(() => ""),
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            )
          : yield* fileSystem
              .readFileString(path.join(homeDirectory, ".claude", ".credentials.json"))
              .pipe(Effect.orElseSucceed(() => ""));
      if (raw.length === 0) return yield* new ClaudeCloudSignInError({ reason: "missing" });
      const nowMs = yield* Clock.currentTimeMillis;
      const credentials = yield* parseClaudeCloudCredentials(raw, nowMs);
      // Re-read shortly before expiry so a long-lived session picks up the
      // token the CLI refreshed underneath it.
      yield* Ref.set(cache, { value: credentials, expiresAtMs: nowMs + EXPIRY_MARGIN_MS });
      return credentials;
    });

    return {
      read: Effect.gen(function* () {
        const cached = yield* Ref.get(cache);
        if (cached !== null && cached.expiresAtMs > (yield* Clock.currentTimeMillis)) {
          return cached.value;
        }
        return yield* load;
      }),
      invalidate: Ref.set(cache, null),
    };
  },
);
