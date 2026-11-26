import type {
  EnvironmentId,
  PullRequestDetail,
  PullRequestRef,
  ThreadId,
} from "@t3tools/contracts";
import { parseDiffFilePaths } from "@t3tools/source-control-core/server/diffFileRevisions";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import { resolveTarget } from "../pullRequest/pullRequestTarget.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import * as RepairService from "./RepairService.ts";

/**
 * Not a sandbox. A crew's shell runs as the user, with their `gh` login and git credentials, and
 * nothing here sees it: it can still `gh pr merge`, `git push origin HEAD:main` (or force), `gh api`
 * (merge, forge a passing status, dismiss a review) or start other threads. Only branch protection
 * and code owners on the host stop that; docs/internals/bots.md, "What it does not stop", has more.
 */

// GitHub lists at most 3000 files, 30 to a page; a list that is longer than this is not given whole.
const MAX_DIFF_PAGES = 100;
const KNOWN_ARGUMENTS = new Set([
  "environmentId",
  "number",
  "expectedHeadSha",
  "method",
  "auto",
  "stack",
]);

const compiled = RepairService.PROTECTED_PATHS.map((pattern) => {
  let source = "";
  for (let at = 0; at < pattern.length;) {
    if (pattern.startsWith("**/", at)) {
      source += "(?:.*/)?";
      at += 3;
    } else if (pattern.startsWith("**", at)) {
      source += ".*";
      at += 2;
    } else if (pattern[at] === "*") {
      source += "[^/]*";
      at += 1;
    } else {
      source += pattern[at]!.replaceAll(/[\\^$.*+?()[\]{}|/]/gu, String.raw`\$&`);
      at += 1;
    }
  }
  return { pattern, matcher: new RegExp(`^${source}$`, "iu") };
});

/** The same path in the forms a checkout could read it by: slashes, `.` and `..` settled. */
const spellings = (path: string): ReadonlyArray<string> => {
  const slashed = path.replaceAll("\\", "/");
  const settled: Array<string> = [];
  for (const segment of slashed.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") settled.pop();
    else settled.push(segment);
  }
  return [slashed.replace(/^(?:\.?\/)+/u, ""), settled.join("/")];
};

/** The protected pattern a changed file falls under, or nothing. */
export const protectedPatternOf = (path: string): string | undefined => {
  for (const spelling of spellings(path)) {
    const hit = compiled.find(({ matcher }) => matcher.test(spelling));
    if (hit !== undefined) return hit.pattern;
  }
  return undefined;
};

export type MergeVerdict =
  /** Not a repair crew's call: the merge goes on as it always did. */
  | { readonly kind: "unguarded" }
  | { readonly kind: "allowed"; readonly crewThreadId: ThreadId; readonly number: number }
  | {
      readonly kind: "refused";
      readonly reason: RepairService.MergeRefusalReason;
      readonly message: string;
    };

interface Call {
  readonly number: number | null;
  /** What the call may be checked as; absent when it holds something the server cannot check. */
  readonly checkable: { readonly number: number; readonly expectedHeadSha: string } | undefined;
}

/**
 * The one shape of call a crew may make: its pull request's `number` and the `expectedHeadSha` it
 * checked, with nothing that could send the merge elsewhere. A raw call is read here, before the
 * tool decodes it, so anything it does not name outright is refused rather than interpreted.
 */
const callOf = (raw: unknown, environmentId: EnvironmentId): Call => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { number: null, checkable: undefined };
  }
  const args = raw as Readonly<Record<string, unknown>>;
  const number =
    typeof args.number === "number" && Number.isSafeInteger(args.number) && args.number > 0
      ? args.number
      : null;
  const head = typeof args.expectedHeadSha === "string" ? args.expectedHeadSha.trim() : "";
  const checkable =
    number !== null &&
    head.length > 0 &&
    Object.keys(args).every((key) => KNOWN_ARGUMENTS.has(key)) &&
    // Another machine's merge is checked there, as nobody's crew.
    (args.environmentId === undefined || args.environmentId === environmentId) &&
    (args.auto === undefined || args.auto === false) &&
    (args.stack === undefined || args.stack === false)
      ? { number, expectedHeadSha: head }
      : undefined;
  return { number, checkable };
};

type CheckClass = "success" | "skipped" | "pending" | "failed" | "unknown";
const classOfStatus = (status: string): CheckClass => {
  switch (status) {
    case "success":
      return "success";
    case "skipped":
    case "neutral":
      return "skipped";
    case "pending":
    case "action-required":
      return "pending";
    case "failure":
    case "cancelled":
      return "failed";
    default:
      return "unknown";
  }
};

