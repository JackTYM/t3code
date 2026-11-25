import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { BotMailBackfillPage } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { systemError } from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as MailAppReader from "./MailAppReader.ts";
import {
  layerOnPlatform,
  rfc822,
  writeMailStore,
  type FixtureAccount,
} from "./MailAppReader.testkit.ts";

const NOW = "2025-06-15T12:00:00.000Z";
const GMAIL = "AAAAAAAA-0000-4000-8000-000000000001";
const ICLOUD = "BBBBBBBB-0000-4000-8000-000000000002";
const decodePage = Schema.decodeUnknownSync(BotMailBackfillPage);

const GOOGLE_AUTH =
  "mx.google.com; dkim=pass header.i=@news.test; spf=pass smtp.mailfrom=n@news.test; dmarc=pass header.from=news.test";
const ICLOUD_AUTH =
  'bimi.icloud.com; bimi=skipped reason="insufficient dmarc"; dkim=pass header.d=news.test; dmarc=pass header.from=news.test; spf=pass smtp.mailfrom=n@news.test';
const NO_VERDICT = { dkim: "none", spf: "none", dmarc: "none", source: "mail-app" } as const;

type FixtureMessages = FixtureAccount["mailboxes"][number]["messages"];

const mail = (
  id: string,
  fields: {
    readonly from?: string;
    readonly to?: string;
    readonly subject?: string;
    readonly date: string;
    readonly extra?: ReadonlyArray<readonly [string, string]>;
    readonly body?: string;
  },
) => ({
  id,
  downloadedAt: fields.date,
  raw: rfc822(
    [
      ...(fields.extra ?? []),
      ["Message-ID", `<${id}@news.test>`],
      ["From", fields.from ?? "News <n@news.test>"],
      ["To", fields.to ?? "me@gmail.test"],
      ["Subject", fields.subject ?? `Subject ${id}`],
      ["Date", DateTime.toDateUtc(DateTime.makeUnsafe(fields.date)).toUTCString()],
    ],
    fields.body ?? `body of ${id}`,
  ),
});

// A Gmail account with the Sent Mail its address can be worked out from.
const gmailAccount = (inbox: FixtureMessages): FixtureAccount => ({
  id: GMAIL,
  mailboxes: [
    { folder: ["INBOX"], messages: inbox },
    {
      folder: ["[Gmail]", "Sent Mail"],
      messages: [
        mail("sent1", { from: "me@gmail.test", to: "x@y.test", date: "2025-06-01T10:00:00Z" }),
        mail("sent2", { from: "Me <me@gmail.test>", to: "x@y.test", date: "2025-06-02T10:00:00Z" }),
      ],
    },
  ],
});

/** Builds a store in a temp directory and gives the test a reader over it, at `NOW`. */
const withStore = <A, E>(
  accounts: ReadonlyArray<FixtureAccount>,
  run: (reader: MailAppReader.MailAppReader["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mail-" });
      yield* writeMailStore(root, accounts);
      yield* TestClock.setTime(Date.parse(NOW));
      const context = yield* Layer.build(layerOnPlatform("darwin", root));
      return yield* run(Context.get(context, MailAppReader.MailAppReader));
    }),
  ).pipe(Effect.provide(NodeServices.layer));

const subjects = (page: { readonly messages: ReadonlyArray<{ readonly subject: string }> }) =>
  page.messages.map((message) => message.subject);

it.effect("pages newest first with a cursor, and the cursor survives a new index", () =>
  withStore(
    [
      gmailAccount([
        mail("a", { date: "2025-06-14T09:00:00Z" }),
        mail("b", { date: "2025-06-13T09:00:00Z" }),
        mail("c", { date: "2025-06-12T09:00:00Z" }),
        mail("d", { date: "2025-06-11T09:00:00Z" }),
        mail("e", { date: "2025-06-10T09:00:00Z" }),
      ]),
    ],
    (reader) =>
      Effect.gen(function* () {
        const first = yield* reader.backfill({ sinceDays: 30, limit: 2 });
        assert.deepStrictEqual(subjects(first), ["Subject a", "Subject b"]);
        assert.isString(first.nextCursor);

        const second = yield* reader.backfill({
          sinceDays: 30,
          limit: 2,
          cursor: first.nextCursor,
        });
        assert.deepStrictEqual(subjects(second), ["Subject c", "Subject d"]);

        // Past the index's lifetime a page is read again from scratch and continues exactly
        // where the cursor said.
        yield* TestClock.adjust("5 minutes");
        const third = yield* reader.backfill({
          sinceDays: 30,
          limit: 2,
          cursor: second.nextCursor,
        });
        assert.deepStrictEqual(subjects(third), ["Subject e"]);
        assert.isUndefined(third.nextCursor);

        // Every page decodes against the contract the box decodes with.
        for (const page of [first, second, third]) decodePage(page);
      }),
  ),
);

