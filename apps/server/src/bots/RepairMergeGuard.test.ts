import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestrationProjectShell,
  ProjectId,
  type PullRequestDetail,
  SourceControlProviderKind,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as RepairMergeGuard from "./RepairMergeGuard.ts";
import * as RepairService from "./RepairService.ts";

const SIGNAL = "0123456789ab";
const BOT = ThreadId.make("thread:bot");
const CREW = ThreadId.make(`repair-crew:${SIGNAL}:1`);
const CREW_TWO = ThreadId.make(`repair-crew:${SIGNAL}:2`);
const SUBAGENT = ThreadId.make("thread:crew-subagent");
const ORDINARY = ThreadId.make("thread:ordinary");
// A thread a crew started with t3_thread_launch: nobody's crew, as far as lineage goes.
const SIBLING = ThreadId.make("thread:sibling-of-crew");
const ON_REPAIR_BRANCH = ThreadId.make("thread:on-repair-branch");
const BRANCH = `repair/${SIGNAL}`;
const HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const PROJECT_ID = ProjectId.make("project:t3code");
const environmentId = EnvironmentId.make("environment-1");

const project: OrchestrationProjectShell = {
  id: PROJECT_ID,
  title: "T3 Code",
  workspaceRoot: "/work/t3code",
  defaultModelSelection: null,
  scripts: [],
  repositoryIdentity: {
    canonicalKey: "github.com/jacktym/t3code",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "git@github.com:JackTYM/t3code.git",
    },
    provider: SourceControlProviderKind.make("github"),
    displayName: "JackTYM/t3code",
    owner: "JackTYM",
    name: "t3code",
  },
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

type FileEntry = string | { readonly from: string; readonly to: string };

/** The patch a host gives for these files, with the headers it assembles. */
const patchOf = (files: ReadonlyArray<FileEntry>) =>
  files
    .map((file) =>
      typeof file === "string"
        ? `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-a\n+b\n`
        : `diff --git a/${file.from} b/${file.to}\nsimilarity index 100%\nrename from ${file.from}\nrename to ${file.to}\n--- a/${file.from}\n+++ b/${file.to}\n`,
    )
    .join("");

const check = (name: string, status: "success" | "failure" | "pending" | "skipped", more = {}) => ({
  name,
  status,
  description: null,
  url: null,
  ...more,
});

const review = (login: string, reviewState: string, at: number) => ({
  id: `review:${login}:${at}`,
  kind: "review" as const,
  author: { login },
  body: "",
  createdAt: DateTime.formatIso(DateTime.makeUnsafe(Date.UTC(2026, 10, 26, 12, 0, at))),
  url: null,
  path: null,
  reviewState,
});

interface Scenario {
  /** The crew's threads, by id, and what each is: a crew, or a subagent of one. */
  readonly detail: Record<string, unknown>;
  readonly files: ReadonlyArray<ReadonlyArray<FileEntry>>;
  readonly reviews: ReadonlyArray<ReturnType<typeof review>>;
  readonly activity: Record<string, unknown>;
  readonly reviewDecision: string | null;
  readonly defaultBranch: string | null | "fails";
  readonly failing: ReadonlyArray<"detail" | "summary" | "activity" | "project" | "defect">;
  readonly failPage: number | null;
  /** The headers for page n, in place of the files', for a host that cannot be read. */
  readonly pageCount: number | null;
  /** The repair record is gone (the 500 cap), so no branch is known for any crew. */
  readonly recordsLost: boolean;
  /** The stack the pull request is in, if any, as the host lists it; `"fails"` when unreadable. */
  readonly stack:
    | ReadonlyArray<{ number: number; headBranch: string; state: string }>
    | null
    | "fails";
  /**
   * The head commit the host reports on its nth read of the pull request, the last one staying:
   * `undefined` when it reports none, `"fails"` when the read cannot be made.
   */
  readonly heads: ReadonlyArray<string | undefined | "fails">;
}

const scenarioDefaults = {
  detail: {},
  files: [["apps/server/src/git/Thing.ts"]],
  reviews: [],
  activity: {},
  reviewDecision: null,
  defaultBranch: "main",
  failing: [],
  failPage: null,
  pageCount: null,
  recordsLost: false,
  stack: null,
  heads: [],
} satisfies Scenario;

