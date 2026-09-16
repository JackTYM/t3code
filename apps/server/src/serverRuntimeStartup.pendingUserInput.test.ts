import * as NodeServices from "@effect/platform-node/NodeServices";
import { EventId, type OrchestrationCommand, ThreadId, TurnId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "./project/RepositoryIdentityResolver.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./orchestration/Layers/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "./orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "./orchestration/ThreadPlanProgress.ts";
import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";

const timestamp = "2026-08-20T12:00:00.000Z";

const queryLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(
    Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
      resolve: () => Effect.succeed(null),
    }),
  ),
  Layer.provideMerge(SqlitePersistenceMemory),
);

/**
 * Seeds one thread per scenario with its projected pending count, then runs the
 * startup sweep against the real projection query so the lifecycle rules (a
 * later resolution wins, a stale failure counts as one) are exercised in SQL
 * rather than restated in the test.
 */
const runSweep = Effect.fn("runSweep")(function* () {
  const dispatched: Array<OrchestrationCommand> = [];
  yield* ServerRuntimeStartup.reconcilePendingUserInput.pipe(
    Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
      readEvents: () => Stream.empty,
      readThreadEvents: () => Stream.empty,
      getThreadReplayStats: () => Effect.die("unused"),
      dispatch: (command) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: dispatched.length };
        }),
      streamDomainEvents: Stream.empty,
      subscribeDomainEvents: Effect.succeed(Stream.empty),
      latestSequence: Effect.succeed(0),
    }),
    Effect.provide(NodeServices.layer),
  );
  return dispatched;
});

const seed = Effect.fn("seed")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_projects
      (project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at)
    VALUES ('project-1', 'T3', '/tmp/t3', '[]', ${timestamp}, ${timestamp}, NULL)
  `;
  yield* sql`
    INSERT INTO projection_threads (
      thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
      created_at, updated_at, deleted_at, pending_user_input_count
    ) VALUES
      ('thread-blocked', 'project-1', 'Blocked', '{"instanceId":"claude","model":"opus"}',
        'full-access', 'default', ${timestamp}, ${timestamp}, NULL, 1),
      ('thread-async', 'project-1', 'Async', '{"instanceId":"codex","model":"gpt-5"}',
        'full-access', 'default', ${timestamp}, ${timestamp}, NULL, 1),
      ('thread-answered', 'project-1', 'Answered', '{"instanceId":"claude","model":"opus"}',
        'full-access', 'default', ${timestamp}, ${timestamp}, NULL, 1),
      ('thread-stale', 'project-1', 'Stale', '{"instanceId":"claude","model":"opus"}',
        'full-access', 'default', ${timestamp}, ${timestamp}, NULL, 1),
      ('thread-archived', 'project-1', 'Archived', '{"instanceId":"claude","model":"opus"}',
        'full-access', 'default', ${timestamp}, ${timestamp}, NULL, 1)
  `;
  yield* sql`UPDATE projection_threads SET archived_at = ${timestamp} WHERE thread_id = 'thread-archived'`;
  yield* sql`
    INSERT INTO projection_thread_activities (
      activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at
    ) VALUES
      ('a-blocked', 'thread-blocked', 'turn-1', 'info', 'user-input.requested', 'Question',
        '{"requestId":"req-blocked"}', ${timestamp}),
      ('a-async', 'thread-async', 'turn-2', 'info', 'user-input.requested', 'Question',
        '{"requestId":"req-async","responseMode":"message"}', ${timestamp}),
      ('a-answered-req', 'thread-answered', 'turn-3', 'info', 'user-input.requested', 'Question',
        '{"requestId":"req-answered"}', ${timestamp}),
      ('a-answered-res', 'thread-answered', 'turn-3', 'info', 'user-input.resolved', 'Answered',
        '{"requestId":"req-answered"}', '2026-08-20T12:00:01.000Z'),
      ('a-stale-req', 'thread-stale', 'turn-4', 'info', 'user-input.requested', 'Question',
        '{"requestId":"req-stale"}', ${timestamp}),
      ('a-stale-fail', 'thread-stale', NULL, 'error', 'provider.user-input.respond.failed', 'Failed',
        '{"requestId":"req-stale","detail":"Stale pending user-input request: req-stale."}',
        '2026-08-20T12:00:01.000Z'),
      ('a-archived', 'thread-archived', 'turn-5', 'info', 'user-input.requested', 'Question',
        '{"requestId":"req-archived"}', ${timestamp})
  `;
});

it.layer(queryLayer)("reconcilePendingUserInput", (it) => {
  it.effect(
    "dismisses a blocking question whose provider callback did not survive the restart",
    () =>
      Effect.gen(function* () {
        yield* seed();
        const dispatched = yield* runSweep();

        // Only the blocked thread. The async question is still answerable by
        // sending a message, the answered and stale ones are already closed,
        // and archived threads are outside the active projection.
        assert.equal(dispatched.length, 1);
        const command = dispatched[0]!;
        assert.equal(command.type, "thread.activity.append");
        if (command.type !== "thread.activity.append") return;
        assert.equal(command.threadId, ThreadId.make("thread-blocked"));
        assert.equal(command.activity.kind, "user-input.resolved");
        assert.deepEqual(command.activity.payload, { requestId: "req-blocked" });
        assert.equal(command.activity.turnId, TurnId.make("turn-1"));
        // Deterministic so a second sweep cannot append a second resolution.
        assert.equal(command.activity.id, EventId.make("startup:user-input-resolved:req-blocked"));
      }),
  );
});

it.layer(queryLayer)("reconcilePendingUserInput after the dismissal lands", (it) => {
  it.effect("stops dismissing once the resolution has been projected", () =>
    Effect.gen(function* () {
      yield* seed();
      const sql = yield* SqlClient.SqlClient;
      // What the projector writes once the sweep's activity is applied.
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at
        ) VALUES ('startup:user-input-resolved:req-blocked', 'thread-blocked', 'turn-1', 'info',
          'user-input.resolved', 'Question dismissed after a restart',
          '{"requestId":"req-blocked"}', '2026-08-20T12:00:02.000Z')
      `;
      yield* sql`
        UPDATE projection_threads SET pending_user_input_count = 0 WHERE thread_id = 'thread-blocked'
      `;

      assert.deepEqual(yield* runSweep(), []);
    }),
  );
});
