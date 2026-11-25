import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Bulk mail is stored but never announced, so earlier rows are simply "not bulk".
  yield* sql`ALTER TABLE bot_mail_messages ADD COLUMN bulk INTEGER NOT NULL DEFAULT 0`;
  // Mail dropped for a mailbox that is not allowed: `{ count, mailboxes: [{ mailbox, count }] }`.
  // Names only, newest first and capped, so a flood of strangers' addresses cannot grow it.
  yield* sql`ALTER TABLE bot_mail_settings ADD COLUMN dropped_json TEXT`;
});