const makeScenario = (overrides: Partial<Scenario> = {}) => {
  const scenario = { ...scenarioDefaults, ...overrides };
  const reports: Array<{
    crewThreadId: ThreadId;
    number: number | null;
    merged: boolean;
    reason: string;
  }> = [];
  const log: Array<string> = [];
  const detail = {
    state: "open",
    isDraft: false,
    repository: "JackTYM/t3code",
    number: 7,
    headBranch: BRANCH,
    baseBranch: "main",
    headRepositoryNameWithOwner: "JackTYM/t3code",
    headSha: HEAD,
    changedFiles: scenario.files.flat().length,
    checks: [check("CI", "success")],
    ...scenario.detail,
  } as unknown as PullRequestDetail;
  const shell = (
    id: ThreadId,
    root: ThreadId,
    parent: ThreadId | null,
    branch: string | null = null,
  ) => ({
    id,
    projectId: PROJECT_ID,
    branch,
    lineage: {
      parentThreadId: parent,
      relationshipToParent: parent === null ? null : ("subagent" as const),
      rootThreadId: root,
    },
  });
  const shells = new Map([
    [CREW, shell(CREW, CREW, null)],
    [CREW_TWO, shell(CREW_TWO, CREW_TWO, null)],
    [SUBAGENT, shell(SUBAGENT, CREW, CREW)],
    [ORDINARY, shell(ORDINARY, ORDINARY, null, "feature/x")],
    [SIBLING, shell(SIBLING, SIBLING, null, "feature/sibling")],
    [ON_REPAIR_BRANCH, shell(ON_REPAIR_BRANCH, ON_REPAIR_BRANCH, null, BRANCH)],
    [BOT, shell(BOT, BOT, null)],
  ]);
  const unavailable = Effect.fail({ _tag: "PullRequestUnavailableError" } as never);
  let detailReads = 0;

  const layer = RepairMergeGuard.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(RepairService.RepairService)({
          crewOf: (threadId) =>
            Effect.succeed(
              threadId === CREW || threadId === SUBAGENT
                ? {
                    crewThreadId: CREW,
                    signalId: SIGNAL,
                    botThreadId: BOT,
                    attempt: 1,
                    branch: BRANCH,
                  }
                : threadId === CREW_TWO
                  ? {
                      crewThreadId: CREW_TWO,
                      signalId: SIGNAL,
                      botThreadId: BOT,
                      attempt: 2,
                      branch: `${BRANCH}-2`,
                    }
                  : undefined,
            ),
          repairOfBranch: (branch) =>
            Effect.succeed(
              scenario.recordsLost
                ? undefined
                : branch === BRANCH
                  ? {
                      crewThreadId: CREW,
                      signalId: SIGNAL,
                      botThreadId: BOT,
                      attempt: 1,
                      branch: BRANCH,
                    }
                  : branch === `${BRANCH}-2`
                    ? {
                        crewThreadId: CREW_TWO,
                        signalId: SIGNAL,
                        botThreadId: BOT,
                        attempt: 2,
                        branch: `${BRANCH}-2`,
                      }
                    : undefined,
            ),
          reportMerge: (report) =>
            Effect.sync(() => {
              reports.push(report);
            }),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: (threadId) => Effect.succeed((shells.get(threadId) ?? null) as never),
        }),
        Layer.mock(PullRequestService.PullRequestService)({
          addressedProject: () =>
            scenario.failing.includes("project") ? unavailable : Effect.succeed(project),
          invalidate: () =>
            Effect.sync(() => {
              log.push("invalidate");
            }),
          detail: () =>
            Effect.suspend(() => {
              log.push("detail");
              if (scenario.failing.includes("defect")) return Effect.die("a bug in the read");
              if (scenario.failing.includes("detail")) return unavailable;
              const read = detailReads;
              detailReads += 1;
              if (scenario.heads.length === 0) return Effect.succeed(detail);
              const headSha = scenario.heads[Math.min(read, scenario.heads.length - 1)];
              return headSha === "fails"
                ? unavailable
                : Effect.succeed({ ...detail, headSha } as PullRequestDetail);
            }),
          summary: () =>
            Effect.suspend(() => {
              log.push("summary");
              return scenario.failing.includes("summary")
                ? unavailable
                : Effect.succeed({ reviewDecision: scenario.reviewDecision } as never);
            }),
          activity: () =>
            Effect.suspend(() => {
              log.push("activity");
              return scenario.failing.includes("activity")
                ? unavailable
                : Effect.succeed({
                    comments: scenario.reviews,
                    commentCount: scenario.reviews.length,
                    commentsTruncated: false,
                    reviewThreads: [],
                    commits: [],
                    ...scenario.activity,
                  } as never);
            }),
          stack: () =>
            Effect.suspend(() => {
              log.push("stack");
              return scenario.stack === "fails"
                ? unavailable
                : Effect.succeed(
                    scenario.stack === null
                      ? null
                      : ({ number: 7, layers: scenario.stack } as never),
                  );
            }),
          diff: ({ cursor }) =>
            Effect.suspend(() => {
              const page = cursor === undefined ? 0 : Number(cursor);
              log.push(`diff:${page}`);
              if (scenario.failPage === page) return unavailable;
              const pages = scenario.pageCount ?? scenario.files.length;
              return Effect.succeed({
                patch: patchOf(scenario.files[page] ?? ["page/after/the/last.ts"]),
                truncated: false,
                nextCursor: page + 1 < pages ? String(page + 1) : null,
              });
            }),
        }),
        Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
          resolveLink: (() => Effect.die("unused")) as never,
          resolve: () =>
            Effect.succeed({
              getDefaultBranch: () =>
                scenario.defaultBranch === "fails"
                  ? Effect.fail({ _tag: "SourceControlProviderError" } as never)
                  : Effect.succeed(scenario.defaultBranch),
            } as never),
        }),
      ),
    ),
  );
  return { layer, reports, log };
};

const goodArguments = { number: 7, expectedHeadSha: HEAD };

/** The call exactly as given, `undefined` among the things it may be. */
const askWith = (
  scenario: ReturnType<typeof makeScenario>,
  args: unknown,
  threadId: ThreadId = CREW,
) =>
  RepairMergeGuard.RepairMergeGuard.pipe(
    Effect.flatMap((guard) => guard.check({ threadId, environmentId, arguments: args })),
    Effect.provide(scenario.layer),
  );

const askFor = (
  scenario: ReturnType<typeof makeScenario>,
  args: unknown = goodArguments,
  threadId: ThreadId = CREW,
) => askWith(scenario, args, threadId);

const refusedWith = (verdict: RepairMergeGuard.MergeVerdict) => {
  assert.strictEqual(verdict.kind, "refused");
  return verdict.kind === "refused" ? verdict.reason : undefined;
};

// The guard is on the pull request, not on who asks: an ordinary pull request is untouched, and a
// pull request from a repair branch gets the same conditions from every caller.
it.effect("an ordinary pull request is not the guard's business, whoever asks", () => {
  // Dirty on every count: the guard would refuse it if it looked, so it must not look.
  const ordinary = {
    detail: { headBranch: "feature/x", checks: [check("CI", "failure")] },
    files: [[".github/workflows/ci.yml"]],
  };
  return Effect.gen(function* () {
    for (const threadId of [ORDINARY, BOT, SIBLING, ON_REPAIR_BRANCH]) {
      const scenario = makeScenario(ordinary);
      assert.deepStrictEqual(yield* askFor(scenario, goodArguments, threadId), {
        kind: "unguarded",
      });
      // Only the pull request's own branch was read: no files, checks or reviews.
      assert.deepStrictEqual(scenario.log, ["invalidate", "detail"]);
      assert.deepStrictEqual(scenario.reports, []);
    }
  });
});

it.effect(
  "a call that names no pull request is left alone unless the thread is on a repair branch",
  () => {
    const scenario = makeScenario();
    return Effect.gen(function* () {
      for (const args of [undefined, {}, { expectedHeadSha: HEAD }, { method: "squash" }]) {
        assert.deepStrictEqual(yield* askWith(scenario, args, ORDINARY), { kind: "unguarded" });
      }
      assert.deepStrictEqual(scenario.log, []);
      // The thread's own pull request is the repair branch's, so the call has to say which.
      const verdict = yield* askWith(scenario, { expectedHeadSha: HEAD }, ON_REPAIR_BRANCH);
      assert.strictEqual(refusedWith(verdict), "bad_arguments");
      assert.deepStrictEqual(scenario.log, []);
    });
  },
);

it.effect("a call for another machine is that machine's to guard", () => {
  const scenario = makeScenario();
  return Effect.gen(function* () {
    assert.deepStrictEqual(
      yield* askWith(scenario, { ...goodArguments, environmentId: "environment-2" }, ORDINARY),
      { kind: "unguarded" },
    );
    assert.deepStrictEqual(scenario.log, []);
  });
});