/** Every check on the head commit has ended in success, and there is at least one that did. */
const checksReason = (detail: PullRequestDetail): RepairService.MergeRefusalReason | undefined => {
  const checks = detail.checks;
  // A placeholder stands for checks the host could not list, so what it hides is not known.
  if (checks.some((check) => check.placeholder === true)) return "checks_unreadable";
  const classes = checks.map((check) => ({
    class: classOfStatus(check.status),
    required: check.required === true,
  }));
  if (classes.some(({ class: kind }) => kind === "unknown")) return "checks_unreadable";
  if (classes.some(({ class: kind }) => kind === "failed")) return "checks_failed";
  if ((detail.workflowApprovalsRequired ?? 0) > 0) return "checks_pending";
  if (classes.some(({ class: kind }) => kind === "pending")) return "checks_pending";
  if (classes.some(({ class: kind, required }) => kind === "skipped" && required)) {
    return "required_check_skipped";
  }
  // No checks at all, or everything skipped, is nothing that ran and passed.
  if (!classes.some(({ class: kind }) => kind === "success")) return "no_checks";
  return undefined;
};

/**
 * Whether a repair crew's `pull_request_merge` may go ahead: its own pull request, into the default
 * branch, every check passed, no protected path changed, no review asking for changes.
 */
export class RepairMergeGuard extends Context.Service<
  RepairMergeGuard,
  {
    /**
     * Whether a `pull_request_merge` call from this thread may go ahead. A thread that is not a
     * repair crew, or a subagent of one, is left alone. A refused call is reported to the Bot, once.
     */
    readonly check: (input: {
      readonly threadId: ThreadId;
      readonly environmentId: EnvironmentId;
      /** The call's arguments exactly as the client sent them. */
      readonly arguments: unknown;
    }) => Effect.Effect<MergeVerdict>;
    /** Reports how an allowed call ended: merged, or refused by the host after all. */
    readonly settle: (input: {
      readonly crewThreadId: ThreadId;
      readonly number: number;
      readonly merged: boolean;
    }) => Effect.Effect<void>;
  }
>()("t3/bots/RepairMergeGuard") {}

