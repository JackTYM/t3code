import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as MailAppReader from "../../../mail/MailAppReader.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { MailPeerToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(MailPeerToolkit, {
  t3_mail_backfill: McpToolAccess.runsForLinkedPeer((input) =>
    Effect.gen(function* () {
      const mail = yield* MailAppReader.MailAppReader;
      return yield* mail.backfill(input).pipe(
        Effect.catchTags({
          MailAppAccessDeniedError: (error) =>
            Effect.fail(
              new OrchestratorMcpFailure({ code: "capability_denied", message: error.message }),
            ),
          MailAppCursorError: (error) =>
            Effect.fail(
              new OrchestratorMcpFailure({ code: "invalid_request", message: error.message }),
            ),
          MailAppUnsupportedPlatformError: (error) =>
            Effect.fail(
              new OrchestratorMcpFailure({ code: "provider_unavailable", message: error.message }),
            ),
          MailAppStoreMissingError: (error) =>
            Effect.fail(
              new OrchestratorMcpFailure({ code: "provider_unavailable", message: error.message }),
            ),
          MailAppReadError: (error) =>
            Effect.fail(
              new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
            ),
        }),
      );
    }),
  ),
});