it.effect(
  "refuses when an ordinary caller's pull request cannot be read, not merging blind",
  () => {
    const unreadable = makeScenario({ failing: ["detail"] });
    const noProject = makeScenario({ failing: ["project"] });
    return Effect.gen(function* () {
      for (const scenario of [unreadable, noProject]) {
        assert.strictEqual(
          refusedWith(yield* askFor(scenario, goodArguments, ORDINARY)),
          "pull_request_unreadable",
        );
        // Nobody's repair: nothing to tell a Bot.
        assert.deepStrictEqual(scenario.reports, []);
      }
      assert.strictEqual(
        refusedWith(yield* askFor(makeScenario(), goodArguments, ThreadId.make("thread:unknown"))),
        "pull_request_unreadable",
      );
    });
  },
);

// Every caller: the Bot itself, an ordinary thread, a sibling a crew started, a crew's own
// subagent, and a thread whose crew record the 500 cap has dropped.
it.effect.each([ORDINARY, BOT, SIBLING, ON_REPAIR_BRANCH] as const)(
  "a repair branch's pull request gets the crew's conditions when %s asks",
  (threadId) => {
    const dirty = makeScenario({ files: [["apps/server/src/auth/Session.ts"]] });
    const failing = makeScenario({ detail: { checks: [check("CI", "failure")] } });
    const pending = makeScenario({ detail: { checks: [check("CI", "pending")] } });
    const noChecks = makeScenario({ detail: { checks: [] } });
    const wrongBase = makeScenario({ detail: { baseBranch: "release" } });
    const fork = makeScenario({ detail: { headRepositoryNameWithOwner: "someone/else" } });
    const requested = makeScenario({ reviews: [review("alice", "CHANGES_REQUESTED", 1)] });
    const moved = makeScenario({ heads: [HEAD, OTHER_HEAD] });
    const green = makeScenario();
    return Effect.gen(function* () {
      const refused = (scenario: ReturnType<typeof makeScenario>) =>
        askFor(scenario, goodArguments, threadId).pipe(Effect.map(refusedWith));
      assert.strictEqual(yield* refused(dirty), "protected_path");
      assert.strictEqual(yield* refused(failing), "checks_failed");
      assert.strictEqual(yield* refused(pending), "checks_pending");
      assert.strictEqual(yield* refused(noChecks), "no_checks");
      assert.strictEqual(yield* refused(wrongBase), "wrong_target");
      assert.strictEqual(yield* refused(fork), "fork_pull_request");
      assert.strictEqual(yield* refused(requested), "changes_requested");
      assert.strictEqual(yield* refused(moved), "head_changed");
      // The crew's Bot is told, as for a crew's own call: the record names the attempt's thread.
      assert.deepStrictEqual(dirty.reports, [
        { crewThreadId: CREW, number: 7, merged: false, reason: "protected_path" },
      ]);
      // A green one goes through, and its result is reported to the same repair.
      assert.deepStrictEqual(yield* askFor(green, goodArguments, threadId), {
        kind: "allowed",
        crewThreadId: CREW,
        number: 7,
      });
    });
  },
);

it.effect("a repair branch's pull request from a record the server has lost is refused", () => {
  const lost = makeScenario({ recordsLost: true });
  const invented = makeScenario({ detail: { headBranch: "repair/ffffffffffff" } });
  const shaped = makeScenario({ detail: { headBranch: "repair/anything-i-like" } });
  const shouted = makeScenario({ detail: { headBranch: "Repair/0123456789ab" } });
  const nextAttempt = makeScenario({ detail: { headBranch: `${BRANCH}-9` } });
  return Effect.gen(function* () {
    for (const scenario of [lost, invented, shaped, shouted, nextAttempt]) {
      assert.strictEqual(
        refusedWith(yield* askFor(scenario, goodArguments, ORDINARY)),
        "no_repair_record",
      );
      // Not the files, checks or reviews: nothing says whose pull request this is.
      assert.notInclude(scenario.log, "diff:0");
      assert.deepStrictEqual(scenario.reports, []);
    }
  });
});

it.effect(
  "a repair branch's pull request is only ever merged with a call the server can check",
  () => {
    const scenario = makeScenario();
    return Effect.gen(function* () {
      for (const args of [
        { ...goodArguments, auto: true },
        { ...goodArguments, stack: true },
        { number: 7 },
        { ...goodArguments, repository: "JackTYM/t3code" },
        { ...goodArguments, surprise: 1 },
      ]) {
        assert.strictEqual(refusedWith(yield* askWith(scenario, args, ORDINARY)), "bad_arguments");
      }
      // Told to the Bot by the repair's record, since the branch names it.
      assert.isAbove(scenario.reports.length, 0);
      assert.isTrue(scenario.reports.every((report) => report.crewThreadId === CREW));
    });
  },
);

it.effect("a stack merge is refused when any layer is from a repair branch", () => {
  const layers = [
    { number: 3, headBranch: BRANCH, state: "open" },
    { number: 7, headBranch: "feature/x", state: "open" },
  ];
  const withRepair = makeScenario({ detail: { headBranch: "feature/x" }, stack: layers });
  const withoutRepair = makeScenario({
    detail: { headBranch: "feature/x" },
    stack: [{ number: 7, headBranch: "feature/x", state: "open" }],
  });
  const mergedRepair = makeScenario({
    detail: { headBranch: "feature/x" },
    stack: [{ number: 3, headBranch: BRANCH, state: "merged" }, layers[1]!],
  });
  const unreadable = makeScenario({ detail: { headBranch: "feature/x" }, stack: "fails" });
  const args = { ...goodArguments, stack: true };
  return Effect.gen(function* () {
    assert.strictEqual(refusedWith(yield* askWith(withRepair, args, ORDINARY)), "bad_arguments");
    assert.deepStrictEqual(yield* askWith(withoutRepair, args, ORDINARY), { kind: "unguarded" });
    assert.deepStrictEqual(yield* askWith(mergedRepair, args, ORDINARY), { kind: "unguarded" });
    assert.strictEqual(
      refusedWith(yield* askWith(unreadable, args, ORDINARY)),
      "pull_request_unreadable",
    );
    // Without stack, the same pull request is not looked at beyond its own branch.
    const plain = makeScenario({ detail: { headBranch: "feature/x" }, stack: layers });
    assert.deepStrictEqual(yield* askFor(plain, goodArguments, ORDINARY), { kind: "unguarded" });
    assert.notInclude(plain.log, "stack");
  });
});

