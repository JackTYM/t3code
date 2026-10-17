/**
 * Provider status for Claude Cloud: whether the `claude` CLI login is usable
 * and the cloud API answers. There is no binary to probe, so "installed" is
 * always true and sign-in state is the whole story.
 *
 * @module status
 */
import type { ServerProviderModel } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import {
  buildServerProvider,
  type ProviderProbeResult,
  type ServerProviderDraft,
} from "@t3tools/provider-core/server/snapshotProbe";
import type { ClaudeCloudSettings } from "../settings.ts";
import type { ClaudeCloudApi } from "./cloudApi.ts";
import type { ClaudeCloudCredentialStore } from "./credentials.ts";

export const CLAUDE_CLOUD_PRESENTATION = {
  displayName: "Claude Cloud",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
  reportsContextWindow: false,
  supportsConversationRollback: false,
  // The agent runs unattended in Anthropic's sandbox and never asks for
  // permission, so full access is the only mode it actually enforces.
  supportedRuntimeModes: ["full-access"],
} as const;

const REJECTED_LOGIN_MESSAGE = "Claude rejected your login. Run `claude` and sign in again.";

const draft = (input: {
  readonly enabled: boolean;
  readonly checkedAt: string;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly probe: ProviderProbeResult;
}): ServerProviderDraft => ({
  ...buildServerProvider({
    presentation: CLAUDE_CLOUD_PRESENTATION,
    enabled: input.enabled,
    checkedAt: input.checkedAt,
    models: input.models,
    probe: input.probe,
  }),
  // The cloud agent cannot run T3's one-shot text generation (commit messages etc.).
  supportsTextGeneration: false,
});

export const buildInitialClaudeCloudProviderSnapshot = (
  settings: ClaudeCloudSettings,
  models: ReadonlyArray<ServerProviderModel>,
): Effect.Effect<ServerProviderDraft> =>
  Effect.map(DateTime.now, (now) =>
    draft({
      enabled: settings.enabled,
      checkedAt: DateTime.formatIso(now),
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: settings.enabled
          ? "Checking Claude Cloud sign-in..."
          : "Claude Cloud is disabled in T3 Code settings.",
      },
    }),
  );

export const checkClaudeCloudProviderStatus = (input: {
  readonly settings: ClaudeCloudSettings;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly credentials: ClaudeCloudCredentialStore;
  readonly api: Pick<ClaudeCloudApi, "profile">;
}): Effect.Effect<ServerProviderDraft> =>
  // Probing reads the login from the Keychain, which can raise a system prompt,
  // so a disabled provider must never get that far.
  !input.settings.enabled
    ? buildInitialClaudeCloudProviderSnapshot(input.settings, input.models)
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
          Effect.andThen(input.api.profile),
          Effect.map((profile): ProviderProbeResult => ({
            installed: true,
            version: null,
            status: "ready",
            auth: { status: "authenticated", email: profile.email },
          })),
          Effect.catchTags({
            ClaudeCloudSignInError: (error) => Effect.succeed(unauthenticated(error.message)),
            ClaudeCloudApiError: (error) =>
              Effect.succeed(
                error.kind === "auth"
                  ? unauthenticated(REJECTED_LOGIN_MESSAGE)
                  : ({
                      installed: true,
                      version: null,
                      status: "warning",
                      auth: { status: "unknown" },
                      message: "Could not reach Claude Cloud.",
                    } satisfies ProviderProbeResult),
              ),
          }),
        );
        return draft({ enabled: true, checkedAt, models: input.models, probe });
      });
