import type {
  BranchNamingOptions,
  ChatAttachment,
  ModelSelection,
  ProjectId,
  PullRequestReviewGuide,
  TextGenerationError,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

import type { TextGenerationPolicy } from "./textGenerationPolicy.ts";
import type { ChangeProducer, ThreadTitleForkSource } from "./textGenerationPrompts.ts";

export interface CommitMessageGenerationInput {
  cwd: string;
  branch: string | null;
  stagedSummary: string;
  stagedPatch: string;
  includeBranch?: boolean;
  policy?: TextGenerationPolicy | undefined;
  modelSelection: ModelSelection;
  projectId?: ProjectId | null | undefined;
}

export interface CommitMessageGenerationResult {
  subject: string;
  body: string;
  branch?: string | undefined;
}

export interface PrContentGenerationInput {
  cwd: string;
  baseBranch: string;
  headBranch: string;
  commitSummary: string;
  diffSummary: string;
  diffPatch: string;
  changeRequestTemplate?: string | undefined;
  threadContext?: string | undefined;
  producedBy?: ReadonlyArray<ChangeProducer> | undefined;
  policy?: TextGenerationPolicy | undefined;
  modelSelection: ModelSelection;
  projectId?: ProjectId | null | undefined;
}

export interface PrContentGenerationResult {
  title: string;
  body: string;
}

export interface BranchNameGenerationInput {
  naming?: BranchNamingOptions | undefined;
  cwd: string;
  message: string;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  modelSelection: ModelSelection;
  projectId?: ProjectId | null | undefined;
}

export interface BranchNameGenerationResult {
  branch: string;
}

export interface ThreadTitleGenerationInput {
  linkedContext?: string | undefined;
  cwd: string;
  message: string;
  projectTitle?: string | undefined;
  previousTitle?: string | undefined;
  forkSource?: ThreadTitleForkSource | undefined;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  instructions?: string | undefined;
  modelSelection: ModelSelection;
  projectId?: ProjectId | null | undefined;
}

export interface ThreadTitleGenerationResult {
  title: string;
  needsRefinement?: boolean | undefined;
}

export interface ReviewGuideStackLayer {
  readonly number: number;
  readonly title: string | null;
  readonly headSha: string | null;
  readonly state: "open" | "closed" | "merged";
}

export interface ReviewGuideGenerationInput {
  /** A scratch checkout of the pull request's head. */
  cwd: string;
  /** The project folder the checkout was made from; the user's own relative paths resolve here. */
  projectCwd: string;
  number: number;
  title: string;
  description: string;
  baseBranch: string;
  baseCommit: string;
  settledReview: string;
  instructions?: string | undefined;
  stack?: ReadonlyArray<ReviewGuideStackLayer> | undefined;
  modelSelection: ModelSelection;
  projectId?: ProjectId | null | undefined;
}

export type ReviewGuideGenerationResult = Omit<
  PullRequestReviewGuide,
  "headSha" | "generatedAt" | "modelSelection"
>;

export interface TranscriptionPostProcessingInput {
  cwd: string;
  prompt: string;
  modelSelection: ModelSelection;
}

export interface TranscriptionPostProcessingResult {
  transcription: string;
}

export interface WatcherReviewInput {
  cwd: string;
  name: string;
  purpose: string;
  runtime: "node" | "sh";
  mode: "health" | "events";
  intervalSeconds: number;
  /** The regular expression the script's healthy output must match, when it has one. */
  expect?: string | undefined;
  /** Names of the granted secrets the script receives, and the hosts they may go to; never values. */
  secrets?: ReadonlyArray<string> | undefined;
  hosts?: ReadonlyArray<string> | undefined;
  source: string;
  previousSource?: string | undefined;
  /** Names the review's data markers; random per call, so a script cannot quote them. */
  tag: string;
  modelSelection: ModelSelection;
  projectId?: ProjectId | null | undefined;
}

export interface WatcherReviewResult {
  verdict: "approve" | "reject";
  reason: string;
}

export interface ProviderTextGeneration {
  readonly generateTranscriptionPostProcessing: (
    input: TranscriptionPostProcessingInput,
  ) => Effect.Effect<TranscriptionPostProcessingResult, TextGenerationError>;

  readonly reviewWatcher: (
    input: WatcherReviewInput,
  ) => Effect.Effect<WatcherReviewResult, TextGenerationError>;

  readonly generateCommitMessage: (
    input: CommitMessageGenerationInput,
  ) => Effect.Effect<CommitMessageGenerationResult, TextGenerationError>;

  readonly generatePrContent: (
    input: PrContentGenerationInput,
  ) => Effect.Effect<PrContentGenerationResult, TextGenerationError>;

  readonly generateBranchName: (
    input: BranchNameGenerationInput,
  ) => Effect.Effect<BranchNameGenerationResult, TextGenerationError>;

  readonly generateThreadTitle: (
    input: ThreadTitleGenerationInput,
  ) => Effect.Effect<ThreadTitleGenerationResult, TextGenerationError>;

  readonly generateReviewGuide: (
    input: ReviewGuideGenerationInput,
  ) => Effect.Effect<ReviewGuideGenerationResult, TextGenerationError>;
}