it.effect(
  "names the repository the way the merge tool does, for a caller that is not a crew",
  () => {
    const scenario = makeScenario({ detail: { headBranch: "feature/x" } });
    return Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* askWith(scenario, { ...goodArguments, repository: "JackTYM/t3code" }, ORDINARY),
        { kind: "unguarded" },
      );
      assert.deepStrictEqual(scenario.log, ["invalidate", "detail"]);
    });
  },
);

it.effect("allows a green pull request from the crew's own branch, read fresh", () => {
  const scenario = makeScenario();
  return Effect.gen(function* () {
    assert.deepStrictEqual(yield* askFor(scenario), {
      kind: "allowed",
      crewThreadId: CREW,
      number: 7,
    });
    // The host is asked again before anything is read, so no held answer can decide.
    assert.strictEqual(scenario.log[0], "invalidate");
    assert.deepInclude(scenario.log, "detail");
    assert.deepInclude(scenario.log, "diff:0");
    assert.deepInclude(scenario.log, "activity");
    assert.deepStrictEqual(scenario.reports, []);
  });
});

const OTHER_HEAD = "0f1e2d3c4b5a69788796a5b4c3d2e1f001122334";

// The merge is pinned to the head the crew names, but the file list is a separate read: a crew could
// show a clean head to that read and put the other one back before the merge. The head is read
// once more after everything else, and has to be the one every earlier read was about.
it.effect("refuses a pull request whose head changed while it was being checked", () => {
  const scenario = makeScenario({ heads: [HEAD, OTHER_HEAD] });
  return Effect.gen(function* () {
    assert.strictEqual(refusedWith(yield* askFor(scenario)), "head_changed");
    assert.deepStrictEqual(scenario.reports, [
      { crewThreadId: CREW, number: 7, merged: false, reason: "head_changed" },
    ]);
    // The head was read last: after the files and the reviews, not before them.
    const reads = scenario.log.flatMap((entry, at) => (entry === "detail" ? [at] : []));
    assert.lengthOf(reads, 2);
    assert.isAbove(reads[1]!, scenario.log.lastIndexOf("diff:0"));
    assert.isAbove(reads[1]!, scenario.log.lastIndexOf("activity"));
  });
});

it.effect.each([
  ["reports no head", undefined],
  ["cannot be read", "fails"],
] as const)("refuses a pull request whose last read %s", ([, last]) => {
  // The first read is the good one: no merge on the strength of it alone.
  const scenario = makeScenario({ heads: [HEAD, last] });
  return Effect.gen(function* () {
    const reason = refusedWith(yield* askFor(scenario));
    assert.strictEqual(reason, last === "fails" ? "pull_request_unreadable" : "head_changed");
  });
});

it.effect("allows a pull request whose head is the same on every read", () => {
  const scenario = makeScenario({ heads: [HEAD, HEAD, HEAD] });
  return Effect.gen(function* () {
    assert.strictEqual((yield* askFor(scenario)).kind, "allowed");
    assert.lengthOf(
      scenario.log.filter((entry) => entry === "detail"),
      2,
    );
  });
});

it.effect("a subagent of a crew is held to the same guard, as the crew", () => {
  const scenario = makeScenario({ detail: { checks: [] } });
  return Effect.gen(function* () {
    assert.strictEqual(refusedWith(yield* askFor(scenario, goodArguments, SUBAGENT)), "no_checks");
    assert.deepStrictEqual(scenario.reports, [
      { crewThreadId: CREW, number: 7, merged: false, reason: "no_checks" },
    ]);
    const allowed = makeScenario();
    assert.deepStrictEqual(yield* askFor(allowed, goodArguments, SUBAGENT), {
      kind: "allowed",
      crewThreadId: CREW,
      number: 7,
    });
  });
});

it.effect("a second attempt's crew merges its own branch and not the first attempt's", () => {
  const second = makeScenario({ detail: { headBranch: `${BRANCH}-2` } });
  const first = makeScenario({ detail: { headBranch: BRANCH } });
  return Effect.gen(function* () {
    assert.strictEqual((yield* askFor(second, goodArguments, CREW_TWO)).kind, "allowed");
    assert.strictEqual(refusedWith(yield* askFor(first, goodArguments, CREW_TWO)), "wrong_branch");
  });
});

it.effect.each([
  ["no arguments", undefined],
  ["arguments that are not an object", "7"],
  ["an array", [7]],
  ["no number", { expectedHeadSha: HEAD }],
  ["a number that is a string", { number: "7", expectedHeadSha: HEAD }],
  ["a number that is not whole", { number: 7.5, expectedHeadSha: HEAD }],
  ["a number that is zero", { number: 0, expectedHeadSha: HEAD }],
  ["a negative number", { number: -7, expectedHeadSha: HEAD }],
  ["no expected head", { number: 7 }],
  ["an expected head that is empty", { number: 7, expectedHeadSha: "  " }],
  ["an expected head that is not text", { number: 7, expectedHeadSha: 12 }],
  ["another repository", { ...goodArguments, repository: "someone/else" }],
  ["auto-merge", { ...goodArguments, auto: true }],
  ["a stack merge", { ...goodArguments, stack: true }],
  ["another machine", { ...goodArguments, environmentId: "environment-2" }],
  ["an argument nobody knows", { ...goodArguments, surprise: 1 }],
] as const)("refuses a call with $0, which the server cannot check", ([, args]) => {
  const scenario = makeScenario();
  return Effect.gen(function* () {
    assert.strictEqual(refusedWith(yield* askWith(scenario, args)), "bad_arguments");
    // It never reached the host, and the Bot is told there was no pull request to name.
    assert.deepStrictEqual(scenario.log, []);
    assert.strictEqual(scenario.reports.length, 1);
    assert.strictEqual(scenario.reports[0]!.reason, "bad_arguments");
    assert.strictEqual(scenario.reports[0]!.merged, false);
  });
});

it.effect("allows what a call may also say: this machine, a method, and auto or stack off", () => {
  const scenario = makeScenario();
  return Effect.gen(function* () {
    const verdict = yield* askFor(scenario, {
      ...goodArguments,
      environmentId: "environment-1",
      method: "squash",
      auto: false,
      stack: false,
    });
    assert.strictEqual(verdict.kind, "allowed");
  });
});

