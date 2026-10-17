import { CLAUDE_CLOUD_SIMPLE_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

/** Recorded from a live cloud session by `record-claude-cloud-replay-fixture.ts`. */
export function claudeCloudSimpleInput(): OrchestratorFixtureInput {
  return {
    steps: [{ type: "message", text: CLAUDE_CLOUD_SIMPLE_PROMPT }],
  };
}
