import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

/**
 * Rewrites one assistant reply in a Claude Code session transcript
 * (`<config dir>/projects/<cwd slug>/<session id>.jsonl`), the history `--resume` replays to the
 * model. Only the text of the one text block on the reply's line changes. Thinking blocks carry
 * signatures, and tool_use ids, uuids and the parentUuid chain tie lines together, so every other
 * byte of the file must survive unchanged; anything that does not match the expected shape is
 * refused rather than repaired.
 */

type EditFailureReason = ProviderAdapter.ProviderAdapterEditAssistantTextError["reason"];

type ClaudeTranscriptRewrite =
  | { readonly _tag: "Rewritten"; readonly contents: string; readonly lineIndex: number }
  | { readonly _tag: "Refused"; readonly reason: EditFailureReason };

interface AssistantLine {
  readonly isSidechain?: unknown;
  readonly message?: { readonly content?: unknown };
}

interface TextBlock {
  type: "text";
  text: string;
}

const refused = (reason: EditFailureReason): ClaudeTranscriptRewrite => ({
  _tag: "Refused",
  reason,
});

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTextBlock(value: unknown): value is TextBlock {
  return isRecord(value) && value.type === "text" && typeof value.text === "string";
}

function isCompactBoundary(line: string): boolean {
  // Cheap filter first: transcripts reach tens of megabytes and almost no line matches.
  if (!line.includes('"compact_boundary"')) return false;
  const parsed = parseLine(line);
  return isRecord(parsed) && parsed.type === "system" && parsed.subtype === "compact_boundary";
}

/**
 * Pure: plans the rewrite of the assistant line whose `uuid` is `nativeItemId`. The line must be
 * Claude Code's own `JSON.stringify` output, so re-serializing it changes only the text token.
 */
export function rewriteClaudeAssistantText(
  contents: string,
  input: {
    readonly nativeItemId: string;
    readonly expectedText: string;
    readonly text: string;
  },
): ClaudeTranscriptRewrite {
  const lines = contents.split("\n");
  const uuidToken = `"uuid":${JSON.stringify(input.nativeItemId)}`;
  let lineIndex = -1;
  let parsed: Record<string, unknown> | undefined;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (!line.includes(uuidToken)) continue;
    const candidate = parseLine(line);
    if (!isRecord(candidate) || candidate.uuid !== input.nativeItemId) continue;
    // Two lines claiming one uuid means the file is not the history this reply came from.
    if (lineIndex !== -1) return refused("out-of-sync");
    lineIndex = index;
    parsed = candidate;
  }
  if (lineIndex === -1 || parsed === undefined) return refused("not-in-history");
  const line = lines[lineIndex]!;
  if (parsed.type !== "assistant" || (parsed as AssistantLine).isSidechain === true) {
    return refused("not-in-history");
  }
  if (JSON.stringify(parsed) !== line) return refused("out-of-sync");
  const content = (parsed as AssistantLine).message?.content;
  if (!Array.isArray(content)) return refused("not-editable");
  const textBlocks = content.filter(isTextBlock);
  // No text block: the reply came from a thinking block, which carries a signature.
  if (textBlocks.length === 0) return refused("not-editable");
  if (textBlocks.length > 1) return refused("multiple-text-blocks");
  const block = textBlocks[0]!;
  if (block.text !== input.expectedText) return refused("out-of-sync");
  for (let index = lineIndex + 1; index < lines.length; index++) {
    if (isCompactBoundary(lines[index]!)) return refused("compacted");
  }

  block.text = input.text;
  const rewrittenLine = JSON.stringify(parsed);
  // Restoring the old text must give back the original bytes, which proves the text token is
  // the only difference.
  const roundTrip = parseLine(rewrittenLine);
  if (!isRecord(roundTrip)) return refused("write-failed");
  const roundTripBlocks = (roundTrip as AssistantLine).message?.content;
  if (!Array.isArray(roundTripBlocks)) return refused("write-failed");
  const roundTripBlock = roundTripBlocks.find(isTextBlock);
  if (roundTripBlock === undefined || roundTripBlock.text !== input.text) {
    return refused("write-failed");
  }
  roundTripBlock.text = input.expectedText;
  if (JSON.stringify(roundTrip) !== line) return refused("write-failed");

  const rewritten = [...lines];
  rewritten[lineIndex] = rewrittenLine;
  return { _tag: "Rewritten", contents: rewritten.join("\n"), lineIndex };
}

/** True when `after` differs from `before` in exactly the one given line, if any. */
export function onlyLineChanged(before: string, after: string, lineIndex: number): boolean {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  if (beforeLines.length !== afterLines.length) return false;
  return beforeLines.every((line, index) => index === lineIndex || line === afterLines[index]);
}

// Not imported from the adapter, which imports this module.
const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");

// Session ids name a file under the projects directory; anything else could escape it.
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

const fail = (reason: EditFailureReason, cause?: unknown) =>
  new ProviderAdapter.ProviderAdapterEditAssistantTextError({
    driver: CLAUDE_DRIVER,
    reason,
    ...(cause === undefined ? {} : { cause }),
  });

/**
 * Finds the session file by id rather than by recomputing Claude Code's cwd slug, which depends
 * on the resolved cwd (macOS `/tmp` becomes `-private-tmp-...`) and truncates long paths.
 */
