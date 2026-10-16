import { ClaudeCloudSettings, ProviderDriverKind } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as NodeOS from "node:os";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { RepositoryIdentityResolver } from "../../project/RepositoryIdentityResolver.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeClaudeCloudApi } from "../claudeCloudApi.ts";
import { makeClaudeCredentialsReader } from "../claudeCloudCredentials.ts";
import {
  githubRepoSourceFromIdentity,
  makeClaudeCloudAdapter,
} from "../Layers/ClaudeCloudAdapter.ts";
import {
  buildInitialClaudeCloudProviderSnapshot,
  checkClaudeCloudProviderStatus,
} from "../Layers/ClaudeCloudProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import { makeFailingTextGeneration } from "./failingTextGeneration.ts";

const decodeClaudeCloudSettings = Schema.decodeSync(ClaudeCloudSettings);

const DRIVER_KIND = ProviderDriverKind.make("claudeCloud");
const MAINTENANCE_CAPABILITIES = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});

export type ClaudeCloudDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | RepositoryIdentityResolver
  | ServerSettingsService;

export const ClaudeCloudDriver: ProviderDriver<ClaudeCloudSettings, ClaudeCloudDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Claude Cloud",
    // One claude.ai login per machine, so a second instance would be a copy.
    supportsMultipleInstances: false,
  },
  configSchema: ClaudeCloudSettings,
  defaultConfig: (): ClaudeCloudSettings => decodeClaudeCloudSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const httpClient = yield* HttpClient.HttpClient;
      const serverSettings = yield* ServerSettingsService;
      const repositoryIdentity = yield* RepositoryIdentityResolver;
      const processEnv = mergeProviderInstanceEnvironment(environment);
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

      const credentials = yield* makeClaudeCredentialsReader({
        spawner,
        fileSystem,
        path,
        platform: yield* HostProcessPlatform,
        homeDir: NodeOS.homedir(),
        environment: processEnv,
      });
      const api = yield* makeClaudeCloudApi({ httpClient, credentials });
      const adapter = yield* makeClaudeCloudAdapter(api, {
        instanceId,
        resolveRepoSource: (cwd) =>
          cwd === undefined
            ? Effect.succeed(null)
            : repositoryIdentity
                .resolve(cwd)
                .pipe(Effect.map((identity) => githubRepoSourceFromIdentity(identity))),
      }).pipe(Effect.provideService(Crypto.Crypto, crypto));

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<
        ProviderSnapshotSettings<ClaudeCloudSettings>
      >({
        resolveMaintenance: () => Effect.succeed(MAINTENANCE_CAPABILITIES),
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialClaudeCloudProviderSnapshot(settings.provider).pipe(
            Effect.map(stampIdentity),
          ),
        checkProvider: checkClaudeCloudProviderStatus({
          settings: effectiveConfig,
          credentials,
          api,
        }).pipe(Effect.map(stampIdentity)),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Claude Cloud snapshot: ${cause.message ?? String(cause)}`,
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
        adapter,
        textGeneration: makeFailingTextGeneration(
          "Claude Cloud cannot generate text outside a session.",
        ),
      } satisfies ProviderInstance;
    }),
};
