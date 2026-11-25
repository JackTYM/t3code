// @effect-diagnostics nodeBuiltinImport:off -- a hash of a path, used as a cursor tiebreak.
import * as NodeCrypto from "node:crypto";

import * as HostProcess from "@t3tools/shared/HostProcess";
import type { BotMailBackfillPage, BotMailMessage } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { providerOfAccount, receiverAuth, type MailProvider } from "./MailAuthResults.ts";
import {
  emlxMessage,
  isBulkMail,
  parseMail,
  readHeaders,
  summarizeHeaders,
  type ParsedMail,
} from "./MailMessageParser.ts";

// Walks Mail's message files, not its Envelope Index: public descriptions of that database
// disagree on its date epoch and on how a row maps to a file. See docs/internals/bots.md.

export class MailAppUnsupportedPlatformError extends Schema.TaggedError<MailAppUnsupportedPlatformError>()(
  "MailAppUnsupportedPlatformError",
  { platform: Schema.String },
) {
  override get message(): string {
    return "Reading the Mail app's mail only works on a Mac. This environment is not one.";
  }
}

export class MailAppAccessDeniedError extends Schema.TaggedError<MailAppAccessDeniedError>()(
  "MailAppAccessDeniedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "macOS is blocking access to the Mail app's mail. On the Mac, open System Settings → Privacy & Security → Full Disk Access, turn it on for the app that runs the T3 Code server (the T3 Code app, or the terminal that started it), then quit and reopen that app and try again.";
  }
}

export class MailAppStoreMissingError extends Schema.TaggedError<MailAppStoreMissingError>()(
  "MailAppStoreMissingError",
  {},
) {
  override get message(): string {
    return "The Mail app has no mail stored on this Mac. Open Mail, add an account, and let it download mail first.";
  }
}

export class MailAppReadError extends Schema.TaggedError<MailAppReadError>()("MailAppReadError", {
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return "The Mail app's mail could not be read.";
  }
}

export class MailAppCursorError extends Schema.TaggedError<MailAppCursorError>()(
  "MailAppCursorError",
  {},
) {
  override get message(): string {
    return "That page cursor is not one this reader issued. Start again without a cursor.";
  }
}

export type MailAppReaderError =
  | MailAppUnsupportedPlatformError
  | MailAppAccessDeniedError
  | MailAppStoreMissingError
  | MailAppReadError
  | MailAppCursorError;

export class MailAppReader extends Context.Service<
  MailAppReader,
  {
    /** One page of inbound mail from the last `sinceDays` days, newest first. */
    readonly backfill: (input: {
      readonly sinceDays: number;
      readonly cursor?: string | undefined;
      readonly limit?: number | undefined;
    }) => Effect.Effect<typeof BotMailBackfillPage.Type, MailAppReaderError>;
  }
>()("t3/mail/MailAppReader") {}

const DAY_MS = 86_400_000;
const DEFAULT_LIMIT = 25;
// A file is written when its message is downloaded, never before the message was received, so a
// file older than the window holds older mail. The slack is for a Date header that runs ahead of
// the download by clock skew.
const MTIME_SLACK_MS = 2 * DAY_MS;
const INDEX_TTL_MS = 2 * 60_000;
const HEAD_BYTES = 32 * 1024;
const MESSAGE_READ_BYTES = 12 * 1024 * 1024 + 4096;
const ACCOUNT_SAMPLE = 25;
const MAX_DEPTH = 24;
const ACCOUNT_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

// Folders that hold no inbound mail, by the names Mail shows for Gmail, iCloud and other IMAP
// servers: drafts, junk, trash, the outbox, iCloud's notes, and Gmail's views of mail that is
// already in another folder. A folder with a name this list lacks (a translated one) is read, and
// the sender check below still drops what the user sent.
const SENT = /^(sent|sent messages|sent mail|sent items)$/u;
const SKIPPED =
  /^(drafts?|junk|junk e-?mail|spam|bulk mail|trash|bin|deleted messages|deleted items|outbox|notes|important|starred|chats)$/u;

interface Entry {
  readonly path: string;
  readonly accountId: string;
  readonly kind: "inbox" | "sent";
  readonly mtimeMs: number;
}

interface Account {
  readonly provider: MailProvider;
  /** The account's own addresses, the one Mail delivers to first. Empty if none could be found. */
  readonly addresses: ReadonlyArray<string>;
}