it.effect("keeps messages that share a timestamp in a stable order across pages", () =>
  withStore(
    [
      gmailAccount(
        ["a", "b", "c", "d", "e", "f"].map((id) => mail(id, { date: "2025-06-14T09:00:00Z" })),
      ),
    ],
    (reader) =>
      Effect.gen(function* () {
        const seen: Array<string> = [];
        let cursor: string | undefined;
        do {
          const page = yield* reader.backfill({ sinceDays: 7, limit: 2, cursor });
          seen.push(...subjects(page));
          cursor = page.nextCursor;
        } while (cursor !== undefined);
        assert.deepStrictEqual(
          seen.toSorted(),
          ["a", "b", "c", "d", "e", "f"].map((id) => `Subject ${id}`),
        );
      }),
  ),
);

it.effect("returns only mail from the last sinceDays days, by the Date header", () =>
  withStore(
    [
      gmailAccount([
        mail("recent", { date: "2025-06-14T09:00:00Z" }),
        mail("weekOld", { date: "2025-06-08T09:00:00Z" }),
        mail("monthOld", { date: "2025-05-20T09:00:00Z" }),
        // Downloaded yesterday, sent two months ago: Mail syncing old mail to a new Mac.
        {
          ...mail("syncedLate", { date: "2025-04-01T09:00:00Z" }),
          downloadedAt: "2025-06-14T09:00:00Z",
        },
      ]),
    ],
    (reader) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(subjects(yield* reader.backfill({ sinceDays: 3 })), [
          "Subject recent",
        ]);
        assert.deepStrictEqual(subjects(yield* reader.backfill({ sinceDays: 10 })), [
          "Subject recent",
          "Subject weekOld",
        ]);
        assert.deepStrictEqual(subjects(yield* reader.backfill({ sinceDays: 90 })), [
          "Subject recent",
          "Subject weekOld",
          "Subject monthOld",
          "Subject syncedLate",
        ]);
      }),
  ),
);

it.effect(
  "reads inbound folders only: not sent, drafts, junk, trash, outbox, notes or Gmail's views",
  () =>
    withStore(
      [
        {
          id: GMAIL,
          mailboxes: [
            { folder: ["INBOX"], messages: [mail("inbox", { date: "2025-06-14T09:00:00Z" })] },
            {
              folder: ["[Gmail]", "All Mail"],
              messages: [
                mail("archived", { date: "2025-06-13T09:00:00Z" }),
                // All Mail also holds what the user sent, and drafts being written.
                mail("sentCopy", {
                  from: "me@gmail.test",
                  to: "x@y.test",
                  date: "2025-06-13T10:00:00Z",
                }),
                mail("draft", {
                  from: "other@gmail.test",
                  to: "x@y.test",
                  date: "2025-06-13T11:00:00Z",
                  extra: [["X-Uniform-Type-Identifier", "com.apple.mail-draft"]],
                }),
              ],
            },
            ...["Drafts", "Spam", "Trash", "Important", "Starred", "Bin"].map((name) => ({
              folder: ["[Gmail]", name],
              messages: [mail(`in-${name}`, { date: "2025-06-14T08:00:00Z" })],
            })),
            {
              folder: ["[Gmail]", "Sent Mail"],
              messages: [
                mail("s1", { from: "me@gmail.test", to: "x@y.test", date: "2025-06-14T10:00:00Z" }),
                mail("s2", { from: "me@gmail.test", to: "x@y.test", date: "2025-06-14T11:00:00Z" }),
              ],
            },
          ],
        },
        {
          id: ICLOUD,
          mailboxes: [
            {
              folder: ["INBOX"],
              messages: [
                mail("icloudInbox", { to: "me@icloud.test", date: "2025-06-14T07:00:00Z" }),
              ],
            },
            ...["Junk", "Deleted Messages", "Drafts", "Sent Messages", "Outbox", "Notes"].map(
              (name) => ({
                folder: [name],
                messages: [
                  mail(`ic-${name}`, {
                    ...(name === "Sent Messages" ? { from: "me@icloud.test" } : {}),
                    to: "me@icloud.test",
                    date: "2025-06-14T06:00:00Z",
                  }),
                ],
              }),
            ),
            {
              folder: ["Archive"],
              messages: [
                mail("icloudArchive", { to: "me@icloud.test", date: "2025-06-12T07:00:00Z" }),
              ],
            },
            {
              folder: ["Receipts", "2025"],
              messages: [mail("nested", { to: "me@icloud.test", date: "2025-06-11T07:00:00Z" })],
            },
          ],
        },
      ],
      (reader) =>
        Effect.gen(function* () {
          const page = yield* reader.backfill({ sinceDays: 30, limit: 50 });
          assert.deepStrictEqual(subjects(page), [
            "Subject inbox",
            "Subject icloudInbox",
            "Subject archived",
            "Subject icloudArchive",
            "Subject nested",
          ]);
        }),
    ),
);

