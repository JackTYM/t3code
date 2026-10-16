/**
 * Reads the claude CLI's own OAuth login so Claude Cloud can call the same
 * private API the CLI uses.
 *
 * Read-only by design. The token is never refreshed, written back, logged, or
 * persisted: a refresh rotates the refresh token, and doing that behind the
 * CLI's back could sign the user out of it. When the access token is missing
 * or expired the user runs `claude` once, which refreshes it.
 *
 * @module claudeCloudCredentials
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { spawnAndCollect } from "./providerSnapshot.ts";

/** Scope the cloud session API checks for. */
export const CLAUDE_CLOUD_REQUIRED_SCOPE = "user:sessions:claude_code";

const KEYCHAIN_SERVICE = "Claude Code-credentials";
/** An access token this close to expiry is treated as already expired. */
const EXPIRY_MARGIN_MS = 60_000;

export class ClaudeCloudCredentialsError extends Schema.TaggedError<ClaudeCloudCredentialsError>()(
  "ClaudeCloudCredentialsError",
  { reason: Schema.Literals(["Missing", "Expired", "MissingScope", "Malformed"]) },
) {
  // Fixed text only: raw credential content must never reach a message.
  override get message(): string {
    switch (this.reason) {
      case "Missing":
        return "Run `claude` and sign in to use Claude Cloud.";
      case "Expired":
        return "Your Claude login has expired. Run `claude` to refresh it.";
      case "MissingScope":
        return "Your Claude login lacks cloud session access. Run `claude` and /login again.";
      case "Malformed":
        return "The saved Claude login could not be read. Run `claude` and sign in again.";
    }
  }
}

export interface ClaudeCloudCredentials {
  readonly accessToken: Redacted.Redacted<string>;
  readonly expiresAtMs: number | null;
  readonly scopes: ReadonlyArray<string>;
}

const CredentialsDocument = Schema.Struct({
  claudeAiOauth: Schema.Struct({
    accessToken: Schema.String,
    expiresAt: Schema.optional(Schema.Finite),
    scopes: Schema.optional(Schema.Array(Schema.String)),
  }),
});
const decodeCredentialsDocument = Schema.decodeUnknownEffect(
  Schema.fromJsonString(CredentialsDocument),
);

/** Parses the Keychain item or credentials file contents. */
export const parseClaudeCredentials = Effect.fn("parseClaudeCredentials")(function* (
  raw: string,
  nowMs: number,
): Effect.fn.Return<ClaudeCloudCredentials, ClaudeCloudCredentialsError> {
  const document = yield* decodeCredentialsDocument(raw).pipe(
    Effect.mapError(() => new ClaudeCloudCredentialsError({ reason: "Malformed" })),
  );
  const oauth = document.claudeAiOauth;
  if (oauth.accessToken.length === 0) {
    return yield* new ClaudeCloudCredentialsError({ reason: "Missing" });
  }
  const expiresAtMs = oauth.expiresAt ?? null;
  if (expiresAtMs !== null && expiresAtMs - EXPIRY_MARGIN_MS <= nowMs) {
    return yield* new ClaudeCloudCredentialsError({ reason: "Expired" });
  }
  const scopes = oauth.scopes ?? [];
  if (!scopes.includes(CLAUDE_CLOUD_REQUIRED_SCOPE)) {
    return yield* new ClaudeCloudCredentialsError({ reason: "MissingScope" });
  }
  return { accessToken: Redacted.make(oauth.accessToken), expiresAtMs, scopes };
});

export interface ClaudeCloudCredentialsReader {
  /** Cached until shortly before the token expires. */
  readonly read: Effect.Effect<ClaudeCloudCredentials, ClaudeCloudCredentialsError>;
  /** Drops the cache, for example after the API answered 401. */
  readonly invalidate: Effect.Effect<void>;
}

/**
 * macOS keeps the login in the Keychain; other hosts, and macOS when the
 * Keychain has no item, use `<claude config dir>/.credentials.json`.
 */
export const makeClaudeCredentialsReader = Effect.fn("makeClaudeCredentialsReader")(
  function* (input: {
    readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly platform: NodeJS.Platform;
    readonly homeDir: string;
    readonly environment: Readonly<Record<string, string | undefined>>;
  }) {
    const cache = yield* Ref.make<ClaudeCloudCredentials | null>(null);

    const readKeychain = Effect.gen(function* () {
      if (input.platform !== "darwin") return null;
      const result = yield* spawnAndCollect(
        "security",
        ChildProcess.make("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"]),
      ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, input.spawner));
      return result.code === 0 && result.stdout.trim().length > 0 ? result.stdout.trim() : null;
    }).pipe(Effect.orElseSucceed(() => null));

    const readFile = Effect.gen(function* () {
      const configDir = input.environment.CLAUDE_CONFIG_DIR?.trim()
        ? input.environment.CLAUDE_CONFIG_DIR.trim()
        : input.path.join(input.homeDir, ".claude");
      return yield* input.fileSystem.readFileString(
        input.path.join(configDir, ".credentials.json"),
      );
    }).pipe(Effect.orElseSucceed(() => null));

    const load = Effect.gen(function* () {
      const raw = (yield* readKeychain) ?? (yield* readFile);
      if (raw === null) {
        return yield* new ClaudeCloudCredentialsError({ reason: "Missing" });
      }
      const nowMs = yield* Clock.currentTimeMillis;
      const credentials = yield* parseClaudeCredentials(raw, nowMs);
      yield* Ref.set(cache, credentials);
      return credentials;
    });

    const read = Effect.gen(function* () {
      const cached = yield* Ref.get(cache);
      const nowMs = yield* Clock.currentTimeMillis;
      if (
        cached !== null &&
        (cached.expiresAtMs === null || cached.expiresAtMs - EXPIRY_MARGIN_MS > nowMs)
      ) {
        return cached;
      }
      return yield* load;
    });

    return {
      read,
      invalidate: Ref.set(cache, null),
    } satisfies ClaudeCloudCredentialsReader;
  },
);
