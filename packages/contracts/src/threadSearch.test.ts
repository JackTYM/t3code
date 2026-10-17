import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  OrchestrationSearchThreadsInput,
  OrchestrationSearchThreadsResult,
} from "./threadSearch.ts";

it("round-trips activity matches and the opt-in flag", () => {
  const input = Schema.decodeUnknownSync(OrchestrationSearchThreadsInput)({
    query: "needle",
    includeActivityMatches: true,
  });
  assert.equal(input.includeActivityMatches, true);

  const result = {
    matches: [
      {
        threadId: "thread:1",
        projectId: "project:1",
        source: "activity" as const,
        snippet: "needle in command output",
        messageCreatedAt: null,
      },
    ],
  };
  const decoded = Schema.decodeUnknownSync(OrchestrationSearchThreadsResult)(result);
  assert.deepEqual(Schema.encodeSync(OrchestrationSearchThreadsResult)(decoded), result);
});