interface Index {
  readonly builtAtMs: number;
  readonly accounts: ReadonlyMap<string, Account>;
  readonly entries: ReadonlyArray<Entry>;
  /** What each file's own headers say, read once per index. */
  readonly dates: Map<string, number>;
}

const Cursor = Schema.fromJsonString(
  Schema.Struct({ t: Schema.Int, k: Schema.String.check(Schema.isPattern(/^[0-9a-f]{16}$/u)) }),
);
const decodeCursor = Schema.decodeUnknownOption(Cursor);
const encodeCursor = (cursor: { readonly t: number; readonly k: string }) =>
  Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
const fileKey = (path: string) =>
  NodeCrypto.createHash("sha256").update(path).digest("hex").slice(0, 16);

const reasonOf = (error: PlatformError) => error.reason._tag;

function toReaderError(error: PlatformError): MailAppReaderError {
  return reasonOf(error) === "PermissionDenied"
    ? new MailAppAccessDeniedError({ cause: error })
    : reasonOf(error) === "NotFound"
      ? new MailAppStoreMissingError()
      : new MailAppReadError({ cause: error });
}

const tally = (values: ReadonlyArray<string | undefined>) => {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (value !== undefined) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]).map(([address, count]) => ({ address, count }));
};

export interface MailAppReaderOptions {
  /** The `Mail` folder holding the `V<n>` directories. Defaults to the user's `~/Library/Mail`. */
  readonly mailDir?: string;
}

