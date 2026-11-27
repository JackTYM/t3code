import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ProcessRunner from "../processRunner.ts";

/**
 * Runs a Bot-written script under macOS `sandbox-exec` with the T3 home out of reach, so an
 * approved script cannot read the stored secret grants (or the database, or the sessions) that
 * sit under it. Only the script's own folders are let back in.
 *
 * Other platforms have no sandbox here: a script that declares a secret does not run there.
 */
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const PROBE_TIMEOUT = Duration.seconds(5);

export interface SandboxedCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

interface SandboxInput extends SandboxedCommand {
  /** Real paths (symlinks resolved), as the sandbox matches the resolved path. */
  readonly hidden: ReadonlyArray<string>;
  /** Let back in under a hidden path: contents and writes. */
  readonly allowed: ReadonlyArray<string>;
}

/**
 * The profile names its paths as parameters (`-D`), so no path is ever spliced into the text.
 * A later rule wins over an earlier one, which is what lets the script's own folders back in under
 * the hidden tree. Metadata (stat, realpath of a parent) stays readable so a script can still
 * resolve its own path; contents and listings of the hidden tree do not.
 */
const sandboxProfile = (hiddenCount: number, allowedCount: number): string => {
  const subpaths = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, index) => `(subpath (param "${prefix}${index}"))`).join(" ");
  return [
    "(version 1)",
    "(allow default)",
    ...(hiddenCount === 0
      ? []
      : [`(deny file-read-data file-write* ${subpaths("H", hiddenCount)})`]),
    ...(allowedCount === 0
      ? []
      : [`(allow file-read-data file-write* ${subpaths("A", allowedCount)})`]),
  ].join("\n");
};

const sandboxCommand = (input: SandboxInput): SandboxedCommand => ({
  command: SANDBOX_EXEC,
  args: [
    ...input.hidden.flatMap((path, index) => ["-D", `H${index}=${path}`]),
    ...input.allowed.flatMap((path, index) => ["-D", `A${index}=${path}`]),
    "-p",
    sandboxProfile(input.hidden.length, input.allowed.length),
    input.command,
    ...input.args,
  ],
});

export class ScriptSandbox extends Context.Service<
  ScriptSandbox,
  {
    /** Whether this machine can sandbox a script; asked once. */
    readonly available: Effect.Effect<boolean>;
    readonly wrap: (input: SandboxInput) => SandboxedCommand;
  }
>()("t3/bots/ScriptSandbox") {}

export const layer = Layer.effect(
  ScriptSandbox,
  Effect.gen(function* () {
    const runner = yield* ProcessRunner.ProcessRunner;
    const platform = yield* HostProcess.Platform;
    // The tool is on every Mac, but it cannot nest: a server that is itself inside a sandbox gets
    // a refusal here, and then no script that has a secret runs.
    const available = yield* Effect.cached(
      platform !== "darwin"
        ? Effect.succeed(false)
        : runner
            .run({
              ...sandboxCommand({ command: "/usr/bin/true", args: [], hidden: [], allowed: [] }),
              inheritEnv: false,
              timeout: PROBE_TIMEOUT,
              timeoutBehavior: "timedOutResult",
            })
            .pipe(
              Effect.map((output) => output.code === 0),
              Effect.orElseSucceed(() => false),
            ),
    );
    return ScriptSandbox.of({ available, wrap: sandboxCommand });
  }),
);

/** For tests of what a script does, not of where it runs: nothing is wrapped. */
export const layerOff = Layer.succeed(
  ScriptSandbox,
  ScriptSandbox.of({
    available: Effect.succeed(true),
    wrap: ({ command, args }) => ({ command, args }),
  }),
);
