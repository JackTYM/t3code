/**
 * Claude Cloud runs threads in Anthropic's sandbox (claude.ai/code) on the
 * `claude` CLI's own login. It shares the Claude model catalog but has no
 * binary, so there is nothing to install or update.
 */
import { ProviderDriverKind, TextGenerationError } from "@t3tools/contracts";
import { ClaudeCloudSettings } from "@t3tools/provider-claude-cloud/settings";
import {
  buildInitialClaudeCloudProviderSnapshot,
  checkClaudeCloudProviderStatus,
  makeClaudeCloudApi,
  makeClaudeCloudCredentialStore,
} from "@t3tools/provider-claude-cloud/server";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import {
  githubRepoSourceFromIdentity,
  makeClaudeCloudAdapterV2,
} from "../../orchestration-v2/Adapters/ClaudeCloudAdapterV2.ts";
import { RepositoryIdentityResolver } from "../../project/RepositoryIdentityResolver.ts";
import { BUNDLED_CLAUDE_MODEL_CATALOG, listUngatedClaudeModels } from "../ClaudeModelCatalog.ts";

const DRIVER_KIND = ProviderDriverKind.make("claudeCloud");
const decodeSettings = Schema.decodeSync(ClaudeCloudSettings);
const MAINTENANCE_CAPABILITIES = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});
// Account-gated models are offered by probing the local CLI login, which the
// cloud cannot do; a cloud session on one would fail at create time.
const MODELS = listUngatedClaudeModels(BUNDLED_CLAUDE_MODEL_CATALOG);

const unsupported = (operation: string) =>
  Effect.fail(
    new TextGenerationError({
      operation,
      detail: "Claude Cloud cannot generate text outside a session.",
    }),
  );
const UNSUPPORTED_TEXT_GENERATION: ProviderTextGeneration = {
  generateCommitMessage: () => unsupported("generateCommitMessage"),
  generatePrContent: () => unsupported("generatePrContent"),
  generateBranchName: () => unsupported("generateBranchName"),
  generateThreadTitle: () => unsupported("generateThreadTitle"),
  generateReviewGuide: () => unsupported("generateReviewGuide"),
};

export type ClaudeCloudDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | IdAllocator.IdAllocatorV2
  | Path.Path
  | ProviderHost.ProviderHost;

export const ClaudeCloudDriver: ProviderDriver<ClaudeCloudSettings, ClaudeCloudDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Claude Cloud",
    // One claude.ai login per machine, so a second instance would be a copy.
    supportsMultipleInstances: false,
  },
  configSchema: ClaudeCloudSettings,
  defaultConfig: (): ClaudeCloudSettings => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, enabled, config }) =>
    Effect.gen(function* () {
      const host = yield* ProviderHost.ProviderHost;
      const httpClient = yield* HttpClient.HttpClient;
      // Optional so hosts without project services (tests, the CLI) still build
      // the driver; sessions there just start without a repository.
      const repositoryIdentity = yield* Effect.serviceOption(RepositoryIdentityResolver);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies ClaudeCloudSettings;

      const credentials = yield* makeClaudeCloudCredentialStore();
      const api = yield* makeClaudeCloudApi({ httpClient, credentials });
      const orchestrationAdapter = yield* makeClaudeCloudAdapterV2({
        instanceId,
        api,
        defaultCwd: host.paths.cwd,
        resolveRepoSource: (cwd) =>
          cwd === null || Option.isNone(repositoryIdentity)
            ? Effect.succeed(null)
            : repositoryIdentity.value.resolve(cwd).pipe(Effect.map(githubRepoSourceFromIdentity)),
      });

      const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
      const snapshot = yield* makeManagedServerProvider<
        ProviderSnapshotSettings<ClaudeCloudSettings>
      >({
        resolveMaintenance: () => Effect.succeed(MAINTENANCE_CAPABILITIES),
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialClaudeCloudProviderSnapshot(settings.provider, MODELS).pipe(
            Effect.map(stampIdentity),
          ),
        checkProvider: checkClaudeCloudProviderStatus({
          settings: effectiveConfig,
          models: MODELS,
          credentials,
          api,
        }).pipe(Effect.map(stampIdentity)),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to build Claude Cloud snapshot.",
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        orchestrationAdapter,
        textGeneration: UNSUPPORTED_TEXT_GENERATION,
      } satisfies ProviderInstance;
    }),
};