it.effect("an expected head in other letters and spaces still has to be the head", () => {
  const scenario = makeScenario();
  return Effect.gen(function* () {
    const verdict = yield* askFor(scenario, {
      number: 7,
      expectedHeadSha: `  ${HEAD.toUpperCase()}\n`,
    });
    assert.strictEqual(verdict.kind, "allowed");
  });
});

const refusals: ReadonlyArray<
  readonly [string, Partial<Scenario>, RepairService.MergeRefusalReason]
> = [
  [
    "the host cannot be read for the pull request",
    { failing: ["detail"] },
    "pull_request_unreadable",
  ],
  ["the project cannot be found", { failing: ["project"] }, "pull_request_unreadable"],
  ["it is closed", { detail: { state: "closed" } }, "not_open"],
  ["it is merged", { detail: { state: "merged" } }, "not_open"],
  ["it is a draft", { detail: { isDraft: true } }, "not_open"],
  ["its branch is another's", { detail: { headBranch: "repair/ffffffffffff" } }, "wrong_branch"],
  ["its branch is a longer name", { detail: { headBranch: `${BRANCH}-evil` } }, "wrong_branch"],
  [
    "its branch is the same in other letters",
    { detail: { headBranch: BRANCH.toUpperCase() } },
    "wrong_branch",
  ],
  ["its branch is the default branch", { detail: { headBranch: "main" } }, "wrong_branch"],
  [
    "its branch is in a fork",
    { detail: { headRepositoryNameWithOwner: "mallory/t3code" } },
    "fork_pull_request",
  ],
  [
    "its head repository is not reported",
    { detail: { headRepositoryNameWithOwner: null } },
    "fork_pull_request",
  ],
  ["it targets another branch", { detail: { baseBranch: "develop" } }, "wrong_target"],
  [
    "it targets the default branch in other letters",
    { detail: { baseBranch: "Main" } },
    "wrong_target",
  ],
  ["the default branch cannot be read", { defaultBranch: "fails" }, "target_unreadable"],
  ["the host names no default branch", { defaultBranch: null }, "target_unreadable"],
  ["the head moved", { detail: { headSha: "b".repeat(40) } }, "head_moved"],
  ["the host reports no head", { detail: { headSha: undefined } }, "pull_request_unreadable"],
  ["the check itself breaks", { failing: ["defect"] }, "pull_request_unreadable"],
  ["it has no checks at all", { detail: { checks: [] } }, "no_checks"],
  ["its only checks were skipped", { detail: { checks: [check("CI", "skipped")] } }, "no_checks"],
  [
    "a check is pending",
    { detail: { checks: [check("CI", "success"), check("E2E", "pending")] } },
    "checks_pending",
  ],
  [
    "a check has a status nobody knows",
    { detail: { checks: [check("CI", "success"), check("Odd", "mystery" as never)] } },
    "checks_unreadable",
  ],
  [
    "a check needs approval",
    { detail: { checks: [check("CI", "success"), check("E2E", "action-required" as never)] } },
    "checks_pending",
  ],
  [
    "workflow runs wait for approval",
    { detail: { workflowApprovalsRequired: 1 } },
    "checks_pending",
  ],
  [
    "a check failed",
    { detail: { checks: [check("CI", "success"), check("Lint", "failure")] } },
    "checks_failed",
  ],
  [
    "a check was cancelled",
    { detail: { checks: [check("CI", "success"), check("E2E", "cancelled" as never)] } },
    "checks_failed",
  ],
  [
    "a failed check hides among passing ones",
    { detail: { checks: [check("a", "success"), check("b", "failure"), check("c", "success")] } },
    "checks_failed",
  ],
  [
    "a required check was skipped",
    { detail: { checks: [check("CI", "success"), check("Docs", "skipped", { required: true })] } },
    "required_check_skipped",
  ],
  [
    "the host could not list some checks",
    {
      detail: {
        checks: [check("CI", "success"), check("Approval", "pending", { placeholder: true })],
      },
    },
    "checks_unreadable",
  ],
  [
    "it changes a protected path",
    { files: [["apps/server/src/auth/Session.ts"]] },
    "protected_path",
  ],
  ["the files cannot be read", { failPage: 0 }, "files_unreadable"],
  [
    "the host lists fewer files than the pull request changes",
    { detail: { changedFiles: 5 } },
    "files_unreadable",
  ],
  [
    "the host lists more files than the pull request changes",
    { detail: { changedFiles: 0 } },
    "files_unreadable",
  ],
  [
    "it has a review asking for changes",
    { reviews: [review("alice", "CHANGES_REQUESTED", 1)] },
    "changes_requested",
  ],
  [
    "the host says changes are requested",
    { reviewDecision: "changes-requested" },
    "changes_requested",
  ],
  ["the head changed while it was being checked", { heads: [HEAD, OTHER_HEAD] }, "head_changed"],
  ["the reviews cannot be read", { failing: ["activity"] }, "reviews_unreadable"],
  ["the review decision cannot be read", { failing: ["summary"] }, "reviews_unreadable"],
  ["the reviews were cut short", { activity: { commentsTruncated: true } }, "reviews_unreadable"],
];

it.effect.each(refusals)("refuses when $0, as $2", ([, overrides, reason]) => {
  const scenario = makeScenario(overrides);
  return Effect.gen(function* () {
    const verdict = yield* askFor(scenario);
    assert.strictEqual(refusedWith(verdict), reason);
    assert.strictEqual(
      verdict.kind === "refused" ? verdict.message : "",
      RepairService.MERGE_REFUSAL_MESSAGES[reason],
    );
    // The Bot is told once, with the pull request's number and the code.
    assert.deepStrictEqual(scenario.reports, [
      { crewThreadId: CREW, number: 7, merged: false, reason },
    ]);
  });
});

it.effect("gives each thing it checks its own reason and its own words", () =>
  Effect.sync(() => {
    const reasons = RepairService.MergeRefusalReason.literals;
    assert.strictEqual(
      new Set(Object.values(RepairService.MERGE_REFUSAL_MESSAGES)).size,
      reasons.length,
    );
    for (const reason of reasons) {
      assert.match(RepairService.MERGE_REFUSAL_MESSAGES[reason], /^The merge was refused: /u);
    }
    // Every code is one a case above reaches, so none is a dead letter.
    // `no_repair_record` is the one a crew cannot reach, so it has a case of its own above.
    const reached = new Set([
      ...refusals.map(([, , reason]) => reason),
      "bad_arguments",
      "no_repair_record",
    ]);
    assert.deepStrictEqual([...reached].sort(), [...reasons].sort());
  }),
);

