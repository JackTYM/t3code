import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A Bot's mail store. `folder` is the Bot's memory folder, so a Home started fresh keeps its mail.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE bot_mail_messages (
      -- AUTOINCREMENT: a number is never reused, so a Bot holding an old one cannot read another email.
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      folder TEXT NOT NULL,
      mailbox TEXT NOT NULL,
      message_id TEXT NOT NULL,
      from_addr TEXT NOT NULL,
      to_json TEXT NOT NULL,
      subject TEXT NOT NULL,
      -- ISO, normalized to UTC.
      sent_at TEXT NOT NULL,
      body_text TEXT NOT NULL,
      attachments_json TEXT NOT NULL,
      auth_json TEXT NOT NULL,
      origin TEXT NOT NULL,
      -- Epoch milliseconds on this server's clock.
      received_at INTEGER NOT NULL,
      -- The earlier of the sender's date and received_at, so a sender cannot keep mail by dating it ahead.
      retained_from INTEGER NOT NULL,
      -- Null until the digest told the Bot about it; backfilled mail is born announced.
      announced_at INTEGER,
      -- A forgotten email keeps only these two and its address, so a repeat is not stored again.
      forgotten_at INTEGER,
      forgotten_by TEXT,
      UNIQUE (folder, mailbox, message_id)
    )
  `;
  yield* sql`CREATE INDEX bot_mail_messages_folder ON bot_mail_messages (folder, id)`;
  yield* sql`
    CREATE INDEX bot_mail_messages_unannounced ON bot_mail_messages (folder, id)
    WHERE announced_at IS NULL AND forgotten_at IS NULL
  `;
  yield* sql`CREATE INDEX bot_mail_messages_retained ON bot_mail_messages (retained_from)`;
  yield* sql`
    CREATE TABLE bot_mail_settings (
      folder TEXT PRIMARY KEY,
      mailboxes_json TEXT NOT NULL,
      retention_days INTEGER NOT NULL,
      digest_window_minutes INTEGER NOT NULL,
      last_digest_at INTEGER,
      backfill_json TEXT,
      -- Where an interrupted pull resumes.
      backfill_cursor TEXT
    )
  `;
});
