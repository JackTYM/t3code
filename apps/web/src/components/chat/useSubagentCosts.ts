import {
  estimateSubagentCost,
  type RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useMemo } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";

export interface SubagentCost {
  readonly costUsd: number;
  /** True when only a token total was known, so the figure is a rough one. */
  readonly approximate: boolean;
}

/**
 * Prices subagents two ways. An agent with its own thread is priced by the
 * server from that thread's transcript. A workflow member without one reports
 * token usage, which is priced here from the model's rates. Both queries
 * degrade to "no figure" against servers that lack the RPCs.
 */
export function useSubagentCosts(input: {
  readonly environmentId: EnvironmentId;
  readonly childThreadIds: ReadonlyArray<ThreadId>;
  readonly members: ReadonlyArray<RuntimeSubagent>;
}) {
  const { environmentId, childThreadIds, members } = input;
  const threadIdsKey = [...new Set(childThreadIds)].toSorted().join("\n");
  const threadIds = useMemo(
    () => (threadIdsKey === "" ? [] : (threadIdsKey.split("\n") as ThreadId[])),
    [threadIdsKey],
  );
  const estimable = members.filter(
    (member) => member.childThreadId === null && member.usage !== null && member.model !== null,
  );
  const modelsKey = [
    ...new Set(estimable.flatMap((member) => (member.model ? [member.model] : []))),
  ]
    .toSorted()
    .join("\n");
  const models = useMemo(() => (modelsKey === "" ? [] : modelsKey.split("\n")), [modelsKey]);

  const threadCosts = useEnvironmentQuery(
    threadIds.length > 0
      ? serverEnvironment.usageThreadCosts({ environmentId, input: { threadIds } })
      : null,
  );
  const modelRates = useEnvironmentQuery(
    models.length > 0
      ? serverEnvironment.usageModelRates({ environmentId, input: { models } })
      : null,
  );

  return useMemo(() => {
    const byThread = new Map<string, SubagentCost>(
      (threadCosts.data?.costs ?? []).map((cost) => [
        cost.threadId,
        { costUsd: cost.costUsd, approximate: false },
      ]),
    );
    const rateByModel = new Map(modelRates.data?.rates.map((rate) => [rate.model, rate]));
    return {
      forThread: (threadId: string | null): SubagentCost | null =>
        threadId === null ? null : (byThread.get(threadId) ?? null),
      forMember: (member: RuntimeSubagent): SubagentCost | null => {
        if (member.childThreadId !== null) return byThread.get(member.childThreadId) ?? null;
        const estimate = estimateSubagentCost(
          member.usage,
          member.model === null ? null : rateByModel.get(member.model),
        );
        return estimate === null
          ? null
          : { costUsd: estimate.costUsd, approximate: !estimate.hasTokenBreakdown };
      },
    };
  }, [modelRates.data, threadCosts.data]);
}