it.effect("counts a skipped check that is not required as no check, but not as a failure", () => {
  const scenario = makeScenario({
    detail: {
      checks: [
        check("CI", "success"),
        check("Docs", "skipped"),
        check("Preview", "skipped", { required: false }),
      ],
    },
  });
  return Effect.gen(function* () {
    assert.strictEqual((yield* askFor(scenario)).kind, "allowed");
  });
});

it.effect("refuses a path that is protected on either side of a rename", () => {
  const protectedToPlain = makeScenario({
    files: [[{ from: "apps/server/src/auth/Session.ts", to: "apps/server/src/Session.ts" }]],
  });
  const plainToProtected = makeScenario({
    files: [[{ from: "apps/server/src/Session.ts", to: "apps/server/src/auth/Session.ts" }]],
  });
  const plainToPlain = makeScenario({
    files: [[{ from: "apps/server/src/A.ts", to: "apps/server/src/B.ts" }]],
  });
  return Effect.gen(function* () {
    assert.strictEqual(refusedWith(yield* askFor(protectedToPlain)), "protected_path");
    assert.strictEqual(refusedWith(yield* askFor(plainToProtected)), "protected_path");
    assert.strictEqual((yield* askFor(plainToPlain)).kind, "allowed");
  });
});

it.effect("reads every page of the files, so a protected one on a later page is found", () => {
  const page = (n: number) => Array.from({ length: 30 }, (_, i) => `apps/web/src/p${n}f${i}.ts`);
  const clean = makeScenario({ files: [page(0), page(1), page(2)] });
  const late = makeScenario({
    files: [page(0), page(1), [...page(2).slice(0, 29), ".github/workflows/ci.yml"]],
  });
  const lastOfMany = makeScenario({
    files: [page(0), page(1), page(2), ["scripts/release.ts"]],
  });
  return Effect.gen(function* () {
    assert.strictEqual((yield* askFor(clean)).kind, "allowed");
    assert.deepStrictEqual(
      clean.log.filter((entry) => entry.startsWith("diff:")),
      ["diff:0", "diff:1", "diff:2"],
    );
    assert.strictEqual(refusedWith(yield* askFor(late)), "protected_path");
    assert.strictEqual(refusedWith(yield* askFor(lastOfMany)), "protected_path");
  });
});

it.effect("refuses when a later page of the files cannot be read, and does not guess", () => {
  const page = (n: number) => Array.from({ length: 30 }, (_, i) => `apps/web/src/p${n}f${i}.ts`);
  const scenario = makeScenario({ files: [page(0), page(1), page(2)], failPage: 2 });
  return Effect.gen(function* () {
    assert.strictEqual(refusedWith(yield* askFor(scenario)), "files_unreadable");
  });
});

it.effect("refuses a list of files that never ends", () => {
  // A host that always says there is another page.
  const scenario = makeScenario({ files: [["apps/web/src/a.ts"]], pageCount: 10_000 });
  return Effect.gen(function* () {
    assert.strictEqual(refusedWith(yield* askFor(scenario)), "files_unreadable");
    assert.isBelow(scenario.log.length, 200);
  });
});

it.effect("a review asking for changes counts until its author says otherwise", () => {
  const superseded = makeScenario({
    reviews: [review("alice", "CHANGES_REQUESTED", 1), review("alice", "APPROVED", 2)],
  });
  const dismissed = makeScenario({
    reviews: [review("alice", "CHANGES_REQUESTED", 1), review("alice", "DISMISSED", 2)],
  });
  const another = makeScenario({
    reviews: [
      review("alice", "CHANGES_REQUESTED", 1),
      review("bob", "APPROVED", 2),
      review("alice", "COMMENTED", 3),
    ],
  });
  const reversed = makeScenario({
    reviews: [review("alice", "APPROVED", 1), review("alice", "CHANGES_REQUESTED", 2)],
  });
  const commentOnly = makeScenario({ reviews: [review("alice", "COMMENTED", 1)] });
  return Effect.gen(function* () {
    assert.strictEqual((yield* askFor(superseded)).kind, "allowed");
    assert.strictEqual((yield* askFor(dismissed)).kind, "allowed");
    assert.strictEqual((yield* askFor(commentOnly)).kind, "allowed");
    // A second reviewer's approval does not answer the first's request, and a comment is no answer.
    assert.strictEqual(refusedWith(yield* askFor(another)), "changes_requested");
    assert.strictEqual(refusedWith(yield* askFor(reversed)), "changes_requested");
  });
});

it.effect("settles a merge it allowed, as merged or as one the host refused", () => {
  const scenario = makeScenario();
  return Effect.gen(function* () {
    const guard = yield* RepairMergeGuard.RepairMergeGuard;
    yield* guard.settle({ crewThreadId: CREW, number: 7, merged: true });
    yield* guard.settle({ crewThreadId: CREW, number: 8, merged: false });
    assert.deepStrictEqual(scenario.reports, [
      { crewThreadId: CREW, number: 7, merged: true, reason: "merged" },
      { crewThreadId: CREW, number: 8, merged: false, reason: "merge_failed" },
    ]);
  }).pipe(Effect.provide(scenario.layer));
});

