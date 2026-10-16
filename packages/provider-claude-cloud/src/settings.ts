/**
 * Shared by the server driver and the client settings form, so it holds only
 * browser-safe schema code.
 */
import { CustomModelSetting, makeProviderSettingsSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * There is nothing to configure: the provider signs in with the Claude CLI's
 * own login and the session runs on Anthropic's infrastructure. Off by default
 * because it talks to an API Anthropic does not document.
 */
export const ClaudeCloudSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  { order: [] },
);
export type ClaudeCloudSettings = typeof ClaudeCloudSettings.Type;