const locateTranscript = Effect.fn("ClaudeTranscriptEdit.locate")(function* (input: {
  readonly configDir: string;
  readonly sessionId: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projectsDir = path.join(input.configDir, "projects");
  const projects = yield* fileSystem
    .readDirectory(projectsDir)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  const matches: Array<string> = [];
  for (const project of projects) {
    const candidate = path.join(projectsDir, project, `${input.sessionId}.jsonl`);
    const info = yield* fileSystem.stat(candidate).pipe(Effect.option);
    if (Option.isSome(info) && info.value.type === "File") matches.push(candidate);
  }
  if (matches.length === 0) return yield* fail("not-in-history");
  if (matches.length > 1) return yield* fail("out-of-sync");
  const transcriptPath = matches[0]!;
  // Renaming over a symlink would replace the link, not the history it points at.
  const realPath = yield* fileSystem
    .realPath(transcriptPath)
    .pipe(Effect.mapError((cause) => fail("write-failed", cause)));
  const realParent = yield* fileSystem
    .realPath(path.dirname(transcriptPath))
    .pipe(Effect.mapError((cause) => fail("write-failed", cause)));
  if (realPath !== path.join(realParent, path.basename(transcriptPath))) {
    return yield* fail("not-editable");
  }
  return transcriptPath;
});

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

function sameStat(left: FileSystem.File.Info, right: FileSystem.File.Info): boolean {
  return (
    left.size === right.size &&
    Option.getOrUndefined(left.mtime)?.getTime() === Option.getOrUndefined(right.mtime)?.getTime()
  );
}

/**
 * Edits the transcript in place: backup once per session, temp file plus rename (keeping the
 * file mode), read back, and restore the pre-edit bytes on any failure after the rename.
 */
export const editClaudeTranscriptAssistantText = Effect.fn(
  "ClaudeTranscriptEdit.editAssistantText",
)(function* (input: {
  readonly configDir: string;
  readonly nativeThreadId: string;
  readonly nativeItemId: string;
  readonly expectedText: string;
  readonly text: string;
  readonly backupPath: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!SESSION_ID_PATTERN.test(input.nativeThreadId)) return yield* fail("not-in-history");
  const transcriptPath = yield* locateTranscript({
    configDir: input.configDir,
    sessionId: input.nativeThreadId,
  });
  const ioFailure = (cause: unknown) => fail("write-failed", cause);

  const before = yield* fileSystem.stat(transcriptPath).pipe(Effect.mapError(ioFailure));
  const originalBytes = yield* fileSystem.readFile(transcriptPath).pipe(Effect.mapError(ioFailure));
  let original: string;
  try {
    original = decoder.decode(originalBytes);
  } catch (cause) {
    return yield* fail("out-of-sync", cause);
  }
  const plan = rewriteClaudeAssistantText(original, input);
  if (plan._tag === "Refused") return yield* fail(plan.reason);
  if (!onlyLineChanged(original, plan.contents, plan.lineIndex)) {
    return yield* fail("write-failed");
  }

  const backupExists = yield* fileSystem.exists(input.backupPath).pipe(Effect.mapError(ioFailure));
  if (!backupExists) {
    const backupTemp = `${input.backupPath}.tmp`;
    yield* fileSystem
      .makeDirectory(path.dirname(input.backupPath), { recursive: true })
      .pipe(Effect.mapError(ioFailure));
    yield* fileSystem
      .writeFile(backupTemp, originalBytes, { mode: 0o600 })
      .pipe(Effect.mapError(ioFailure));
    yield* fileSystem.rename(backupTemp, input.backupPath).pipe(Effect.mapError(ioFailure));
  }

  const rewrittenBytes = encoder.encode(plan.contents);
  const mode = before.mode & 0o777;
  const tempPath = path.join(
    path.dirname(transcriptPath),
    `.${path.basename(transcriptPath)}.t3-edit.tmp`,
  );
  const removeTemp = fileSystem.remove(tempPath).pipe(Effect.ignore);
  yield* fileSystem.writeFile(tempPath, rewrittenBytes, { mode }).pipe(
    // writeFile's mode is filtered by the umask; the history keeps its own permissions.
    Effect.andThen(fileSystem.chmod(tempPath, mode)),
    Effect.mapError(ioFailure),
    Effect.tapError(() => removeTemp),
  );

  const beforeRename = yield* fileSystem.stat(transcriptPath).pipe(
    Effect.mapError(ioFailure),
    Effect.tapError(() => removeTemp),
  );
  if (!sameStat(before, beforeRename)) {
    yield* removeTemp;
    return yield* fail("changed-during-edit");
  }
  yield* fileSystem.rename(tempPath, transcriptPath).pipe(
    Effect.mapError(ioFailure),
    Effect.tapError(() => removeTemp),
  );

  const restore = fileSystem.writeFile(tempPath, originalBytes, { mode }).pipe(
    Effect.andThen(fileSystem.chmod(tempPath, mode)),
    Effect.andThen(fileSystem.rename(tempPath, transcriptPath)),
    Effect.tapError(() => removeTemp),
  );
  const writtenBytes = yield* fileSystem.readFile(transcriptPath).pipe(
    Effect.mapError(ioFailure),
    Effect.tapError(() => restore.pipe(Effect.ignore)),
  );
  if (
    writtenBytes.length !== rewrittenBytes.length ||
    !writtenBytes.every((byte, index) => byte === rewrittenBytes[index])
  ) {
    yield* restore.pipe(Effect.ignore);
    return yield* fail("write-failed");
  }
});