it.effect("tells which account each message belongs to and lists the account addresses", () =>
  withStore(
    [
      {
        id: GMAIL,
        mailboxes: [
          {
            folder: ["INBOX"],
            messages: [
              // Gmail adds Delivered-To for the address it delivered to, an alias included.
              mail("toMain", {
                date: "2025-06-14T09:00:00Z",
                extra: [["Delivered-To", "me@gmail.test"]],
              }),
              mail("toAlias", {
                to: "list@lists.test",
                date: "2025-06-13T09:00:00Z",
                extra: [["Delivered-To", "me+shop@gmail.test"]],
              }),
              mail("forged", {
                date: "2025-06-12T09:00:00Z",
                extra: [["Delivered-To", "me@gmail.test"]],
                body: "Delivered-To: attacker@evil.test",
              }),
              ...["1", "2", "3"].map((n) =>
                mail(`filler${n}`, {
                  date: "2025-06-10T09:00:00Z",
                  extra: [["Delivered-To", "me@gmail.test"]],
                }),
              ),
              ...["1", "2"].map((n) =>
                mail(`aliased${n}`, {
                  date: "2025-06-09T09:00:00Z",
                  extra: [["Delivered-To", "me+shop@gmail.test"]],
                }),
              ),
            ],
          },
        ],
      },
      {
        // iCloud adds no Delivered-To: the address is what the user sends from.
        id: ICLOUD,
        mailboxes: [
          {
            folder: ["INBOX"],
            messages: [mail("ic", { to: "someone-else@lists.test", date: "2025-06-14T08:00:00Z" })],
          },
          {
            folder: ["Sent Messages"],
            messages: [1, 2, 3].map((n) =>
              mail(`isent${n}`, {
                from: "Me <me@icloud.test>",
                to: "x@y.test",
                date: "2025-06-01T10:00:00Z",
              }),
            ),
          },
        ],
      },
    ],
    (reader) =>
      Effect.gen(function* () {
        const page = yield* reader.backfill({ sinceDays: 30, limit: 50 });
        assert.deepStrictEqual(page.accounts.toSorted(), ["me@gmail.test", "me@icloud.test"]);
        const mailboxOf = (subject: string) =>
          page.messages.find((message) => message.subject === subject)?.mailbox;
        assert.strictEqual(mailboxOf("Subject toMain"), "me@gmail.test");
        assert.strictEqual(mailboxOf("Subject toAlias"), "me+shop@gmail.test");
        assert.strictEqual(mailboxOf("Subject ic"), "me@icloud.test");
        // Text in a body that looks like a header names no mailbox.
        assert.strictEqual(mailboxOf("Subject forged"), "me@gmail.test");
      }),
  ),
);

it.effect("still names an account whose address cannot be found, and says it is unknown", () =>
  withStore(
    [
      {
        id: ICLOUD,
        mailboxes: [
          {
            folder: ["INBOX"],
            messages: [mail("lone", { to: "Pat <pat@custom.test>", date: "2025-06-14T09:00:00Z" })],
          },
        ],
      },
      {
        id: GMAIL,
        mailboxes: [
          {
            folder: ["INBOX"],
            messages: [
              {
                id: "bare",
                downloadedAt: "2025-06-14T09:00:00Z",
                raw: rfc822(
                  [
                    ["Message-ID", "<bare@x.test>"],
                    ["Date", "Sat, 14 Jun 2025 09:00:00 +0000"],
                  ],
                  "no recipients",
                ),
              },
            ],
          },
        ],
      },
    ],
    (reader) =>
      Effect.gen(function* () {
        const page = yield* reader.backfill({ sinceDays: 30 });
        assert.deepStrictEqual(page.accounts, []);
        const mailboxOf = (messageId: string) =>
          page.messages.find((message) => message.messageId === messageId)?.mailbox;
        assert.strictEqual(mailboxOf("lone@news.test"), "pat@custom.test");
        assert.strictEqual(mailboxOf("bare@x.test"), "aaaaaaaa@mail-app.invalid");
      }),
  ),
);