const make = Effect.fn("MailAppReader.make")(function* (options: MailAppReaderOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const mailDir = options.mailDir ?? path.join(yield* HostProcess.HomeDirectory, "Library", "Mail");
  const cache = yield* Ref.make<Index | undefined>(undefined);
  const building = (yield* Semaphore.make(1)).withPermits(1);

  const readPrefix = (file: string, max: number) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* fs.open(file);
        const buffer = new Uint8Array(max);
        let filled = 0;
        while (filled < max) {
          const read = yield* handle.read(buffer.subarray(filled));
          if (Number(read) === 0) break;
          filled += Number(read);
        }
        return buffer.subarray(0, filled);
      }),
    );

  // A directory that vanished while walking (Mail moves files as it syncs) is just empty.
  const listDirectory = (dir: string) =>
    fs.readDirectoryEntries(dir).pipe(
      Effect.catchIf(
        (error) => reasonOf(error) === "NotFound",
        () => Effect.succeed([]),
      ),
    );

  const walk = Effect.fn("MailAppReader.walk")(function* (
    accountId: string,
    dir: string,
    mailbox: ReadonlyArray<string>,
    kind: Entry["kind"],
    depth: number,
  ): Effect.fn.Return<Array<Entry>, PlatformError> {
    if (depth > MAX_DEPTH) return [];
    const listed = yield* listDirectory(dir);
    const subdirectories = listed.filter(
      (entry) => entry.type === "Directory" && entry.name !== "Attachments",
    );
    const files =
      mailbox.length > 0 && path.basename(dir) === "Messages"
        ? listed.filter((entry) => entry.type === "File" && entry.name.endsWith(".emlx"))
        : [];
    const here = yield* Effect.forEach(
      files,
      (file) =>
        fs.stat(path.join(dir, file.name)).pipe(
          Effect.map((info) => ({
            path: path.join(dir, file.name),
            accountId,
            kind,
            mtimeMs: Option.getOrElse(
              Option.map(info.mtime, (time) => time.getTime()),
              () => 0,
            ),
          })),
          Effect.catchIf(
            (error) => reasonOf(error) === "NotFound",
            () => Effect.undefined,
          ),
        ),
      { concurrency: 32 },
    );
    const below = yield* Effect.forEach(
      subdirectories,
      (entry) => {
        const isMailbox = entry.name.endsWith(".mbox");
        const name = isMailbox ? entry.name.slice(0, -".mbox".length) : undefined;
        const lowered = name?.toLowerCase();
        if (lowered !== undefined && SKIPPED.test(lowered)) return Effect.succeed([]);
        return walk(
          accountId,
          path.join(dir, entry.name),
          name === undefined ? mailbox : [...mailbox, name],
          lowered !== undefined && SENT.test(lowered) ? "sent" : kind,
          depth + 1,
        );
      },
      { concurrency: 8 },
    );
    return [...here.filter((entry) => entry !== undefined), ...below.flat()];
  });

  const headersOf = (file: string) =>
    readPrefix(file, HEAD_BYTES).pipe(Effect.map((bytes) => readHeaders(emlxMessage(bytes))));

  // An account's addresses are what its own mail says: the `From` of what it sent, and the
  // `Delivered-To` its provider added to what it received. Majority wins, so a forged header
  // on a few messages changes nothing.
  const analyseAccount = Effect.fn("MailAppReader.analyseAccount")(function* (
    dir: string,
    entries: ReadonlyArray<Entry>,
  ): Effect.fn.Return<Account, PlatformError> {
    const topLevel = yield* listDirectory(dir);
    const hasGmailFolder = topLevel.some((entry) =>
      ["[gmail].mbox", "[google mail].mbox"].includes(entry.name.toLowerCase()),
    );
    const newest = (kind: Entry["kind"]) =>
      entries
        .filter((entry) => entry.kind === kind)
        .toSorted((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, ACCOUNT_SAMPLE);
    const summaries = (kind: Entry["kind"]) =>
      Effect.forEach(
        newest(kind),
        (entry) =>
          headersOf(entry.path).pipe(
            Effect.map(summarizeHeaders),
            Effect.catchIf(
              (error) => reasonOf(error) !== "PermissionDenied",
              () => Effect.undefined,
            ),
          ),
        { concurrency: 8 },
      );
    const delivered = tally((yield* summaries("inbox")).map((summary) => summary?.deliveredTo));
    const sentFrom = tally((yield* summaries("sent")).map((summary) => summary?.from));
    const primary = delivered[0]?.address ?? sentFrom[0]?.address;
    const addresses = [
      ...new Set([
        ...(primary === undefined ? [] : [primary]),
        ...[...delivered, ...sentFrom].filter((row) => row.count >= 2).map((row) => row.address),
      ]),
    ];
    return { provider: providerOfAccount({ hasGmailFolder, addresses }), addresses };
  });

  const buildIndex = Effect.fn("MailAppReader.buildIndex")(function* (nowMs: number) {
    const root = yield* fs.readDirectoryEntries(mailDir);
    const version = root
      .flatMap((entry) => {
        const match = /^V(\d+)$/u.exec(entry.name);
        return entry.type === "Directory" && match !== null
          ? [{ name: entry.name, number: Number(match[1]) }]
          : [];
      })
      .toSorted((a, b) => b.number - a.number)[0];
    if (version === undefined) return yield* new MailAppStoreMissingError();
    const versionDir = path.join(mailDir, version.name);
    const accountDirs = (yield* fs.readDirectoryEntries(versionDir)).filter(
      (entry) => entry.type === "Directory" && ACCOUNT_DIR.test(entry.name),
    );
    const perAccount = yield* Effect.forEach(accountDirs, (entry) =>
      Effect.gen(function* () {
        const dir = path.join(versionDir, entry.name);
        const entries = yield* walk(entry.name, dir, [], "inbox", 0);
        return { id: entry.name, entries, account: yield* analyseAccount(dir, entries) };
      }),
    );
    return {
      builtAtMs: nowMs,
      accounts: new Map(perAccount.map((row) => [row.id, row.account])),
      entries: perAccount.flatMap((row) => row.entries),
      dates: new Map<string, number>(),
    } satisfies Index;
  });

  const currentIndex = Effect.fn("MailAppReader.currentIndex")(function* (nowMs: number) {
    return yield* building(
      Effect.gen(function* () {
        const cached = yield* Ref.get(cache);
        if (cached !== undefined && nowMs - cached.builtAtMs < INDEX_TTL_MS) return cached;
        const index = yield* buildIndex(nowMs).pipe(
          Effect.catchTags({ PlatformError: (error) => Effect.fail(toReaderError(error)) }),
        );
        yield* Ref.set(cache, index);
        return index;
      }),
    );
  });

  // The date a message is filed under: its own `Date` header, or when its file was written if
  // the header is missing, unreadable, or claims a time after now.
  const sentAtOf = Effect.fn("MailAppReader.sentAtOf")(function* (
    index: Index,
    entry: Entry,
    nowMs: number,
  ) {
    const known = index.dates.get(entry.path);
    if (known !== undefined) return known;
    const sentAt = yield* headersOf(entry.path).pipe(
      Effect.map((headers) => summarizeHeaders(headers).sentAtMs),
      Effect.catchIf(
        (error) => reasonOf(error) !== "PermissionDenied",
        () => Effect.undefined,
      ),
    );
    const date = sentAt === undefined || sentAt > nowMs + DAY_MS ? entry.mtimeMs : sentAt;
    index.dates.set(entry.path, date);
    return date;
  });

  const toMessage = (
    parsed: ParsedMail,
    account: Account | undefined,
    accountId: string,
    sentAtMs: number,
  ): BotMailMessage | undefined => {
    const known = account?.addresses ?? [];
    // What the user sent, or began writing, is not inbound mail.
    if (parsed.isDraft || (known.length > 0 && known.includes(parsed.from))) return undefined;
    const recipients = [
      ...(parsed.deliveredTo === undefined ? [] : [parsed.deliveredTo]),
      ...parsed.to,
      ...parsed.cc,
    ];
    const mailbox =
      recipients.find((address) => known.includes(address)) ??
      known[0] ??
      recipients[0] ??
      `${accountId.slice(0, 8).toLowerCase()}@mail-app.invalid`;
    return {
      messageId: parsed.messageId,
      mailbox,
      from: parsed.from,
      to: parsed.to,
      subject: parsed.subject,
      sentAt: DateTime.formatIso(DateTime.makeUnsafe(sentAtMs)),
      bodyText: parsed.bodyText,
      attachmentNames: parsed.attachmentNames,
      auth: receiverAuth(parsed.headers, account?.provider ?? "other"),
      origin: "backfill",
      bulk: isBulkMail(parsed.headers, parsed.from),
    };
  };

  const backfill: MailAppReader["Service"]["backfill"] = Effect.fn("MailAppReader.backfill")(
    function* (input) {
      if (platform !== "darwin") return yield* new MailAppUnsupportedPlatformError({ platform });
      const cursor =
        input.cursor === undefined
          ? undefined
          : decodeCursor(Buffer.from(input.cursor.slice(0, 200), "base64url").toString("utf8"));
      if (cursor !== undefined && Option.isNone(cursor)) return yield* new MailAppCursorError();
      const after = cursor === undefined ? undefined : Option.getOrThrow(cursor);
      const nowMs = yield* Clock.currentTimeMillis;
      const cutoff = nowMs - input.sinceDays * DAY_MS;
      const index = yield* currentIndex(nowMs);

      const dated = yield* Effect.forEach(
        index.entries.filter(
          (entry) => entry.kind === "inbox" && entry.mtimeMs >= cutoff - MTIME_SLACK_MS,
        ),
        (entry) =>
          sentAtOf(index, entry, nowMs).pipe(
            Effect.map((sentAtMs) => ({ entry, sentAtMs, key: fileKey(entry.path) })),
          ),
        { concurrency: 16 },
      ).pipe(Effect.mapError(toReaderError));
      const inWindow = dated
        .filter((row) => row.sentAtMs >= cutoff)
        .toSorted(
          (a, b) => b.sentAtMs - a.sentAtMs || (a.key < b.key ? 1 : a.key > b.key ? -1 : 0),
        );
      const remaining =
        after === undefined
          ? inWindow
          : inWindow.filter(
              (row) => row.sentAtMs < after.t || (row.sentAtMs === after.t && row.key < after.k),
            );
      const page = remaining.slice(0, input.limit ?? DEFAULT_LIMIT);

      const loaded = yield* Effect.forEach(
        page,
        (row) =>
          readPrefix(row.entry.path, MESSAGE_READ_BYTES).pipe(
            Effect.map((bytes) =>
              toMessage(
                parseMail(emlxMessage(bytes)),
                index.accounts.get(row.entry.accountId),
                row.entry.accountId,
                row.sentAtMs,
              ),
            ),
            // A file that cannot be read is skipped; only a permission failure stops the page.
            Effect.catchIf(
              (error) => reasonOf(error) !== "PermissionDenied",
              () => Effect.undefined,
            ),
          ),
        { concurrency: 8 },
      ).pipe(Effect.mapError(toReaderError));

      const last = page.at(-1);
      return {
        messages: loaded.filter((message) => message !== undefined),
        ...(last !== undefined && remaining.length > page.length
          ? { nextCursor: encodeCursor({ t: last.sentAtMs, k: last.key }) }
          : {}),
        accounts: [
          ...new Set(
            [...index.accounts.values()].flatMap((account) => account.addresses.slice(0, 1)),
          ),
        ],
      };
    },
  );

  return MailAppReader.of({ backfill });
});

export const layer = Layer.effect(MailAppReader, make({}));

/** For tests: a store somewhere other than the home directory. */
export const layerWith = (options: MailAppReaderOptions) =>
  Layer.effect(MailAppReader, make(options));
