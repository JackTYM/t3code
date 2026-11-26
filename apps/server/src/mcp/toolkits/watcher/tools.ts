import {
  BOT_WATCHER_SOURCE_MAX_BYTES,
  BotWatcherRemoteRun,
  BotWatcherRuntime,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as WatcherService from "../../../bots/WatcherService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

// Listed only to a linked environment's session, and checked on every call: the box attests that
// its reviewer approved this exact script, so nothing else may ask this environment to run one.
const WatcherRun = Tool.make("t3_watcher_run", {
  description:
    "Run a watcher's script here for the linked environment that holds its approval. `hash` is the sha256 of the source's UTF-8 bytes; a source that does not match is refused. Runs from a private copy with no stdin and a minimal environment, and returns the exit and output. A `stateKey` (a sha256 hex) names the watcher's persistent state folder here; without one the script gets a throwaway.",
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [McpInvocationContext.McpInvocationContext, WatcherService.WatcherService],
  parameters: Schema.Struct({
    source: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(BOT_WATCHER_SOURCE_MAX_BYTES),
    ),
    hash: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
    runtime: BotWatcherRuntime,
    timeoutMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    dryRun: Schema.optional(Schema.Boolean),
    stateKey: Schema.optional(Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u))),
  }),
  success: BotWatcherRemoteRun,
})
  .annotate(Tool.Title, "Run a watcher script for a linked environment")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromUnlinked);

export const WatcherPeerToolkit = Toolkit.make(WatcherRun);