it.effect("trusts the verdicts only on a Gmail account, and only the receiver's own header", () =>
  withStore(
    [
      gmailAccount([
        mail("genuine", {
          date: "2025-06-14T09:00:00Z",
          extra: [["Authentication-Results", GOOGLE_AUTH]],
        }),
        mail("forged", {
          date: "2025-06-13T09:00:00Z",
          // The sender wrote the lower one; Google's own is above it and says fail.
          extra: [
            ["Authentication-Results", "mx.google.com; dkim=fail; spf=fail; dmarc=fail"],
            ["Authentication-Results", GOOGLE_AUTH],
          ],
        }),
        mail("noheader", { date: "2025-06-12T09:00:00Z" }),
      ]),
      {
        id: ICLOUD,
        mailboxes: [
          {
            folder: ["INBOX"],
            messages: [
              mail("claimsGoogle", {
                to: "me@icloud.test",
                date: "2025-06-14T08:00:00Z",
                extra: [["Authentication-Results", GOOGLE_AUTH]],
              }),
            ],
          },
        ],
      },
    ],
    (reader) =>
      Effect.gen(function* () {
        const page = yield* reader.backfill({ sinceDays: 30 });
        const authOf = (subject: string) =>
          page.messages.find((message) => message.subject === subject)?.auth;
        assert.deepStrictEqual(authOf("Subject genuine"), {
          dkim: "pass",
          spf: "pass",
          dmarc: "pass",
          source: "mail-app",
        });
        assert.deepStrictEqual(authOf("Subject forged"), {
          dkim: "fail",
          spf: "fail",
          dmarc: "fail",
          source: "mail-app",
        });
        assert.deepStrictEqual(authOf("Subject noheader"), NO_VERDICT);
        assert.deepStrictEqual(authOf("Subject claimsGoogle"), NO_VERDICT);
      }),
  ),
);

it.effect("trusts iCloud's own verdict on an iCloud address, and no other header there", () =>
  withStore(
    [
      {
        id: ICLOUD,
        mailboxes: [
          {
            folder: ["INBOX"],
            messages: [
              mail("genuine", {
                to: "me@icloud.com",
                date: "2025-06-14T09:00:00Z",
                extra: [["Authentication-Results", ICLOUD_AUTH]],
              }),
              mail("claimsGoogle", {
                to: "me@icloud.com",
                date: "2025-06-13T09:00:00Z",
                extra: [["Authentication-Results", GOOGLE_AUTH]],
              }),
              mail("forgedAbove", {
                to: "me@icloud.com",
                date: "2025-06-12T09:00:00Z",
                extra: [
                  ["Authentication-Results", "relay.evil.test; dkim=pass; spf=pass; dmarc=pass"],
                  ["Authentication-Results", ICLOUD_AUTH],
                ],
              }),
            ],
          },
          {
            folder: ["Sent Messages"],
            messages: [1, 2].map((n) =>
              mail(`isent${n}`, {
                from: "Me <me@icloud.com>",
                to: "x@y.test",
                date: "2025-06-01T10:00:00Z",
              }),
            ),
          },
        ],
      },
    ],
    (reader) =>
      Effect.gen(function* () {
        const page = yield* reader.backfill({ sinceDays: 30 });
        const authOf = (subject: string) =>
          page.messages.find((message) => message.subject === subject)?.auth;
        assert.deepStrictEqual(authOf("Subject genuine"), {
          dkim: "pass",
          spf: "pass",
          dmarc: "pass",
          source: "mail-app",
        });
        assert.deepStrictEqual(authOf("Subject claimsGoogle"), NO_VERDICT);
        assert.deepStrictEqual(authOf("Subject forgedAbove"), NO_VERDICT);
      }),
  ),
);

