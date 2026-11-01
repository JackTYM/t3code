import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  editClaudeTranscriptAssistantText,
  onlyLineChanged,
  rewriteClaudeAssistantText,
} from "./ClaudeTranscriptEdit.ts";

const SESSION_ID = "95f1cd74-23e6-4807-b6b1-3f114496e975";
const PROJECT = "-private-tmp-project";
const FINAL_TEXT = "The command printed 42. My colour is blue.";

const base = (uuid: string, parentUuid: string | null) => ({
  parentUuid,
  isSidechain: false,
  userType: "external",
  cwd: "/private/tmp/project",
  sessionId: SESSION_ID,
  version: "2.1.302",
  gitBranch: "",
  uuid,
  timestamp: "2026-10-18T11:55:02.066Z",
});

const assistant = (
  uuid: string,
  parentUuid: string,
  content: ReadonlyArray<unknown>,
  extra: Record<string, unknown> = {},
) => ({
  ...base(uuid, parentUuid),
  message: {
    model: "claude-sonnet-4-5-20250929",
    id: "msg_011Cg9fATbSyLJhpskP8Pdp7",
    type: "message",
    role: "assistant",
    content,
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 20 },
  },
  requestId: "req_011",
  type: "assistant",
  ...extra,
});

// The shape Claude Code 2.1 writes: bookkeeping lines without uuids, one content block per
// assistant line, a signed thinking block, a tool_use/tool_result pair and request blobs.
const realisticLines = [
  { type: "queue-operation", operation: "enqueue", sessionId: SESSION_ID, content: "hi" },
  {
    ...base("u-1", null),
    type: "user",
    message: { role: "user", content: "Run echo 42, then name a colour." },
  },
  { ...base("att-1", "u-1"), type: "attachment", attachment: { type: "skill_listing" } },
  {
    type: "api-request-blob",
    hash: "ed24",
    sessionId: SESSION_ID,
    message: { role: "user", content: [{ type: "text", text: FINAL_TEXT }] },
  },
  assistant("a-think", "att-1", [
    { type: "thinking", thinking: "", signature: "EqQBCkYIBxgCKkB+sig/==" },
  ]),
  assistant("a-intro", "a-think", [{ type: "text", text: "I'll run that command." }]),
  assistant("a-tool", "a-intro", [
    { type: "tool_use", id: "toolu_01", name: "Bash", input: { command: "echo 42" } },
  ]),
  {
    ...base("u-result", "a-tool"),
    type: "user",
    message: {
      role: "user",
      content: [{ tool_use_id: "toolu_01", type: "tool_result", content: "42", is_error: false }],
    },
    toolUseResult: { stdout: "42", stderr: "" },
  },
  { type: "api-request", id: "req-2", base: "req-1", keep: 1, tail: ["63c1", "091e"] },
  assistant("a-final", "u-result", [{ type: "text", text: FINAL_TEXT }]),
  { type: "last-prompt", lastPrompt: "Run echo 42", leafUuid: "a-final", sessionId: SESSION_ID },
  { ...base("u-2", "a-final"), type: "user", message: { role: "user", content: "Thanks — ✨" } },
  assistant("a-unicode", "u-2", [{ type: "text", text: "Gern geschehen — 你好 👋 done" }]),
];

const transcript = (lines: ReadonlyArray<unknown>) =>
  lines.map((line) => JSON.stringify(line)).join("\n") + "\n";

