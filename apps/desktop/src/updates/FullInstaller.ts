import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import {
  downloadInstaller,
  FullUpdateDownloadError,
  FullUpdateOpenError,
  isDeveloperIdSigned,
  openInstaller,
  resolveInstallerUrl,
  selectInstallerFile,
  type FullUpdateFile,
} from "./FullUpdate.ts";

export class FullInstallerUnavailableError extends Schema.TaggedError<FullInstallerUnavailableError>()(
  "FullInstallerUnavailableError",
  { reason: Schema.Literals(["no-dmg", "no-release-source"]) },
) {
  override get message(): string {
    return this.reason === "no-dmg"
      ? "This release has no installer for this Mac."
      : "The release source for this build is unknown, so the installer cannot be downloaded.";
  }
}

export interface FullInstallerDownloadInput {
  readonly version: string;
  readonly files: ReadonlyArray<FullUpdateFile>;
  readonly source: Option.Option<{ readonly owner: string; readonly repo: string }>;
  readonly onProgress: (percent: number) => Effect.Effect<void>;
}

/**
 * Unsigned macOS builds cannot be installed by electron-updater, so an update there is a DMG
 * that this service downloads and opens.
 */
export class FullInstaller extends Context.Service<
  FullInstaller,
  {
    readonly enabled: Effect.Effect<boolean>;
    /** Resolves to the verified DMG's path. */
    readonly download: (
      input: FullInstallerDownloadInput,
    ) => Effect.Effect<string, FullUpdateDownloadError | FullInstallerUnavailableError>;
    /** Opens the DMG, then quits the app. */
    readonly openAndQuit: (dmgPath: string) => Effect.Effect<void, FullUpdateOpenError>;
  }
>()("@t3tools/desktop/updates/FullInstaller") {}

const INSTALLER_CACHE_DIR = "updates";

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const electronApp = yield* ElectronApp.ElectronApp;

  // The bundle is `<name>.app`, two levels above Contents/Resources.
  const appBundlePath = path.dirname(path.dirname(environment.resourcesPath));
  const enabled =
    environment.platform === "darwin" && environment.isPackaged
      ? yield* isDeveloperIdSigned(appBundlePath).pipe(
          Effect.map((signed) => !signed),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        )
      : false;
  const arch = environment.runtimeInfo.hostArch === "arm64" ? "arm64" : "x64";
  const cacheDir = path.join(environment.baseDir, INSTALLER_CACHE_DIR);

  // A new installer replaces older ones, which are hundreds of megabytes each.
  const pruneOtherInstallers = Effect.fn("desktop.fullInstaller.prune")(function* (keep: string) {
    const entries = yield* fileSystem.readDirectory(cacheDir);
    yield* Effect.forEach(
      entries.filter((name) => /\.(dmg|part)$/i.test(name) && path.join(cacheDir, name) !== keep),
      (name) => fileSystem.remove(path.join(cacheDir, name), { force: true }),
      { discard: true },
    );
  });

  return FullInstaller.of({
    enabled: Effect.succeed(enabled),
    download: Effect.fn("desktop.fullInstaller.download")(function* (input) {
      const unavailable = (reason: "no-dmg" | "no-release-source") => () =>
        new FullInstallerUnavailableError({ reason });
      const file = yield* Effect.fromOption(selectInstallerFile(input.files, arch)).pipe(
        Effect.mapError(unavailable("no-dmg")),
      );
      const source = yield* Effect.fromOption(input.source).pipe(
        Effect.mapError(unavailable("no-release-source")),
      );
      const url = yield* Effect.fromOption(
        resolveInstallerUrl({
          file,
          owner: source.owner,
          repo: source.repo,
          version: input.version,
        }),
      ).pipe(Effect.mapError(unavailable("no-release-source")));
      const destination = path.join(cacheDir, path.basename(decodeURIComponent(url.pathname)));
      yield* downloadInstaller({
        url: url.href,
        destination,
        sha512: file.sha512,
        size: file.size,
        onProgress: input.onProgress,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
      yield* pruneOtherInstallers(destination).pipe(Effect.ignore);
      return destination;
    }),
    openAndQuit: Effect.fn("desktop.fullInstaller.openAndQuit")(function* (dmgPath) {
      yield* openInstaller(dmgPath).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      yield* electronApp.quit;
    }),
  });
});

export const layer = Layer.effect(FullInstaller, make);

export const layerTest = (
  overrides: Partial<Context.Service.Shape<typeof FullInstaller>> = {},
): Layer.Layer<FullInstaller> =>
  Layer.succeed(
    FullInstaller,
    FullInstaller.of({
      enabled: Effect.succeed(false),
      download: Effect.fn("FullInstaller.download")(function* () {
        return yield* new FullInstallerUnavailableError({ reason: "no-dmg" });
      }),
      openAndQuit: Effect.fn("FullInstaller.openAndQuit")(function* () {}),
      ...overrides,
    }),
  );