const protectedCases: ReadonlyArray<readonly [string, string]> = [
  ["apps/server/src/bots/BotHoldService.ts", "apps/server/src/bots/BotHoldService*"],
  ["apps/server/src/bots/BotHoldService.test.ts", "apps/server/src/bots/BotHoldService*"],
  ["apps/server/src/bots/RepairService.ts", "apps/server/src/bots/RepairService*"],
  ["apps/server/src/bots/RepairMergeGuard.test.ts", "apps/server/src/bots/RepairMergeGuard*"],
  ["apps/server/src/bots/WatcherService.ts", "apps/server/src/bots/WatcherService*"],
  ["apps/server/src/bots/BotService.ts", "apps/server/src/bots/BotService*"],
  ["apps/server/src/bots/BotWakeReactor.ts", "apps/server/src/bots/BotWakeReactor*"],
  ["packages/contracts/src/home.ts", "packages/contracts/src/home*"],
  ["packages/contracts/src/homeSettings.ts", "packages/contracts/src/home*"],
  ["packages/contracts/src/botHolds.ts", "packages/contracts/src/botHolds*"],
  ["packages/contracts/src/botWatchers.ts", "packages/contracts/src/botWatchers*"],
  [
    "packages/provider-core/src/server/textGenerationPrompts.ts",
    "packages/provider-core/src/server/textGenerationPrompts*",
  ],
  ["apps/server/src/server.ts", "apps/server/src/server.ts"],
  ["apps/server/src/mcp/McpHttpServer.ts", "apps/server/src/mcp/McpHttpServer*"],
  ["apps/server/src/mcp/McpHttpServer.test.ts", "apps/server/src/mcp/McpHttpServer*"],
  ["apps/server/src/mcp/McpToolAccess.ts", "apps/server/src/mcp/McpToolAccess*"],
  ["apps/server/src/mcp/McpInvocationContext.ts", "apps/server/src/mcp/McpInvocationContext*"],
  ["apps/server/src/sourceControl/ServerSourceControlHost.ts", "apps/server/src/sourceControl/**"],
  [
    "packages/source-control-core/src/server/PullRequestProvider.ts",
    "packages/source-control-core/**",
  ],
  ["apps/server/src/secrets/SecretStore.ts", "apps/server/src/secrets/**"],
  ["apps/server/src/workflows/WorkflowForge.ts", "apps/server/src/workflows/WorkflowForge*"],
  ["apps/server/src/workflows/WorkflowForge.test.ts", "apps/server/src/workflows/WorkflowForge*"],
  // Who may connect, and what a link, a token or a policy lets them do.
  ["apps/server/src/http.ts", "apps/server/src/http.ts"],
  ["apps/server/src/guest/GuestShareService.ts", "apps/server/src/guest/**"],
  ["apps/server/src/peer/PeerLinks.ts", "apps/server/src/peer/**"],
  ["apps/server/src/relay/HeldHooksWaker.ts", "apps/server/src/relay/**"],
  ["apps/server/src/policy/managedUpdates.ts", "apps/server/src/policy/**"],
  ["packages/shared/src/authScopeOptions.ts", "packages/shared/src/authScopeOptions*"],
  ["packages/shared/src/connectAuth.ts", "packages/shared/src/connectAuth*"],
  ["packages/shared/src/desktopBootstrapToken.ts", "packages/shared/src/desktopBootstrapToken*"],
  // How the server updates and releases itself.
  ["apps/server/src/cloud/selfUpdate.ts", "apps/server/src/cloud/**"],
  ["apps/server/src/cloud/npmRelease.ts", "apps/server/src/cloud/**"],
  ["apps/server/src/cloud/pinnedRuntime.ts", "apps/server/src/cloud/**"],
  ["apps/server/src/cloud/updateHandoff.ts", "apps/server/src/cloud/**"],
  ["apps/server/src/desktopUpdate/DesktopAppUpdate.ts", "apps/server/src/desktopUpdate/**"],
  ["packages/shared/src/cliRelease.ts", "packages/shared/src/cliRelease*"],
  ["packaging/aur/PKGBUILD", "packaging/**"],
  ["packages/shared/pnpm-lock.yaml", "packages/*/pnpm-lock.yaml"],
  ["apps/server/src/home/HomeService.ts", "apps/server/src/home/**"],
  ["apps/server/src/home/deep/er/File.ts", "apps/server/src/home/**"],
  ["apps/server/src/mcp/toolkits/bot/handlers.ts", "apps/server/src/mcp/toolkits/bot/**"],
  ["apps/server/src/mcp/toolkits/watcher/tools.ts", "apps/server/src/mcp/toolkits/watcher/**"],
  [
    "apps/server/src/mcp/toolkits/pullRequests/handlers.ts",
    "apps/server/src/mcp/toolkits/pullRequests/**",
  ],
  ["apps/server/src/pullRequest/PullRequestService.ts", "apps/server/src/pullRequest/**"],
  [
    "packages/source-control-github/src/server/GitHubPullRequestApi.ts",
    "packages/source-control-github/**",
  ],
  [".github/workflows/ci.yml", ".github/**"],
  [".github/CODEOWNERS", ".github/**"],
  ["scripts/release-smoke.ts", "scripts/**"],
  ["scripts/lib/windows-jsign.ts", "scripts/**"],
  ["scripts/sign-macos.ts", "scripts/**"],
  [".vite-hooks/pre-commit", ".vite-hooks/**"],
  ["t3.json", "t3.json"],
  ["package.json", "package.json"],
  ["pnpm-lock.yaml", "pnpm-lock.yaml"],
  ["packages/shared/package.json", "packages/*/package.json"],
  ["packages/contracts/package.json", "packages/*/package.json"],
  ["apps/server/package.json", "apps/*/package.json"],
  ["apps/desktop/package.json", "apps/*/package.json"],
  ["apps/web/pnpm-lock.yaml", "apps/*/pnpm-lock.yaml"],
  ["patches/electron-updater@6.8.9.patch", "patches/**"],
  [".pnpmfile.cjs", ".pnpmfile.cjs"],
  ["pnpm-workspace.yaml", "pnpm-workspace.yaml"],
  ["apps/desktop/src/updates/FullUpdate.ts", "apps/desktop/src/updates/**"],
  ["apps/desktop/src/updates/updateChannels.ts", "apps/desktop/src/updates/**"],
  ["apps/desktop/src/electron/ElectronUpdater.ts", "apps/desktop/src/electron/ElectronUpdater*"],
  ["apps/desktop/src/ipc/methods/updates.ts", "apps/desktop/src/ipc/methods/updates*"],
  ["apps/desktop/resources/installer.nsh", "apps/desktop/resources/**"],
  // Named for updating or signing anywhere in the desktop app, in any case.
  ["apps/desktop/src/anywhere/deep/AutoUpdater.ts", "apps/desktop/**/*updat*"],
  ["apps/desktop/src/Updater.ts", "apps/desktop/**/*updat*"],
  ["apps/desktop/src/codesign.ts", "apps/desktop/**/*sign*"],
  // What agents are told, given and taught.
  ["AGENTS.md", "AGENTS.md"],
  ["CLAUDE.md", "CLAUDE.md"],
  ["apps/web/AGENTS.md", "**/AGENTS.md"],
  ["packages/deep/er/CLAUDE.md", "**/CLAUDE.md"],
  [".agents/skills/x/SKILL.md", ".agents/**"],
  [".cursor/rules/a.mdc", ".cursor/**"],
  [".claude/skills/x/SKILL.md", ".claude/**"],
  ["skills/test-t3-app/SKILL.md", "skills/**"],
  ["docs/internals/bots.md", "docs/**"],
  ["evals/mcp-tool-use/case.ts", "evals/**"],
  // What the checks run and judge with.
  ["vite.config.ts", "vite.config.ts"],
  ["apps/server/vite.config.ts", "**/vite.config.ts"],
  ["apps/server/vitest.config.ts", "**/vitest*.config.*"],
  ["vitest.workspace.config.mts", "**/vitest*.config.*"],
  ["knip.jsonc", "knip.jsonc"],
  ["tsconfig.base.json", "tsconfig*.json"],
  ["tsconfig.effect.json", "tsconfig*.json"],
  ["apps/server/tsconfig.json", "**/tsconfig*.json"],
  ["packages/shared/tsconfig.test.json", "**/tsconfig*.json"],
  ["oxlint-plugin-t3code/rules/no-low-value-comments.ts", "oxlint-plugin-t3code/**"],
  [".macroscope/rules.yml", ".macroscope/**"],
  [".coderabbit.config.ts", ".coderabbit.config.ts"],
  [".devcontainer/devcontainer.json", ".devcontainer/**"],
  [".vscode/tasks.json", ".vscode/**"],
  [".cargo/config.toml", ".cargo/**"],
  ["infra/mail-worker/src/index.ts", "infra/**"],
  // Where a Bot, a thread or a tool is allowed to do something.
  ["apps/server/src/bots/BotTestkit.ts", "apps/server/src/bots/**"],
  ["apps/server/src/bots/BotMailService.ts", "apps/server/src/bots/**"],
  ["apps/server/src/orchestration-v2/RuntimePolicy.ts", "apps/server/src/orchestration-v2/**"],
  [
    "apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts",
    "apps/server/src/orchestration-v2/**",
  ],
  ["apps/server/src/mcp/McpToolExposure.ts", "apps/server/src/mcp/**"],
  ["apps/server/src/mcp/toolkits/botx/handlers.ts", "apps/server/src/mcp/**"],
  ["apps/server/src/scheduledTasks/webhookTemplate.ts", "apps/server/src/scheduledTasks/**"],
  ["apps/server/src/scheduledTasks/ScheduledTaskService.ts", "apps/server/src/scheduledTasks/**"],
  ["apps/server/src/serverSettings.ts", "apps/server/src/serverSettings.ts"],
  ["apps/server/src/ws.ts", "apps/server/src/ws.ts"],
  ["apps/server/src/persistence/Migrations/001_Init.ts", "apps/server/src/persistence/**"],
  ["apps/server/src/provider/acp/AntigravityAcpSupport.ts", "apps/server/src/provider/**"],
  ["packages/contracts/src/orchestrationV2.ts", "packages/contracts/**"],
  ["packages/provider-acp/src/server/clientPolicy.ts", "packages/provider-*/**"],
  ["packages/provider-core/src/server/runtimeInstructions.ts", "packages/provider-*/**"],
  ["packages/source-control-definitions/src/registry.ts", "packages/source-control-definitions/**"],
  // A path is compared without regard to case, since a checkout may be on a case-blind disk.
  ["APPS/SERVER/SRC/AUTH/session.ts", "apps/server/src/auth/**"],
  ["Scripts/Release.TS", "scripts/**"],
  ["Package.JSON", "package.json"],
  // A leading ./ or a backslash is the same path.
  ["./scripts/a.ts", "scripts/**"],
  ["scripts\\a.ts", "scripts/**"],
];

