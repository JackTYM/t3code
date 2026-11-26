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
}

const scenarioDefaults = {
  detail: {},
  files: [["apps/server/src/bots/Thing.ts"]],
  reviews: [],
  activity: {},
  reviewDecision: null,
  defaultBranch: "main",
  failing: [],
  failPage: null,
  pageCount: null,
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
  const shell = (id: ThreadId, root: ThreadId, parent: ThreadId | null) => ({
    id,
    projectId: PROJECT_ID,
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
    [ORDINARY, shell(ORDINARY, ORDINARY, null)],
    [BOT, shell(BOT, BOT, null)],
  ]);
  const unavailable = Effect.fail({ _tag: "PullRequestUnavailableError" } as never);

  const layer = RepairMergeGuard.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(RepairService.RepairService)({
          repairOf: (threadId) =>
            Effect.succeed(
              threadId === CREW
                ? { signalId: SIGNAL, botThreadId: BOT, attempt: 1, branch: BRANCH }
                : threadId === CREW_TWO
                  ? { signalId: SIGNAL, botThreadId: BOT, attempt: 2, branch: `${BRANCH}-2` }
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
              return scenario.failing.includes("detail") ? unavailable : Effect.succeed(detail);
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

it.effect("a thread that is not a repair crew is not the guard's business", () => {
  const scenario = makeScenario({ failing: ["detail", "project"] });
  return Effect.gen(function* () {
    for (const threadId of [ORDINARY, BOT, ThreadId.make("thread:unknown")]) {
      assert.deepStrictEqual(yield* askFor(scenario, goodArguments, threadId), {
        kind: "unguarded",
      });
    }
    assert.deepStrictEqual(yield* askWith(scenario, undefined, ORDINARY), { kind: "unguarded" });
    // Nothing was read and nothing was reported for any of them.
    assert.deepStrictEqual(scenario.log, []);
    assert.deepStrictEqual(scenario.reports, []);
  });
});

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
    const reached = new Set([...refusals.map(([, , reason]) => reason), "bad_arguments"]);
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
  "apps/server/src/bots/BotTestkit.ts",
  "apps/server/src/bots/Bots.ts",
  "apps/server/src/bots/Repair.ts",
  "apps/server/src/mcp/toolkits/bot.ts",
  "apps/server/src/mcp/toolkits/botx/handlers.ts",
  "apps/server/src/auth.ts",
  "apps/server/src/authors/Writer.ts",
  "apps/server/src/homework/Plan.ts",
  "packages/contracts/src/homo.ts",
  "packages/contracts/src/botHoldsX/y.ts",
  "packages/shared/src/package.json.ts",
  "packages/shared/src/deep/package.json",
  "packages/a/b/package.json",
  "apps/web/src/package.json",
  "docs/package.json.md",
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
