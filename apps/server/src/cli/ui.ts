import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command } from "effect/cli";

import * as ServerConfig from "../config.ts";
import { resolveBaseDir } from "../os-jank.ts";
import { isProcessAlive, readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { baseDirFlag } from "./config.ts";

export class UiResetServerRunningError extends Schema.TaggedError<UiResetServerRunningError>()(
  "UiResetServerRunningError",
  { pid: Schema.Number, stateDir: Schema.String },
) {
  override get message(): string {
    return `A T3 Code server (pid ${this.pid}) is running on ${this.stateDir}. Stop it, then run \`t3 ui reset\` again.`;
  }
}

const envT3Home = Config.String("T3CODE_HOME").pipe(Config.option);

const uiResetCommand = Command.make("reset", { baseDir: baseDirFlag }).pipe(
  Command.withDescription(
    "Forget downloaded UI updates and go back to the UI built into this server. Stop the server first.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const envHome = Option.filter(yield* envT3Home, (value) => value.trim().length > 0);
      const configuredBaseDir = Option.orElse(flags.baseDir, () => envHome);
      const baseDir = yield* resolveBaseDir(Option.getOrUndefined(configuredBaseDir));
      const derivedPaths = yield* ServerConfig.deriveServerPaths(baseDir, undefined, {
        baseDirIsExplicit: Option.isSome(configuredBaseDir),
      });

      // The server keeps the bundle state in memory and rewrites state.json, so removing the
      // directory under a live server would just be undone by its next write.
      const runtime = yield* readPersistedServerRuntimeState(derivedPaths.serverRuntimeStatePath);
      if (Option.isSome(runtime) && isProcessAlive(runtime.value.pid)) {
        return yield* new UiResetServerRunningError({
          pid: runtime.value.pid,
          stateDir: derivedPaths.stateDir,
        });
      }

      // A missing ui-bundles directory reads as "active: builtin", so removal is the whole reset.
      const bundlesDir = path.join(derivedPaths.stateDir, "ui-bundles");
      if (!(yield* fs.exists(bundlesDir))) {
        yield* Console.log("Nothing to reset: no downloaded UI updates.");
        return;
      }
      yield* fs.remove(bundlesDir, { recursive: true, force: true });
      yield* Console.log(
        `Removed ${bundlesDir}. The server will use its built-in UI on the next start.`,
      );
    }),
  ),
);

export const uiCommand = Command.make("ui").pipe(
  Command.withDescription("Manage downloaded UI updates."),
  Command.withSubcommands([uiResetCommand]),
);