const make = Effect.gen(function* () {
  const repair = yield* RepairService.RepairService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const sourceControl = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;

  /** Every path the pull request changes, renames on both sides; nothing when the list is not whole. */
  const changedPaths = Effect.fn("RepairMergeGuard.changedPaths")(function* (
    ref: PullRequestRef,
    changedFiles: number,
  ) {
    const paths: Array<string> = [];
    let entries = 0;
    let cursor: string | undefined;
    for (let page = 0; page < MAX_DIFF_PAGES; page += 1) {
      const slice = yield* pullRequests
        .diff({ ...ref, ...(cursor === undefined ? {} : { cursor }) })
        .pipe(Effect.option);
      if (Option.isNone(slice)) return undefined;
      for (const file of parseDiffFilePaths(slice.value.patch)) {
        entries += 1;
        if (file.oldPath !== null) paths.push(file.oldPath);
        if (file.newPath !== null) paths.push(file.newPath);
      }
      for (const withheld of slice.value.omittedFileStats ?? []) paths.push(withheld.path);
      if (slice.value.nextCursor === null) {
        // A host that lists fewer or more files than the change has, or that skipped an entry it
        // could not read, has not given the list: the count is the proof it is whole.
        return entries === changedFiles ? paths : undefined;
      }
      cursor = slice.value.nextCursor;
    }
    return undefined;
  });

  /** A review that still asks for changes: the latest verdict of each reviewer is the one that counts. */
  const reviewsReason = Effect.fn("RepairMergeGuard.reviewsReason")(function* (
    ref: PullRequestRef,
  ) {
    const fresh = { ...ref, allowStale: false };
    const summary = yield* pullRequests.summary(fresh).pipe(Effect.option);
    const activity = yield* pullRequests.activity(fresh).pipe(Effect.option);
    if (Option.isNone(summary) || Option.isNone(activity)) return "reviews_unreadable" as const;
    if (summary.value.reviewDecision === "changes-requested") return "changes_requested" as const;
    const latest = new Map<string, { readonly at: number; readonly state: string }>();
    for (const comment of activity.value.comments) {
      const state = comment.reviewState?.toUpperCase();
      if (
        comment.kind !== "review" ||
        (state !== "APPROVED" && state !== "CHANGES_REQUESTED" && state !== "DISMISSED")
      ) {
        continue;
      }
      const at = Date.parse(comment.createdAt);
      const author = comment.author?.login ?? "";
      const held = latest.get(author);
      if (held === undefined || at >= held.at) latest.set(author, { at, state });
    }
    if ([...latest.values()].some(({ state }) => state === "CHANGES_REQUESTED")) {
      return "changes_requested" as const;
    }
    // Reviews past what the host gave could include one that asks for changes.
    return activity.value.commentsTruncated ? ("reviews_unreadable" as const) : undefined;
  });

  /** The first thing wrong with merging this pull request, or nothing. */
  const reasonToRefuse = Effect.fn("RepairMergeGuard.reasonToRefuse")(function* (
    threadId: ThreadId,
    branch: string,
    call: { readonly number: number; readonly expectedHeadSha: string },
  ) {
    const shell = yield* threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
    if (shell === null) return "pull_request_unreadable" as const;
    // The same project, repository and number the merge tool will resolve for this call.
    const project = yield* pullRequests
      .addressedProject(shell.projectId)
      .pipe(Effect.orElseSucceed(() => undefined));
    if (project === undefined) return "pull_request_unreadable" as const;
    const identity = project.repositoryIdentity;
    const target = yield* resolveTarget(
      {
        number: call.number,
        repository:
          identity == null
            ? undefined
            : (sourceControlDefinitions.repositorySelector(identity) ?? undefined),
      },
      project,
    ).pipe(Effect.option);
    if (Option.isNone(target)) return "pull_request_unreadable" as const;
    const ref: PullRequestRef = {
      projectId: project.id,
      host: target.value.host,
      repository: target.value.repository,
      number: target.value.number,
    };

    // The host is asked again, not a held answer: head, checks, files and reviews are all read
    // after this, and a push or a check a minute ago must not decide.
    yield* pullRequests.invalidate({ reference: ref });
    const read = yield* pullRequests.detail({ ...ref, allowStale: false }).pipe(Effect.option);
    if (Option.isNone(read)) return "pull_request_unreadable" as const;
    const detail = read.value;

    if (detail.state !== "open" || detail.isDraft) return "not_open" as const;
    if (detail.headBranch !== branch) return "wrong_branch" as const;
    const headRepository = detail.headRepositoryNameWithOwner;
    if (
      headRepository == null ||
      headRepository.toLowerCase() !== detail.repository.toLowerCase()
    ) {
      return "fork_pull_request" as const;
    }
    const defaultBranch = yield* sourceControl.resolve({ cwd: project.workspaceRoot }).pipe(
      Effect.flatMap((provider) => provider.getDefaultBranch({ cwd: project.workspaceRoot })),
      Effect.orElseSucceed(() => null),
    );
    if (defaultBranch === null || defaultBranch.trim().length === 0) {
      return "target_unreadable" as const;
    }
    if (detail.baseBranch !== defaultBranch) return "wrong_target" as const;
    if (detail.headSha === undefined) return "pull_request_unreadable" as const;
    // The host pins the merge to this head, so what is checked below is what is merged.
    if (detail.headSha.toLowerCase() !== call.expectedHeadSha.toLowerCase()) {
      return "head_moved" as const;
    }

    const checks = checksReason(detail);
    if (checks !== undefined) return checks;

    const paths = yield* changedPaths(ref, detail.changedFiles);
    if (paths === undefined) return "files_unreadable" as const;
    if (paths.some((path) => protectedPatternOf(path) !== undefined)) {
      return "protected_path" as const;
    }
    return yield* reviewsReason(ref);
  });

  const check: RepairMergeGuard["Service"]["check"] = Effect.fn("RepairMergeGuard.check")(
    function* ({ threadId, environmentId, arguments: raw }) {
      const crew = yield* repair.crewOf(threadId);
      if (crew === undefined) return { kind: "unguarded" } as const;
      const call = callOf(raw, environmentId);
      const refuse = (reason: RepairService.MergeRefusalReason) =>
        repair
          .reportMerge({
            crewThreadId: crew.crewThreadId,
            number: call.number,
            merged: false,
            reason,
          })
          .pipe(
            Effect.as({
              kind: "refused",
              reason,
              message: RepairService.MERGE_REFUSAL_MESSAGES[reason],
            } as const),
          );
      if (call.checkable === undefined) return yield* refuse("bad_arguments");
      // Anything that goes wrong in the checking is a refusal, never a merge.
      const reason = yield* reasonToRefuse(threadId, crew.branch, call.checkable).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("A repair crew's merge could not be checked.", { cause }).pipe(
              Effect.as("pull_request_unreadable" as const),
            ),
        ),
      );
      return reason === undefined
        ? ({
            kind: "allowed",
            crewThreadId: crew.crewThreadId,
            number: call.checkable.number,
          } as const)
        : yield* refuse(reason);
    },
  );

  const settle: RepairMergeGuard["Service"]["settle"] = ({ crewThreadId, number, merged }) =>
    repair.reportMerge({
      crewThreadId,
      number,
      merged,
      reason: merged ? "merged" : "merge_failed",
    });

  return RepairMergeGuard.of({ check, settle });
});

export const layer = Layer.effect(RepairMergeGuard, make);
