/**
 * Provider status for Claude Cloud: whether the `claude` CLI login is usable
 * and the cloud API answers. There is no binary to probe, so "installed" is
 * always true and sign-in state is the whole story.
 *
 * @module ClaudeCloudProvider
 */
import type { ClaudeCloudSettings } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { BUNDLED_CLAUDE_MODEL_CATALOG, listUngatedClaudeModels } from "../ClaudeModelCatalog.ts";
import type { ClaudeCloudApi } from "../claudeCloudApi.ts";
import type { ClaudeCloudCredentialsReader } from "../claudeCloudCredentials.ts";
import {
  buildServerProvider,
  type ProviderProbeResult,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

export const CLAUDE_CLOUD_PRESENTATION = {
  displayName: "Claude Cloud",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
  reportsContextWindow: false,
  supportsConversationRollback: false,
} as const;

// Account-gated models are not offered: this provider never checks the account.
const models = () => listUngatedClaudeModels(BUNDLED_CLAUDE_MODEL_CATALOG);

const draft = (input: {
  readonly enabled: boolean;
  readonly checkedAt: string;
  readonly probe: ProviderProbeResult;
}): ServerProviderDraft => ({
  ...buildServerProvider({
    presentation: CLAUDE_CLOUD_PRESENTATION,
    enabled: input.enabled,
    checkedAt: input.checkedAt,
    models: models(),
    probe: input.probe,
  }),
  // The cloud agent cannot run T3's one-shot text generation (commit messages etc.).
  supportsTextGeneration: false,
});

export const buildInitialClaudeCloudProviderSnapshot = (
  settings: ClaudeCloudSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.map(DateTime.now, (now) =>
    draft({
      enabled: settings.enabled,
      checkedAt: DateTime.formatIso(now),
      probe: settings.enabled
        ? {
            installed: true,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Checking Claude Cloud sign-in...",
          }
        : {
            installed: true,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Claude Cloud is disabled in T3 Code settings.",
          },
    }),
  );

export const checkClaudeCloudProviderStatus = (input: {
  readonly settings: ClaudeCloudSettings;
  readonly credentials: ClaudeCloudCredentialsReader;
  readonly api: ClaudeCloudApi;
}): Effect.Effect<ServerProviderDraft> =>
  // Probing reads the login from the Keychain, which can raise a system prompt,
  // so a disabled provider must never get that far.
  !input.settings.enabled
    ? buildInitialClaudeCloudProviderSnapshot(input.settings)
    : Effect.gen(function* () {
        const checkedAt = DateTime.formatIso(yield* DateTime.now);
        const unauthenticated = (message: string): ProviderProbeResult => ({
          installed: true,
          version: null,
          status: "error",
          auth: { status: "unauthenticated" },
          message,
        });
        const probe = yield* input.credentials.read.pipe(
          Effect.flatMap(() => input.api.profile),
          Effect.map((profile): ProviderProbeResult => ({
            installed: true,
            version: null,
            status: "ready",
            auth: { status: "authenticated", email: profile.email },
          })),
          Effect.catch((error): Effect.Effect<ProviderProbeResult> => {
            if (error._tag === "ClaudeCloudCredentialsError") {
              return Effect.succeed(unauthenticated(error.message));
            }
            return Effect.succeed(
              error.kind === "auth"
                ? unauthenticated("Claude rejected your login. Run `claude` and sign in again.")
                : {
                    installed: true,
                    version: null,
                    status: "warning",
                    auth: { status: "unknown" },
                    message: "Could not reach Claude Cloud.",
                  },
            );
          }),
        );
        return draft({ enabled: true, checkedAt, probe });
      });