it.effect.each(protectedCases)("%s is protected by %s", ([path, pattern]) =>
  Effect.sync(() => {
    assert.strictEqual(RepairMergeGuard.protectedPatternOf(path), pattern);
  }),
);

const unprotectedCases = [
  "README.md",
  "apps/server/src/auth.ts",
  "apps/server/src/authors/Writer.ts",
  "apps/server/src/homework/Plan.ts",
  "packages/shared/src/package.json.ts",
  "packages/shared/src/deep/package.json",
  "packages/a/b/package.json",
  "apps/web/src/package.json",
  "github/workflows/ci.yml",
  "src/.github/workflows/ci.yml",
  "scripts.md",
  "script/run.ts",
  "apps/desktop/src/app/DesktopApp.ts",
  "apps/desktop/src/windows/MainWindow.ts",
  "apps/web/src/components/Update.tsx",
  "apps/web/src/signin/Page.tsx",
  "t3.json.md",
  "xt3.json",
  // Near the new groups, and not in them: a directory that only starts with the same letters.
  "apps/server/src/botsy/Thing.ts",
  "apps/server/src/orchestration/Thing.ts",
  "apps/server/src/mcpish/Thing.ts",
  "apps/server/src/wsx.ts",
  "apps/server/src/serverSettingsView.ts",
  "apps/server/src/persistence.ts",
  "apps/server/src/providers/Thing.ts",
  "packages/contractsx/src/a.ts",
  "packages/providers/src/a.ts",
  "docs.md",
  "skillset/a.md",
  "evalsuite/a.ts",
  "AGENTS.mdx",
  "apps/web/src/NOTAGENTS.md",
  "apps/web/vite.config.tsx",
  "apps/web/src/tsconfig.json.ts",
  "knip.jsonc.bak",
  "infrastructure/a.ts",
  "oxlint-plugin-t3codex/a.ts",
  "apps/web/src/components/Thread.tsx",
  "apps/server/src/git/GitWorkflowService.ts",
  // Next to the groups added for connecting, updating and releasing, and not in them.
  "apps/server/src/cloudy/a.ts",
  "apps/server/src/desktopUpdates/a.ts",
  "apps/server/src/guestbook/a.ts",
  "apps/server/src/peers/a.ts",
  "apps/server/src/relayed/a.ts",
  "apps/server/src/policies/a.ts",
  "apps/server/src/http.tsx",
  "apps/server/src/httpClient.ts",
  "apps/server/src/scheduledTasksView/a.ts",
  "apps/server/src/workflows/api.ts",
  "apps/server/src/workflows/Workflows.ts",
  "packages/shared/src/authScope.ts",
  "packages/shared/src/connect.ts",
  "packages/shared/src/release.ts",
];

it.effect.each(unprotectedCases)("%s is not protected", (path) =>
  Effect.sync(() => {
    assert.isUndefined(RepairMergeGuard.protectedPatternOf(path));
  }),
);

it.effect("protects every entry of the list, by a path that only it matches", () =>
  Effect.sync(() => {
    const matched = new Set(protectedCases.map(([, pattern]) => pattern));
    // `apps/desktop/**` entries and the pull request toolkit are the ones with their own cases above.
    for (const pattern of RepairService.PROTECTED_PATHS) {
      assert.isTrue(matched.has(pattern), `no case above reaches ${pattern}`);
    }
  }),
);
