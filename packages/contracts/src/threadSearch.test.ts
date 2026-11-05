import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  OrchestrationSearchThreadsInput,
  OrchestrationSearchThreadsResult,
} from "./threadSearch.ts";

const decodeSearchInput = Schema.decodeSync(OrchestrationSearchThreadsInput);
const decodeSearchResult = Schema.decodeSync(OrchestrationSearchThreadsResult);
const encodeSearchResult = Schema.encodeSync(OrchestrationSearchThreadsResult);

it("round-trips activity matches and the opt-in flag", () => {
  const input = decodeSearchInput({
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
  const decoded = decodeSearchResult(result);
  assert.deepEqual(encodeSearchResult(decoded), result);
});
