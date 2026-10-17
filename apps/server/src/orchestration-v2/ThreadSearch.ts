import {
  IsoDateTime,
  OrchestrationThreadSearchSource,
  type OrchestrationSearchThreadsInput,
  type OrchestrationSearchThreadsResult,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

export class ThreadSearchError extends Schema.TaggedError<ThreadSearchError>()(
  "ThreadSearchError",
  {
    operation: Schema.Literals(["query", "decode"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Thread search ${this.operation} failed.`;
  }
}

const SearchRequest = Schema.Struct({
  pattern: Schema.String,
  needle: Schema.String,
  includeActivity: Schema.Boolean,
  limit: Schema.Int,
});
const SearchRow = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  source: OrchestrationThreadSearchSource,
  matchText: Schema.String,
  messageCreatedAt: Schema.NullOr(IsoDateTime),
});

// Activity output has no size bound in the projection, so the scan covers only
// the newest rows and the trailing characters of each, like the live tail.
const ACTIVITY_SCAN_ROWS = 5000;
const ACTIVITY_SCAN_TAIL_CHARS = 256 * 1024;
const ACTIVITY_SNIPPET_LEAD_CHARS = 100;
const ACTIVITY_SNIPPET_WINDOW_CHARS = 600;

function escapeLikePattern(value: string): string {
  return value.replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_");
}

function foldAsciiCase(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

function buildSearchSnippet(text: string, query: string): string {
  const normalizedText = text.replace(/\s+/g, " ").trim();
  if (normalizedText.length <= 240) {
    return normalizedText;
  }
  const normalizedQuery = foldAsciiCase(query.replace(/\s+/g, " ").trim());
  const matchIndex = foldAsciiCase(normalizedText).indexOf(normalizedQuery);
  const bodyLength = 236;
  const idealStart = Math.max(0, matchIndex - 72);
  const start = Math.min(idealStart, normalizedText.length - bodyLength);
  const end = Math.min(normalizedText.length, start + bodyLength);
  return `${start > 0 ? "…" : ""}${normalizedText.slice(start, end)}${
    end < normalizedText.length ? "…" : ""
  }`;
}

export class ThreadSearch extends Context.Service<
  ThreadSearch,
  {
    readonly search: (
      input: OrchestrationSearchThreadsInput,
    ) => Effect.Effect<OrchestrationSearchThreadsResult, ThreadSearchError>;
  }
>()("t3/orchestration-v2/ThreadSearch") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const searchRows = SqlSchema.findAll({
    Request: SearchRequest,
    Result: SearchRow,
    execute: ({ pattern, needle, includeActivity, limit }) => sql`
      WITH candidate AS (
        SELECT
          threads.thread_id,
          threads.project_id,
          messages.role,
          json_extract(messages.payload_json, '$.text') AS match_text,
          messages.created_at AS message_created_at,
          messages.message_id,
          threads.updated_at AS thread_updated_at
        FROM orchestration_v2_projection_messages AS messages
        INNER JOIN orchestration_v2_projection_threads AS threads
          ON threads.thread_id = messages.thread_id
        INNER JOIN projection_projects AS projects
          ON projects.project_id = threads.project_id
        WHERE threads.deleted_at IS NULL
          AND threads.archived_at IS NULL
          AND projects.deleted_at IS NULL
          AND messages.streaming = 0
          AND messages.role IN ('user', 'assistant')
          AND json_extract(messages.payload_json, '$.text') LIKE ${pattern} ESCAPE '!'
        ${
          includeActivity
            ? sql`
        UNION ALL
        SELECT
          threads.thread_id,
          threads.project_id,
          'activity' AS role,
          substr(
            activity.haystack,
            max(1, instr(lower(activity.haystack), ${needle}) - ${ACTIVITY_SNIPPET_LEAD_CHARS}),
            ${ACTIVITY_SNIPPET_WINDOW_CHARS}
          ) AS match_text,
          activity.updated_at AS message_created_at,
          activity.turn_item_id AS message_id,
          threads.updated_at AS thread_updated_at
        FROM (
          SELECT
            thread_id,
            turn_item_id,
            updated_at,
            substr(
              CASE type
                WHEN 'command_execution' THEN
                  coalesce(json_extract(payload_json, '$.input'), '') || char(10) ||
                  coalesce(json_extract(payload_json, '$.output'), '')
                WHEN 'dynamic_tool' THEN
                  coalesce(json_extract(payload_json, '$.toolName'), '') || char(10) ||
                  coalesce(json_extract(payload_json, '$.output'), '')
                ELSE coalesce(json_extract(payload_json, '$.result'), '')
              END,
              ${-ACTIVITY_SCAN_TAIL_CHARS}
            ) AS haystack
          FROM orchestration_v2_projection_turn_items
          WHERE turn_item_id IN (
            SELECT turn_item_id
            FROM orchestration_v2_projection_turn_items
            WHERE type IN ('command_execution', 'dynamic_tool', 'subagent')
            ORDER BY updated_at DESC
            LIMIT ${ACTIVITY_SCAN_ROWS}
          )
        ) AS activity
        INNER JOIN orchestration_v2_projection_threads AS threads
          ON threads.thread_id = activity.thread_id
        INNER JOIN projection_projects AS projects
          ON projects.project_id = threads.project_id
        WHERE threads.deleted_at IS NULL
          AND threads.archived_at IS NULL
          AND projects.deleted_at IS NULL
          AND activity.haystack LIKE ${pattern} ESCAPE '!'`
            : sql``
        }
      ),
      ranked AS (
        SELECT
          thread_id,
          project_id,
          role AS source,
          match_text,
          message_created_at,
          CASE role WHEN 'user' THEN 0 WHEN 'assistant' THEN 1 ELSE 2 END AS match_rank,
          thread_updated_at,
          ROW_NUMBER() OVER (
            PARTITION BY thread_id
            ORDER BY
              CASE role WHEN 'user' THEN 0 WHEN 'assistant' THEN 1 ELSE 2 END ASC,
              message_created_at DESC,
              message_id ASC
          ) AS thread_match_rank
        FROM candidate
      )
      SELECT
        thread_id AS "threadId",
        project_id AS "projectId",
        source,
        match_text AS "matchText",
        message_created_at AS "messageCreatedAt"
      FROM ranked
      WHERE thread_match_rank = 1
      ORDER BY match_rank ASC, thread_updated_at DESC, thread_id ASC
      LIMIT ${limit}
    `,
  });

  const search: ThreadSearch["Service"]["search"] = Effect.fn("ThreadSearch.search")(
    function* (input) {
      // The scan reads every message, so run it on the reader worker rather
      // than the event loop.
      const rows = yield* sql
        .withTransaction(
          searchRows({
            pattern: `%${escapeLikePattern(input.query)}%`,
            needle: foldAsciiCase(input.query),
            includeActivity: input.includeActivityMatches === true,
            limit: input.limit ?? 50,
          }),
        )
        .pipe(
          NodeSqliteClient.readOnly,
          Effect.mapError(
            (cause) =>
              new ThreadSearchError({
                operation: Schema.isSchemaError(cause) ? "decode" : "query",
                cause,
              }),
          ),
        );
      return {
        matches: rows.map((row) => ({
          threadId: row.threadId,
          projectId: row.projectId,
          source: row.source,
          snippet: buildSearchSnippet(row.matchText, input.query),
          messageCreatedAt: row.messageCreatedAt,
        })),
      };
    },
  );

  return ThreadSearch.of({ search });
});

export const layer = Layer.effect(ThreadSearch, make);
