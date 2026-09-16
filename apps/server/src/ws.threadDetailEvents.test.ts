import { OrchestrationEvent } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { isThreadDetailEvent } from "./ws.ts";

const decodeEvent = Schema.decodeUnknownEffect(OrchestrationEvent);

const activityAppended = (activity: {
  readonly id: string;
  readonly kind: string;
  readonly payload: Record<string, unknown>;
}) => ({
  type: "thread.activity-appended",
  eventId: `evt-${activity.id}`,
  sequence: 1,
  aggregateKind: "thread",
  aggregateId: "thread-1",
  occurredAt: "2026-01-01T00:00:00.000Z",
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
  payload: {
    threadId: "thread-1",
    activity: {
      id: activity.id,
      createdAt: "2026-01-01T00:00:00.000Z",
      turnId: null,
      tone: "info",
      kind: activity.kind,
      summary: "summary",
      payload: activity.payload,
    },
  },
});

describe("isThreadDetailEvent", () => {
  it.effect("delivers ordinary activity rows to thread subscribers", () =>
    Effect.gen(function* () {
      const event = yield* decodeEvent(
        activityAppended({ id: "activity-1", kind: "task.started", payload: { taskId: "task-1" } }),
      );
      expect(isThreadDetailEvent(event)).toBe(true);
    }),
  );

  it.effect("withholds subagent transcript rows from thread subscribers", () =>
    Effect.gen(function* () {
      // The traffic guard: a fleet's narration is persisted and served by the
      // scoped (threadId, taskId) query. If it streamed here it would reach
      // every subscribed client whether or not an agent view is open, which is
      // the regression the per-agent transcript design exists to prevent.
      const event = yield* decodeEvent(
        activityAppended({
          id: "activity-2",
          kind: "agent.transcript",
          payload: { taskId: "task-1", blocks: [{ type: "text", text: "narration" }] },
        }),
      );
      expect(isThreadDetailEvent(event)).toBe(false);
    }),
  );
});