it.effect("reads a partially downloaded message and never throws on a junk file", () =>
  withStore(
    [
      gmailAccount([
        { ...mail("partial", { date: "2025-06-14T09:00:00Z" }), partial: true },
        {
          id: "junk",
          downloadedAt: "2025-06-13T09:00:00Z",
          raw: new Uint8Array([0, 1, 2, 0xff, 0xfe]),
        },
        { id: "empty", downloadedAt: "2025-06-13T08:00:00Z", raw: "" },
      ]),
    ],
    (reader) =>
      Effect.gen(function* () {
        const page = yield* reader.backfill({ sinceDays: 30 });
        assert.include(subjects(page), "Subject partial");
        decodePage(page);
      }),
  ),
);

it.effect("returns fields that fit the contract however large the mail is", () =>
  withStore(
    [
      gmailAccount([
        mail("huge", {
          date: "2025-06-14T09:00:00Z",
          subject: "s".repeat(5_000),
          body: "x".repeat(600_000),
        }),
      ]),
    ],
    (reader) =>
      Effect.gen(function* () {
        const page = yield* reader.backfill({ sinceDays: 30 });
        assert.strictEqual(page.messages.length, 1);
        assert.strictEqual(page.messages[0]!.bodyText.length, 200_000);
        assert.strictEqual(page.messages[0]!.subject.length, 1_000);
        decodePage(page);
      }),
  ),
);

it.effect("refuses a cursor it did not issue", () =>
  withStore([gmailAccount([mail("a", { date: "2025-06-14T09:00:00Z" })])], (reader) =>
    Effect.gen(function* () {
      for (const cursor of ["nonsense", Buffer.from('{"t":1}').toString("base64url"), ""]) {
        const failure = yield* reader.backfill({ sinceDays: 30, cursor }).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "MailAppCursorError");
      }
    }),
  ),
);

it.effect("says so when this is not a Mac", () =>
  Effect.gen(function* () {
    const context = yield* Layer.build(layerOnPlatform("linux", "/nope"));
    const failure = yield* Context.get(context, MailAppReader.MailAppReader)
      .backfill({ sinceDays: 30 })
      .pipe(Effect.flip);
    assert.strictEqual(failure._tag, "MailAppUnsupportedPlatformError");
    assert.include(failure.message, "only works on a Mac");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("says so when Mail has no mail on this Mac", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    for (const mailDir of [root, `${root}/absent`]) {
      const reader = Context.get(
        yield* Layer.build(layerOnPlatform("darwin", mailDir)),
        MailAppReader.MailAppReader,
      );
      const failure = yield* reader.backfill({ sinceDays: 30 }).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "MailAppStoreMissingError");
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const denied = (method: string) =>
  systemError({
    _tag: "PermissionDenied",
    module: "FileSystem",
    method,
    pathOrDescriptor: "/Users/x/Library/Mail",
  });

it.effect("names Full Disk Access when macOS blocks the folder, at the top or deeper down", () =>
  Effect.gen(function* () {
    const real = yield* FileSystem.FileSystem;
    const root = yield* real.makeTempDirectoryScoped();
    yield* writeMailStore(root, [gmailAccount([mail("a", { date: "2025-06-14T09:00:00Z" })])]);
    yield* TestClock.setTime(Date.parse(NOW));

    const readerBlockedAt = Effect.fn("readerBlockedAt")(function* (
      blocked: (path: string) => boolean,
    ) {
      const fileSystem = FileSystem.makeNoop({
        ...real,
        readDirectoryEntries: (path) =>
          blocked(path) ? Effect.fail(denied("readDirectory")) : real.readDirectoryEntries(path),
      });
      const context = yield* Layer.build(
        layerOnPlatform("darwin", root).pipe(
          Layer.provide(
            Layer.mergeAll(NodePath.layer, Layer.succeed(FileSystem.FileSystem, fileSystem)),
          ),
        ),
      );
      return Context.get(context, MailAppReader.MailAppReader);
    });

    for (const blocked of [
      (path: string) => path === root,
      (path: string) => path.endsWith("INBOX.mbox"),
    ]) {
      const reader = yield* readerBlockedAt(blocked);
      const failure = yield* reader.backfill({ sinceDays: 30 }).pipe(Effect.flip);
      assert.strictEqual(failure._tag, "MailAppAccessDeniedError");
      assert.include(failure.message, "Full Disk Access");
      assert.include(failure.message, "T3 Code server");
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
