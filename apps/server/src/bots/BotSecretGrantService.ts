import {
  BOT_SECRET_GRANT_MIN_VALUE_LENGTH,
  BOT_SECRET_GRANTS_MAX_PER_BOT,
  BotSecretGrant,
  BotSecretGrantError,
  BotSecretGrantName,
  type BotSecretGrantListResult,
  type BotSecretGrantSetInput,
  IsoDateTime,
  SecretReference,
  type ThreadId,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as PayloadSigner from "../auth/PayloadSigner.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as BotService from "./BotService.ts";

// Grants live in `<stateDir>/bot-secret-grants.json`, signed with a key in the secret store. The
// Bot can write its memory folder and its watchers' files, so a grant kept there it could give
// itself. The file holds names, hosts and a reference, never a value: a stored value lives in the
// secret store, and a reference is read through the secret provider at each use.

// The newest version this service saved is kept in the secret store, outside the file: a restored
// older copy is signed correctly and would otherwise be believed.
const VERSION_SECRET = "bot-secret-grants-version";
const REJECTED_FILE = /^bot-secret-grants\.json\.rejected\.(\d+)(?:-(\d+))?$/u;
const MAX_REJECTED_FILES = 5;
// A watcher polls every minute or so: stamping each run would rewrite the signed file and its
// version that often.
const USE_STAMP_INTERVAL_MS = 60 * 60_000;

const GrantRecord = Schema.Struct({
  hosts: BotSecretGrant.fields.hosts,
  value: Schema.Union([
    Schema.Struct({ type: Schema.Literal("stored") }),
    Schema.Struct({ type: Schema.Literal("reference"), reference: SecretReference }),
  ]),
  lastUsedAt: Schema.optional(IsoDateTime),
});
type GrantRecord = typeof GrantRecord.Type;

/** By Bot memory folder, then grant name. */
const State = Schema.Struct({
  grants: Schema.Record(Schema.String, Schema.Record(BotSecretGrantName, GrantRecord)),
  version: Schema.Int,
});
type State = typeof State.Type;

// `data` stays the exact text that was signed, so the signature is checked over what was read.
const SignedFile = Schema.fromJsonString(
  Schema.Struct({ data: Schema.String, signature: Schema.String }),
);
const StateJson = Schema.fromJsonString(State);
const decodeSignedFile = Schema.decodeEffect(SignedFile);
const encodeSignedFile = Schema.encodeEffect(SignedFile);
const decodeState = Schema.decodeEffect(StateJson);
const encodeState = Schema.encodeEffect(StateJson);

interface Started {
  readonly state: State;
  /** False when the file or secrets could not be read: nothing is changed until they can be. */
  readonly writable: boolean;
  readonly trust: BotSecretGrantListResult["approvals"];
}

const empty = (version: number): State => ({ grants: {}, version });

// `hasOwn`: a caller's name may be `constructor`, which a plain lookup finds on the prototype.
const recordIn = (state: State, folder: string, name: string): GrantRecord | undefined => {
  const records = Object.hasOwn(state.grants, folder) ? state.grants[folder] : undefined;
  return records !== undefined && Object.hasOwn(records, name) ? records[name] : undefined;
};

const encodeBytes = (text: string) => new TextEncoder().encode(text);
const decodeBytes = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

export class BotSecretGrantService extends Context.Service<
  BotSecretGrantService,
  {
    /** A Bot's grants, without their values. `unverified`: the saved file failed its signature check at start. */
    readonly list: (botThreadId: ThreadId) => Effect.Effect<BotSecretGrantListResult>;
    /** The user gives a Bot a secret, or replaces what it was given under that name. */
    readonly set: (input: {
      readonly botThreadId: ThreadId;
      readonly name: BotSecretGrantName;
      readonly hosts: BotSecretGrant["hosts"];
      readonly value: BotSecretGrantSetInput["value"];
    }) => Effect.Effect<void, BotSecretGrantError>;
    /**
     * The user changes where a grant may be sent and keeps its value or reference as it is.
     * `source` is the kind the caller saw (the permission was decided from it), so a grant that is
     * no longer that kind is refused as `changed`.
     */
    readonly setHosts: (input: {
      readonly botThreadId: ThreadId;
      readonly name: string;
      readonly hosts: BotSecretGrant["hosts"];
      readonly source: BotSecretGrant["source"];
    }) => Effect.Effect<void, BotSecretGrantError>;
    /** The user takes a grant back, with its stored value. */
    readonly remove: (input: {
      readonly botThreadId: ThreadId;
      readonly name: string;
    }) => Effect.Effect<void, BotSecretGrantError>;
    /**
     * Every grant of a Bot that is gone, with its stored values. Home keeps its grants: every Home
     * shares one memory folder, so a deleted Home thread is not the end of them.
     */
    readonly removeAll: (input: {
      readonly botThreadId: ThreadId;
    }) => Effect.Effect<void, BotSecretGrantError>;
    /**
     * The value for a run, only when the grant covers every host the run names. For the server's
     * own use: no RPC or tool reaches it, and a miss says one fixed reason and nothing of the value.
     */
    readonly resolve: (input: {
      readonly botThreadId: ThreadId;
      readonly name: string;
      readonly hosts: ReadonlyArray<string>;
    }) => Effect.Effect<
      | { readonly _tag: "Ok"; readonly value: Redacted.Redacted<string> }
      | {
          readonly _tag: "Missing";
          readonly reason: "not granted" | "host not covered" | "unreadable";
        }
    >;
  }
>()("t3/bots/BotSecretGrantService") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const bots = yield* BotService.BotService;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const resolver = yield* SecretResolver.SecretResolver;
  const signer = yield* PayloadSigner.make("bot-secret-grants-key");
  const statePath = path.join(config.stateDir, "bot-secret-grants.json");
  const locked = (yield* Semaphore.make(1)).withPermits(1);

  const rejectedAt = (at: number, copy: number) =>
    `${statePath}.rejected.${at}${copy === 0 ? "" : `-${copy}`}`;

  const verifiedLoad = Effect.gen(function* () {
    const lastVersion = Option.match(yield* secrets.get(VERSION_SECRET), {
      onNone: () => 0,
      onSome: (value) => Number.parseInt(decodeBytes(value), 10),
    });
    if (!Number.isSafeInteger(lastVersion) || lastVersion < 0) return yield* Effect.fail("version");
    const text = yield* fileSystem.readFileString(statePath).pipe(
      Effect.catchIf(
        (cause) => cause._tag === "PlatformError" && cause.reason._tag === "NotFound",
        () => Effect.undefined,
      ),
    );
    const rejected = (reason: string) => ({ state: empty(lastVersion), reason });
    if (text === undefined) return { state: empty(lastVersion), reason: undefined };
    // What was read but is not a signed state will not become one by waiting. A read, the secret
    // store or the key that fail may pass, and are left to the caller.
    const signed = yield* decodeSignedFile(text).pipe(
      Effect.catchIf(Schema.isSchemaError, () => Effect.undefined),
    );
    if (signed === undefined) return rejected("is not a signed file");
    if (!(yield* signer.verify(signed.data, signed.signature))) {
      return rejected("failed its signature");
    }
    const decoded = yield* decodeState(signed.data).pipe(
      Effect.catchIf(Schema.isSchemaError, () => Effect.undefined),
    );
    if (decoded === undefined) return rejected("is not a state");
    return decoded.version >= lastVersion
      ? { state: decoded, reason: undefined }
      : rejected("is older than the last save");
  });

  /** Moves the file to `bot-secret-grants.json.rejected.<time>`, never over an earlier one, and keeps the newest few. */
  const setAsideRejected = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    let target = rejectedAt(now, 0);
    for (let copy = 1; yield* fileSystem.exists(target); copy += 1) target = rejectedAt(now, copy);
    yield* fileSystem.rename(statePath, target);
    yield* fileSystem.readDirectory(config.stateDir).pipe(
      Effect.flatMap((names) => {
        const newestFirst = names
          .flatMap((name) => {
            const match = REJECTED_FILE.exec(name);
            return match === null
              ? []
              : [{ name, at: Number(match[1]), copy: Number(match[2] ?? 0) }];
          })
          .toSorted((a, b) => b.at - a.at || b.copy - a.copy);
        return Effect.forEach(
          newestFirst.slice(MAX_REJECTED_FILES),
          ({ name }) => fileSystem.remove(path.join(config.stateDir, name)),
          { discard: true },
        );
      }),
      Effect.catch((cause) =>
        Effect.logWarning("Older rejected secret grants could not be removed.", { cause }),
      ),
    );
  });

  // A file that cannot be vouched for is moved aside and its grants dropped. A file or secret that
  // could not be read is evidence of nothing: it is left as it is, no grant is in effect and none
  // can be changed until a later call reads them. Stored values are never touched.
  const start = verifiedLoad.pipe(
    Effect.flatMap((loaded) =>
      loaded.reason === undefined
        ? Effect.succeed<Started>({ state: loaded.state, writable: true, trust: "ok" })
        : Effect.logWarning(
            `Secret grants ${loaded.reason}; they were set aside and the service starts without them.`,
          ).pipe(
            Effect.andThen(setAsideRejected),
            Effect.as<Started>({ state: loaded.state, writable: true, trust: "unverified" }),
          ),
    ),
    Effect.catch((cause) =>
      Effect.logWarning(
        "Secret grants could not be read or set aside; they were left as they are and none is in effect until they can be read.",
        { cause },
      ).pipe(Effect.as<Started>({ state: empty(0), writable: false, trust: "unreadable" })),
    ),
  );
  const initial = yield* start;
  const state = yield* Ref.make(initial.state);
  const readable = yield* Ref.make(initial.writable);
  // `unverified` describes the file found at start: it ends once a good signed file replaces it.
  const trust = yield* Ref.make(initial.trust);
  /** Reads the grants again when the last read failed; whether they are read now. */
  const recover = Effect.gen(function* () {
    if (yield* Ref.get(readable)) return true;
    const started = yield* start;
    if (!started.writable) return false;
    yield* Ref.set(state, started.state);
    yield* Ref.set(trust, started.trust);
    yield* Ref.set(readable, true);
    return true;
  });
  // Counts changes per grant. A run reads its value without the lock, and a grant changed or
  // removed meanwhile must not be answered from that read.
  const changes = new Map<string, number>();
  const changesOf = (folder: string, name: string) => changes.get(`${folder}/${name}`) ?? 0;
  const noteChange = (folder: string, name: string) =>
    changes.set(`${folder}/${name}`, changesOf(folder, name) + 1);

  /** Saves the grants of every Bot with `name`'s record replaced (none removes it). */
  const commit = Effect.fn("BotSecretGrantService.commit")(
    function* (folder: string, name: string, record: GrantRecord | undefined) {
      const current = yield* Ref.get(state);
      const others = Object.entries(current.grants[folder] ?? {}).filter(([key]) => key !== name);
      const names = Object.fromEntries(record === undefined ? others : [...others, [name, record]]);
      const grants = Object.fromEntries(
        Object.entries({ ...current.grants, [folder]: names }).filter(
          ([, entries]) => Object.keys(entries).length > 0,
        ),
      );
      const next: State = { grants, version: current.version + 1 };
      if (yield* Ref.get(readable)) {
        const data = yield* encodeState(next);
        const text = yield* encodeSignedFile({ data, signature: yield* signer.sign(data) });
        // Renamed into place, so a crash cannot leave a half-written file that reads as no grants.
        const temporary = `${statePath}.tmp`;
        yield* fileSystem.makeDirectory(config.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(temporary, text, { mode: 0o600 });
        yield* fileSystem.rename(temporary, statePath);
        // After the file, so a crash between them leaves the file newer than the count, never older.
        yield* Ref.set(trust, "ok");
        yield* secrets
          .set(VERSION_SECRET, encodeBytes(String(next.version)))
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Secret grants version could not be kept.", { cause }),
            ),
          );
      }
      yield* Ref.set(state, next);
    },
    // Uninterruptible: a stop between the rename and the Ref must not leave the file ahead of memory.
    Effect.uninterruptible,
  );

  // The folder holds `[A-Za-z0-9_~-]` and a grant name has no `-`, so no two grants share a name.
  const storedSecretName = (folder: string, name: string) => `bot-grant-${folder}-${name}`;

  const failure = (
    threadId: ThreadId,
    name: string | undefined,
    reason: BotSecretGrantError["reason"],
  ) =>
    new BotSecretGrantError({
      threadId,
      ...(name === undefined ? {} : { grant: name }),
      reason,
    });
  const ioError = (threadId: ThreadId, name: string) => (cause: unknown) =>
    new BotSecretGrantError({ threadId, grant: name, reason: "io", cause });

  const list: BotSecretGrantService["Service"]["list"] = Effect.fn("BotSecretGrantService.list")(
    function* (botThreadId) {
      if (!(yield* Ref.get(readable))) yield* locked(recover);
      const records =
        (yield* Ref.get(state)).grants[BotService.memoryFolderName(botThreadId)] ?? {};
      return {
        grants: Object.entries(records)
          .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([name, { hosts, value, lastUsedAt }]) => ({
            name,
            hosts,
            source: value.type,
            ...(lastUsedAt === undefined ? {} : { lastUsedAt }),
          })),
        approvals: yield* Ref.get(trust),
      };
    },
  );

  const set: BotSecretGrantService["Service"]["set"] = Effect.fn("BotSecretGrantService.set")(
    function* ({ botThreadId, name, hosts, value }) {
      if (!(yield* bots.isBot(botThreadId))) return yield* failure(botThreadId, name, "not_a_bot");
      const secret = value.type === "stored" ? Redacted.value(value.secret) : undefined;
      if (secret !== undefined && secret.trim() === "") {
        return yield* failure(botThreadId, name, "invalid");
      }
      if (secret !== undefined && secret.trim().length < BOT_SECRET_GRANT_MIN_VALUE_LENGTH) {
        return yield* failure(botThreadId, name, "too_short");
      }
      const folder = BotService.memoryFolderName(botThreadId);
      const valueName = storedSecretName(folder, name);
      yield* Effect.gen(function* () {
        if (!(yield* recover)) return yield* failure(botThreadId, name, "unreadable");
        const current = yield* Ref.get(state);
        const existing = recordIn(current, folder, name);
        if (
          existing === undefined &&
          Object.keys(current.grants[folder] ?? {}).length >= BOT_SECRET_GRANTS_MAX_PER_BOT
        ) {
          return yield* failure(botThreadId, name, "limit");
        }
        noteChange(folder, name);
        // What a failed save puts back: the value this grant held, or nothing for a new one.
        const previous =
          secret !== undefined && existing?.value.type === "stored"
            ? yield* secrets.get(valueName).pipe(
                Effect.map(Option.getOrUndefined),
                Effect.catch(() => Effect.undefined),
              )
            : undefined;
        if (secret !== undefined) {
          yield* secrets
            .set(valueName, encodeBytes(secret))
            .pipe(Effect.mapError(ioError(botThreadId, name)));
        }
        // Replaced, so what a Bot was last given does not carry its time of use to the new value.
        yield* commit(folder, name, {
          hosts: [...new Set(hosts)],
          value:
            value.type === "stored"
              ? { type: "stored" }
              : { type: "reference", reference: value.reference },
        }).pipe(
          // A new value must not be left under the old hosts, nor the old one lost.
          Effect.tapError(() =>
            secret === undefined
              ? Effect.void
              : Effect.ignore(
                  previous === undefined
                    ? secrets.remove(valueName)
                    : secrets.set(valueName, previous),
                ),
          ),
          Effect.mapError(ioError(botThreadId, name)),
        );
        if (value.type === "reference" && existing?.value.type === "stored") {
          yield* secrets
            .remove(valueName)
            .pipe(
              Effect.catch((cause) =>
                Effect.logWarning("A replaced stored secret could not be removed.", { cause }),
              ),
            );
        }
      }).pipe(Effect.ensuring(Effect.sync(() => noteChange(folder, name))), locked);
    },
  );

  // The caller holds the lock.
  const removeLocked = Effect.fn("BotSecretGrantService.removeLocked")(function* (
    botThreadId: ThreadId,
    folder: string,
    name: string,
  ) {
    noteChange(folder, name);
    // The value first: a failure leaves a grant that resolves to nothing, which a retry finishes.
    yield* secrets
      .remove(storedSecretName(folder, name))
      .pipe(Effect.mapError(ioError(botThreadId, name)));
    yield* commit(folder, name, undefined).pipe(Effect.mapError(ioError(botThreadId, name)));
  });

  const remove: BotSecretGrantService["Service"]["remove"] = Effect.fn(
    "BotSecretGrantService.remove",
  )(function* ({ botThreadId, name }) {
    const folder = BotService.memoryFolderName(botThreadId);
    yield* Effect.gen(function* () {
      if (!(yield* recover)) return yield* failure(botThreadId, name, "unreadable");
      const existing = recordIn(yield* Ref.get(state), folder, name);
      if (existing === undefined) return yield* failure(botThreadId, name, "not_found");
      yield* removeLocked(botThreadId, folder, name);
    }).pipe(Effect.ensuring(Effect.sync(() => noteChange(folder, name))), locked);
  });

  const removeAll: BotSecretGrantService["Service"]["removeAll"] = Effect.fn(
    "BotSecretGrantService.removeAll",
  )(function* ({ botThreadId }) {
    const folder = BotService.memoryFolderName(botThreadId);
    if (folder === BotService.HOME_MEMORY_FOLDER) return;
    yield* Effect.gen(function* () {
      if (!(yield* recover)) return yield* failure(botThreadId, undefined, "unreadable");
      const names = Object.keys((yield* Ref.get(state)).grants[folder] ?? {});
      yield* Effect.forEach(
        names,
        (name) =>
          removeLocked(botThreadId, folder, name).pipe(
            Effect.ensuring(Effect.sync(() => noteChange(folder, name))),
          ),
        { discard: true },
      );
    }).pipe(locked);
  });

  const setHosts: BotSecretGrantService["Service"]["setHosts"] = Effect.fn(
    "BotSecretGrantService.setHosts",
  )(function* ({ botThreadId, name, hosts, source }) {
    const folder = BotService.memoryFolderName(botThreadId);
    yield* Effect.gen(function* () {
      if (!(yield* recover)) return yield* failure(botThreadId, name, "unreadable");
      const existing = recordIn(yield* Ref.get(state), folder, name);
      if (existing === undefined) return yield* failure(botThreadId, name, "not_found");
      if (existing.value.type !== source) return yield* failure(botThreadId, name, "changed");
      noteChange(folder, name);
      // The rest of the record stays: the value is the same, so its time of use still holds.
      yield* commit(folder, name, { ...existing, hosts: [...new Set(hosts)] }).pipe(
        Effect.mapError(ioError(botThreadId, name)),
      );
    }).pipe(Effect.ensuring(Effect.sync(() => noteChange(folder, name))), locked);
  });

  const readValue = (folder: string, name: string, record: GrantRecord) =>
    record.value.type === "stored"
      ? secrets.get(storedSecretName(folder, name)).pipe(
          Effect.map(Option.map(decodeBytes)),
          Effect.map(Option.getOrUndefined),
          Effect.catch((cause) =>
            Effect.logWarning("A stored secret grant could not be read.", { cause }).pipe(
              Effect.as(undefined),
            ),
          ),
        )
      : resolver.read([record.value.reference]).pipe(Effect.map(([read]) => read));

  const resolve: BotSecretGrantService["Service"]["resolve"] = Effect.fn(
    "BotSecretGrantService.resolve",
  )(function* ({ botThreadId, name, hosts }) {
    if (!(yield* Ref.get(readable))) yield* locked(recover);
    const folder = BotService.memoryFolderName(botThreadId);
    // Taken before the record, so a change in between is seen as one.
    const seenChanges = changesOf(folder, name);
    const record = recordIn(yield* Ref.get(state), folder, name);
    if (record === undefined) return { _tag: "Missing", reason: "not granted" } as const;
    if (hosts.length === 0 || !hosts.every((host) => record.hosts.includes(host))) {
      return { _tag: "Missing", reason: "host not covered" } as const;
    }
    // Outside the lock: a provider may take a while to unlock, and the user's changes wait for nobody.
    const value = yield* readValue(folder, name, record);
    if (value === undefined || value.trim().length < BOT_SECRET_GRANT_MIN_VALUE_LENGTH) {
      return { _tag: "Missing", reason: "unreadable" } as const;
    }
    return yield* Effect.gen(function* () {
      const latest = recordIn(yield* Ref.get(state), folder, name);
      if (latest === undefined || changesOf(folder, name) !== seenChanges) {
        return { _tag: "Missing", reason: "not granted" } as const;
      }
      const now = yield* DateTime.now;
      const lastUse = latest.lastUsedAt === undefined ? undefined : Date.parse(latest.lastUsedAt);
      if (
        lastUse === undefined ||
        Number.isNaN(lastUse) ||
        DateTime.toEpochMillis(now) - lastUse >= USE_STAMP_INTERVAL_MS
      ) {
        // The time of use is for the user's list: a save that fails does not hold back the run.
        yield* commit(folder, name, { ...latest, lastUsedAt: DateTime.formatIso(now) }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("The time a secret grant was used could not be saved.", { cause }),
          ),
        );
      }
      return { _tag: "Ok", value: Redacted.make(value) } as const;
    }).pipe(locked);
  });

  return BotSecretGrantService.of({ list, set, setHosts, remove, removeAll, resolve });
});

export const layer = Layer.effect(BotSecretGrantService, make);