describe("rewriteClaudeAssistantText", () => {
  it("changes only the targeted text, leaving thinking, tool and bookkeeping bytes identical", () => {
    const before = transcript(realisticLines);
    const result = rewriteClaudeAssistantText(before, {
      nativeItemId: "a-final",
      expectedText: FINAL_TEXT,
      text: "The command printed 42. My colour is green.",
    });
    assert.strictEqual(result._tag, "Rewritten");
    if (result._tag !== "Rewritten") return;
    assert.isTrue(onlyLineChanged(before, result.contents, result.lineIndex));
    const beforeLines = before.split("\n");
    const afterLines = result.contents.split("\n");
    assert.strictEqual(afterLines.length, beforeLines.length);
    assert.strictEqual(
      afterLines[result.lineIndex],
      beforeLines[result.lineIndex]!.replace(
        JSON.stringify(FINAL_TEXT),
        JSON.stringify("The command printed 42. My colour is green."),
      ),
    );
    // The request blob carrying the same sentence is not the reply and stays untouched.
    assert.include(afterLines[3]!, FINAL_TEXT);
  });

  it("round-trips unicode and line separators byte for byte", () => {
    const before = transcript(realisticLines);
    const edited = rewriteClaudeAssistantText(before, {
      nativeItemId: "a-unicode",
      expectedText: "Gern geschehen — 你好 👋 done",
      text: 'Bitte — 再见 🎉\n"quoted"\\',
    });
    assert.strictEqual(edited._tag, "Rewritten");
    if (edited._tag !== "Rewritten") return;
    const restored = rewriteClaudeAssistantText(edited.contents, {
      nativeItemId: "a-unicode",
      expectedText: 'Bitte — 再见 🎉\n"quoted"\\',
      text: "Gern geschehen — 你好 👋 done",
    });
    assert.strictEqual(restored._tag, "Rewritten");
    if (restored._tag !== "Rewritten") return;
    assert.strictEqual(restored.contents, before);
  });

  it("edits a reply on a very large line", () => {
    const huge = "x".repeat(2_000_000);
    const before = transcript([
      ...realisticLines,
      assistant("a-huge", "a-unicode", [{ type: "text", text: huge }]),
    ]);
    const result = rewriteClaudeAssistantText(before, {
      nativeItemId: "a-huge",
      expectedText: huge,
      text: "short",
    });
    assert.strictEqual(result._tag, "Rewritten");
    if (result._tag !== "Rewritten") return;
    assert.isTrue(onlyLineChanged(before, result.contents, result.lineIndex));
  });

  it("refuses replies it cannot change safely", () => {
    const refusal = (lines: ReadonlyArray<unknown>, nativeItemId: string, expectedText: string) => {
      const result = rewriteClaudeAssistantText(transcript(lines), {
        nativeItemId,
        expectedText,
        text: "edited",
      });
      return result._tag === "Refused" ? result.reason : "rewritten";
    };
    assert.strictEqual(refusal(realisticLines, "missing", FINAL_TEXT), "not-in-history");
    assert.strictEqual(refusal(realisticLines, "u-2", "Thanks — ✨"), "not-in-history");
    assert.strictEqual(refusal(realisticLines, "a-final", "different text"), "out-of-sync");
    assert.strictEqual(refusal(realisticLines, "a-think", ""), "not-editable");
    assert.strictEqual(
      refusal(
        [
          assistant("a-two", "u-1", [
            { type: "text", text: "one" },
            { type: "text", text: "two" },
          ]),
        ],
        "a-two",
        "onetwo",
      ),
      "multiple-text-blocks",
    );
    assert.strictEqual(
      refusal(
        [assistant("a-side", "u-1", [{ type: "text", text: "side" }], { isSidechain: true })],
        "a-side",
        "side",
      ),
      "not-in-history",
    );
    assert.strictEqual(
      refusal(
        [
          ...realisticLines,
          { type: "system", subtype: "compact_boundary", uuid: "c-1", parentUuid: null },
        ],
        "a-final",
        FINAL_TEXT,
      ),
      "compacted",
    );
    assert.strictEqual(
      refusal([...realisticLines, realisticLines[9]], "a-final", FINAL_TEXT),
      "out-of-sync",
    );
  });

  it("refuses a line that Claude Code did not serialize itself", () => {
    // Same value, different bytes: re-serializing would silently rewrite the escape.
    const line = JSON.stringify(
      assistant("a-pretty", "u-1", [{ type: "text", text: "hi" }]),
    ).replace('"text":"hi"', '"text":"h\\u0069"');
    const result = rewriteClaudeAssistantText(`${line}\n`, {
      nativeItemId: "a-pretty",
      expectedText: "hi",
      text: "edited",
    });
    assert.deepStrictEqual(result, { _tag: "Refused", reason: "out-of-sync" });
  });
});

