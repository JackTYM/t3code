import type { ThreadSubagentRunGroup } from "@t3tools/client-runtime/state/thread-subagents";
import * as DateTime from "effect/DateTime";

import { relativeTime } from "../../lib/time";

export function subagentRunGroupLabel(group: ThreadSubagentRunGroup): string {
  if (group.isCurrentRun) return "This turn";
  if (group.requestedAt === null) return "Earlier";
  return `${relativeTime(DateTime.formatIso(group.requestedAt))} ago`;
}
