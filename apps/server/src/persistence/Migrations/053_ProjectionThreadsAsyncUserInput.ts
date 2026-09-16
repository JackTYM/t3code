import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

/**
 * Counts the open questions that do NOT block the agent, so the shell can tell
 * "the agent is waiting on you" from "the agent asked something and carried on".
 *
 * Stored as the async count rather than the blocking one so the default of 0
 * reproduces the previous behaviour on rows this release has not refreshed yet:
 * every pending question reads as blocking, exactly as before.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN pending_async_user_input_count INTEGER NOT NULL DEFAULT 0
  `.pipe(Effect.catch(() => Effect.void));
});