const setup = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "claude-transcript-edit-" });
  const configDir = path.join(root, "claude");
  const projectDir = path.join(configDir, "projects", PROJECT);
  const transcriptPath = path.join(projectDir, `${SESSION_ID}.jsonl`);
  const subagentPath = path.join(projectDir, SESSION_ID, "subagents", "agent-1.jsonl");
  yield* fileSystem.makeDirectory(path.dirname(subagentPath), { recursive: true });
  const contents = transcript(realisticLines);
  yield* fileSystem.writeFileString(transcriptPath, contents, { mode: 0o600 });
  yield* fileSystem.chmod(transcriptPath, 0o640);
  const subagentContents = transcript([
    assistant("a-final", "x", [{ type: "text", text: FINAL_TEXT }], { isSidechain: true }),
  ]);
  yield* fileSystem.writeFileString(subagentPath, subagentContents);
  return {
    configDir,
    transcriptPath,
    subagentPath,
    subagentContents,
    contents,
    backupPath: path.join(root, "t3-state", "reply-edit-backups", `${SESSION_ID}.jsonl`),
  };
});

describe("editClaudeTranscriptAssistantText", () => {
  it.effect("backs up once, keeps the mode and never touches subagent transcripts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const files = yield* setup;
        const edit = (expectedText: string, text: string) =>
          editClaudeTranscriptAssistantText({
            configDir: files.configDir,
            nativeThreadId: SESSION_ID,
            nativeItemId: "a-final",
            expectedText,
            text,
            backupPath: files.backupPath,
          });

        yield* edit(FINAL_TEXT, "green");
        yield* edit("green", "red");
        assert.strictEqual(yield* fileSystem.readFileString(files.backupPath), files.contents);
        assert.strictEqual(
          yield* fileSystem.readFileString(files.subagentPath),
          files.subagentContents,
        );
        assert.strictEqual((yield* fileSystem.stat(files.transcriptPath)).mode & 0o777, 0o640);
        const edited = yield* fileSystem.readFileString(files.transcriptPath);
        assert.isTrue(edited.includes('"text":"red"'));

        // Selecting the first version restores the original bytes exactly.
        yield* edit("red", FINAL_TEXT);
        assert.strictEqual(yield* fileSystem.readFileString(files.transcriptPath), files.contents);
        const leftovers = (yield* fileSystem.readDirectory(
          files.transcriptPath.slice(0, files.transcriptPath.lastIndexOf("/")),
        )).filter((entry) => entry.endsWith(".tmp"));
        assert.deepStrictEqual(leftovers, []);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("fails closed without writing when the history does not match", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const files = yield* setup;
        const error = yield* editClaudeTranscriptAssistantText({
          configDir: files.configDir,
          nativeThreadId: SESSION_ID,
          nativeItemId: "a-final",
          expectedText: "not what the agent said",
          text: "edited",
          backupPath: files.backupPath,
        }).pipe(Effect.flip);
        assert.strictEqual(error.reason, "out-of-sync");
        assert.strictEqual(yield* fileSystem.readFileString(files.transcriptPath), files.contents);
        assert.isFalse(yield* fileSystem.exists(files.backupPath));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses unknown sessions and ids that could leave the projects directory", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const files = yield* setup;
        for (const nativeThreadId of ["0c91bb28-0000-4889-bd22-3de9880233d3", "../escape"]) {
          const error = yield* editClaudeTranscriptAssistantText({
            configDir: files.configDir,
            nativeThreadId,
            nativeItemId: "a-final",
            expectedText: FINAL_TEXT,
            text: "edited",
            backupPath: files.backupPath,
          }).pipe(Effect.flip);
          assert.strictEqual(error.reason, "not-in-history");
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rolls back to the pre-edit bytes when the written file cannot be verified", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const realFileSystem = yield* FileSystem.FileSystem;
        const files = yield* setup;
        let renames = 0;
        // A disk that silently loses the write: the first rename lands an empty file.
        const lossy = FileSystem.FileSystem.of({
          ...realFileSystem,
          rename: (from, to) =>
            Effect.gen(function* () {
              renames++;
              if (to === files.transcriptPath && renames === 2) {
                yield* realFileSystem.writeFileString(from, "");
              }
              yield* realFileSystem.rename(from, to);
            }),
        });
        const error = yield* editClaudeTranscriptAssistantText({
          configDir: files.configDir,
          nativeThreadId: SESSION_ID,
          nativeItemId: "a-final",
          expectedText: FINAL_TEXT,
          text: "edited",
          backupPath: files.backupPath,
        }).pipe(Effect.provideService(FileSystem.FileSystem, lossy), Effect.flip);
        assert.strictEqual(error.reason, "write-failed");
        assert.strictEqual(
          yield* realFileSystem.readFileString(files.transcriptPath),
          files.contents,
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
