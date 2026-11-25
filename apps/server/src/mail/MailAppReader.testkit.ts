// @effect-diagnostics nodeBuiltinImport:off -- fixtures build message bytes.
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as HostProcess from "@t3tools/shared/HostProcess";

import * as MailAppReader from "./MailAppReader.ts";

export interface FixtureMessage {
  /** The file's name without `.emlx`. */
  readonly id: string;
  /** The whole RFC 822 message. A string is written as UTF-8. */
  readonly raw: string | Uint8Array;
  /** When the file was written, which is when Mail downloaded the message. */
  readonly downloadedAt: string;
  readonly partial?: boolean;
}

export interface FixtureMailbox {
  /** Folder names outermost first, such as `["[Gmail]", "All Mail"]`. */
  readonly folder: ReadonlyArray<string>;
  readonly messages: ReadonlyArray<FixtureMessage>;
}

export interface FixtureAccount {
  /** The account's directory name, a UUID. */
  readonly id: string;
  readonly mailboxes: ReadonlyArray<FixtureMailbox>;
}

/** An RFC 822 message from header pairs and a body, with the line endings mail servers use. */
export const rfc822 = (headers: ReadonlyArray<readonly [string, string]>, body: string) =>
  `${headers.map(([name, value]) => `${name}: ${value}`).join("\r\n")}\r\n\r\n${body}`;

const PLIST = `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>flags</key><integer>8590195713</integer></dict></plist>\n`;

const emlx = (raw: string | Uint8Array) => {
  const message = typeof raw === "string" ? Buffer.from(raw, "utf8") : Buffer.from(raw);
  return Buffer.concat([Buffer.from(`${message.length}\n`), message, Buffer.from(PLIST)]);
};

/**
 * Lays a store out the way Mail does: `V10/<account>/<folder>.mbox/.../<store>/Data/<n>/Messages/
 * <id>.emlx`, with an `Attachments` folder and Mail's own `MailData` beside them.
 */
export const writeMailStore = Effect.fn("MailAppReader.writeMailStore")(function* (
  root: string,
  accounts: ReadonlyArray<FixtureAccount>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.join(root, "V10", "MailData"), { recursive: true });
  yield* fs.makeDirectory(path.join(root, "V9", "stale"), { recursive: true });
  for (const account of accounts) {
    for (const mailbox of account.mailboxes) {
      const folder = path.join(
        root,
        "V10",
        account.id,
        ...mailbox.folder.map((name) => `${name}.mbox`),
        "11111111-2222-3333-4444-555555555555",
        "Data",
        "1",
      );
      const messages = path.join(folder, "Messages");
      yield* fs.makeDirectory(messages, { recursive: true });
      yield* fs.makeDirectory(path.join(folder, "Attachments", "100"), { recursive: true });
      for (const message of mailbox.messages) {
        const file = path.join(
          messages,
          `${message.id}${message.partial === true ? ".partial" : ""}.emlx`,
        );
        yield* fs.writeFile(file, emlx(message.raw));
        const downloaded = DateTime.toDateUtc(DateTime.makeUnsafe(message.downloadedAt));
        yield* fs.utimes(file, downloaded, downloaded);
      }
    }
  }
});

/** A reader that answers every page with `respond`, for tests of what calls it. */
export const layerFake = (respond: MailAppReader.MailAppReader["Service"]["backfill"]) =>
  Layer.succeed(MailAppReader.MailAppReader, MailAppReader.MailAppReader.of({ backfill: respond }));

/** A reader over a store in `mailDir`, on a host of the given platform. */
export const layerOnPlatform = (platform: NodeJS.Platform, mailDir: string) =>
  MailAppReader.layerWith({ mailDir }).pipe(
    Layer.provide(Layer.succeed(HostProcess.Platform, platform)),
  );
