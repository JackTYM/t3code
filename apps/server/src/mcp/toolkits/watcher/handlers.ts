import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as WatcherService from "../../../bots/WatcherService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { WatcherPeerToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(WatcherPeerToolkit, {
  t3_watcher_run: McpToolAccess.runsForLinkedPeer(({ dryRun, ...input }) =>
    Effect.gen(function* () {
      const watchers = yield* WatcherService.WatcherService;
      return yield* watchers
        .runForPeer({ ...input, dryRun: dryRun === true })
        .pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({ code: "invalid_request", message: error.message }),
          ),
        );
    }),
  ),
});
