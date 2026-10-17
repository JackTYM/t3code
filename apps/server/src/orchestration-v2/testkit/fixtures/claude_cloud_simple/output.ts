import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertConversationMessageRoles,
  assertRunOrdinals,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  CLAUDE_CLOUD_SIMPLE_PROMPT,
  MULTI_TURN_FIRST_PROMPT,
  MULTI_TURN_SECOND_PROMPT,
  projectionFor,
  TURN_INTERRUPT_PROMPT,
} from "../shared.ts";

function outboundFrames(transcript: ProviderReplayTranscript): ReadonlyArray<unknown> {
  return transcript.entries.flatMap((entry) =>
    entry.type === "expect_outbound" ? [entry.frame] : [],
  );
}

function sentSubtypes(transcript: ProviderReplayTranscript): ReadonlyArray<string> {
  return outboundFrames(transcript).flatMap((frame) => {
    const events = Reflect.get(Object(frame), "events");
    return Array.isArray(events)
      ? events.map((event) => String(Reflect.get(event, "eventType")))
      : [];
  });
}

export function assertClaudeCloudSimpleOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertRunOrdinals(projection, [1]);
  assertConversationMessageRoles(projection, ["user", "assistant"]);
  assertUserMessagesInclude(projection, [CLAUDE_CLOUD_SIMPLE_PROMPT]);
  assertAssistantTextIncludes(projection, "pong");
  const [providerThread] = projection.providerThreads;
  assert.strictEqual(providerThread?.nativeThreadRef?.nativeId, "cse_replay");
  assert.strictEqual(providerThread?.status, "idle");
  const [providerTurn] = projection.providerTurns;
  assert.strictEqual(providerTurn?.status, "completed");
  assert.isAbove(
    providerTurn?.tokenUsage?.outputTokens ?? 0,
    0,
    "the result's usage settles the turn",
  );
  // The worker's echo of our own message must not become a second user row.
  assert.lengthOf(
    projection.turnItems.filter((item) => item.type === "user_message"),
    1,
  );
}

export function assertClaudeCloudMultiTurnOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 2,
    runStatuses: ["completed", "completed"],
  });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertRunOrdinals(projection, [1, 2]);
  assertConversationMessageRoles(projection, ["user", "assistant", "user", "assistant"]);
  assertUserMessagesInclude(projection, [MULTI_TURN_FIRST_PROMPT, MULTI_TURN_SECOND_PROMPT]);
  assertAssistantTextIncludes(projection, "first fixture turn complete");
  assertAssistantTextIncludes(projection, "second fixture turn complete");
  // Both turns run in one cloud session: a follow-up must not create another.
  assert.lengthOf(
    outboundFrames(transcript).filter(
      (frame) => Reflect.get(Object(frame), "method") === "createSession",
    ),
    1,
  );
  assert.lengthOf(projection.providerThreads, 1);
}

export function assertClaudeCloudTurnInterruptOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["interrupted"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertUserMessagesInclude(projection, [TURN_INTERRUPT_PROMPT]);
  assert.include(sentSubtypes(transcript), "control_request", "Stop must reach the cloud");
  assert.equal(projection.providerTurns[0]?.status, "interrupted");
  assert.equal(projection.providerThreads[0]?.status, "idle");
  assert.isFalse(
    projection.turnItems.some((item) => item.status === "running"),
    "the interrupted Bash call must not stay running",
  );
  assert.isTrue(projection.turnItems.some((item) => item.type === "command_execution"));
}
