import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2CreationSource,
  type OrchestrationV2ServerCommand,
  ProjectId,
  ProviderInstanceId,
  RunId,
  type ThreadBotConfig,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as BotService from "./BotService.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import type * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as HomeService from "../home/HomeService.ts";

export const model: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-haiku-5-5",
};

export interface SentMessage {
  readonly threadId: ThreadId;
  readonly commandId: string;
  readonly text: string;
}

/** The thread fields Bots and Home read; tests change them in place. */
export interface FakeThread {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  modelSelection: ModelSelection;
  readonly runtimeMode: "full-access";
  readonly interactionMode: "default";
  readonly lineage: {
    readonly parentThreadId: ThreadId | null;
    readonly relationshipToParent?: "fork" | "subagent" | null;
    readonly rootThreadId?: ThreadId;
  };
  botConfig: ThreadBotConfig | null;
  groupedUnderThreadId: ThreadId | null;
  createdBy?: "user" | "agent" | "system";
  creationSource?: OrchestrationV2CreationSource;
  activeRunId: RunId | null;
  settledOverride: "settled" | null;
  archivedAt: string | null;
  deletedAt: null;
}

export interface LaunchedThread {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly text: string | undefined;
  /** Everything the launch was asked for. */
  readonly input: ThreadLaunchService.ThreadLaunchInput;
}

/** The orchestration Bots and Home drive, recording what they were asked to do. */
export const makeOrchestration = () => {
  const threads = new Map<ThreadId, FakeThread>();
  const dispatched: Array<OrchestrationV2ServerCommand & { readonly threadId?: ThreadId }> = [];
  const sent: Array<SentMessage> = [];
  const launched: Array<LaunchedThread> = [];
  const runs = new Map<
    RunId,
    {
      readonly id: RunId;
      readonly userMessageId: string;
      readonly threadId?: ThreadId;
      readonly ordinal?: number;
    }
  >();
  const messages = new Map<
    string,
    {
      readonly createdBy: "user" | "agent" | "system";
      readonly scheduledTaskId?: string;
      readonly senderThreadId?: ThreadId;
    }
  >();
  /** Projects a launch can name, by id: their folders and the branch each is on. */
  const projects = new Map<ProjectId, { readonly title: string; readonly workspaceRoot: string }>();
  /** The checkout's own branch, and the branch its remote names as the default (none, or unreadable). */
  const git: { branch: string | null; defaultBranch: string | null } = {
    branch: "main",
    defaultBranch: "main",
  };

  /** Runs before each message is sent, so a test can hold a send where a server could stop. */
  const hooks: {
    beforeSend: (message: SentMessage) => Effect.Effect<void>;
    /** Runs before each launch records itself, so a test can make one fail. */
    beforeLaunch: (
      input: ThreadLaunchService.ThreadLaunchInput,
    ) => Effect.Effect<void, ThreadLaunchService.ThreadLaunchError>;
    /** Runs once the launch's thread exists, so a test can make a launch fail after it was made. */
    afterLaunch: (
      input: ThreadLaunchService.ThreadLaunchInput,
    ) => Effect.Effect<void, ThreadLaunchService.ThreadLaunchError>;
    /** Runs before each thread lookup, so a test can make one fail. */
    beforeLookup: (threadId: ThreadId) => Effect.Effect<void, Orchestrator.OrchestratorV2Error>;
  } = {
    beforeSend: () => Effect.void,
    beforeLaunch: () => Effect.void,
    afterLaunch: () => Effect.void,
    beforeLookup: () => Effect.void,
  };

  /** Makes `message` the one that began the thread's active run. */
  const startRun = (
    thread: FakeThread,
    message: {
      readonly id: string;
      readonly createdBy: "user" | "agent" | "system";
      readonly scheduledTaskId?: string;
      readonly senderThreadId?: ThreadId;
    },
  ) => {
    const id = RunId.make(`run:${runs.size + 1}`);
    const ordinal = [...runs.values()].filter((run) => run.threadId === thread.id).length + 1;
    runs.set(id, { id, userMessageId: message.id, threadId: thread.id, ordinal });
    messages.set(message.id, message);
    thread.activeRunId = id;
  };

  const addThread = (id: string, fields: Partial<Omit<FakeThread, "id">> = {}): FakeThread => {
    const thread: FakeThread = {
      id: ThreadId.make(id),
      projectId: ProjectId.make("project:a"),
      title: id,
      modelSelection: model,
      runtimeMode: "full-access",
      interactionMode: "default",
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: ThreadId.make(id),
      },
      botConfig: null,
      groupedUnderThreadId: null,
      activeRunId: null,
      settledOverride: null,
      archivedAt: null,
      deletedAt: null,
      ...fields,
    };
    threads.set(thread.id, thread);
    return thread;
  };
  const asAppThread = (thread: FakeThread | undefined) =>
    (thread ?? null) as OrchestrationV2AppThread | null;

  const layer = Layer.mergeAll(
    Layer.mock(ThreadLaunchService.ThreadLaunchService)({
      launch: (input) =>
        hooks.beforeLaunch(input).pipe(
          Effect.andThen(
            Effect.sync(() => {
              const threadId = input.threadId!;
              const thread = addThread(threadId, {
                projectId: input.projectId,
                title: input.title,
                botConfig: input.botConfig ?? null,
                groupedUnderThreadId: input.groupedUnderThreadId ?? null,
                createdBy: input.createdBy,
                creationSource: input.creationSource,
              });
              // The launch's own prompt is the thread's first message, as the server records it.
              if (input.initialMessage !== undefined) {
                const senderThreadId = input.initialMessage.senderThreadId;
                startRun(thread, {
                  id: `message:first:${threadId}`,
                  createdBy: input.createdBy,
                  ...(senderThreadId === undefined ? {} : { senderThreadId }),
                });
                thread.activeRunId = null;
              }
              launched.push({
                threadId,
                projectId: input.projectId,
                text: input.initialMessage?.text,
                input,
              });
              return { threadId } as ThreadLaunchService.ThreadLaunchResult;
            }),
          ),
          Effect.tap(() => hooks.afterLaunch(input)),
        ),
      checkWorktreeBase: () => Effect.void,
    }),
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadShell: (threadId) =>
        hooks
          .beforeLookup(threadId)
          .pipe(Effect.andThen(Effect.succeed((threads.get(threadId) ?? null) as never))),
      getThreadRecords: (threadId, _fields, filter) =>
        Effect.succeed({
          runs: [...runs.values()]
            .filter((run) =>
              filter?.runIds === undefined
                ? run.threadId === threadId
                : filter.runIds.includes(run.id),
            )
            .slice(0, filter?.earliestRunOnly === true ? 1 : undefined),
          subagents: [],
        } as never),
      getMessagesById: (_threadId, ids) =>
        Effect.succeed(
          new Map(ids.flatMap((id) => (messages.has(id) ? [[id, messages.get(id)]] : []))) as never,
        ),
      getThreadProjection: (threadId) => {
        const thread = threads.get(threadId);
        return thread === undefined
          ? Effect.die(`no thread ${threadId}`)
          : Effect.succeed({ thread, runs: [], attempts: [] } as never);
      },
      dispatch: (command) =>
        Effect.sync(() => {
          dispatched.push(command as never);
          if (command.type === "thread.model-selection.set" || command.type === "provider.switch") {
            threads.get(command.threadId)!.modelSelection = command.modelSelection;
          }
          if (command.type === "thread.metadata.update" && command.groupedUnderThreadId) {
            threads.get(command.threadId)!.groupedUnderThreadId = command.groupedUnderThreadId;
          }
          return { sequence: dispatched.length, storedEvents: [] };
        }),
      sendToThread: (input) => {
        const message = { threadId: input.threadId, commandId: input.commandId, text: input.text };
        return hooks.beforeSend(message).pipe(
          Effect.andThen(
            Effect.sync(() => {
              sent.push(message);
              return {} as ThreadManagementService.ThreadManagementSendResult;
            }),
          ),
        );
      },
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      findThread: (threadId) => Effect.succeed(asAppThread(threads.get(threadId))),
      listGroupedCrewIds: (threadId) =>
        Effect.succeed(
          [...threads.values()]
            .filter((thread) => thread.groupedUnderThreadId === threadId)
            .map((thread) => thread.id),
        ),
      getThreadRecords: () => Effect.succeed({ turnItems: [] } as never),
    }),
    Layer.mock(ProjectService.ProjectService)({
      bootstrap: (input) =>
        Effect.succeed({ project: { id: input.projectId }, created: true } as never),
      getById: (projectId) =>
        Effect.succeed(
          Option.fromNullishOr(
            projects.has(projectId) ? { id: projectId, ...projects.get(projectId)! } : undefined,
          ) as never,
        ),
    }),
    Layer.mock(GitWorkflow.GitWorkflowService)({
      currentBranch: () => Effect.succeed(git.branch),
      resolvePrimaryRemoteName: () => Effect.succeed("origin"),
      resolveDefaultBranchName: () => Effect.succeed(git.defaultBranch),
    }),
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(EnvironmentId.make("env:here")),
    }),
  );
  return { threads, dispatched, sent, launched, hooks, projects, git, addThread, startRun, layer };
};

/** Home and the Bot service over one fake orchestration and a fresh base directory. */
export const provideBots = (orchestration: ReturnType<typeof makeOrchestration>) =>
  Effect.provide(
    HomeService.layer.pipe(
      Layer.provideMerge(BotService.layer),
      Layer.provideMerge(orchestration.layer),
      Layer.provideMerge(ServerSettings.ServerSettingsService.layerTest()),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-bots-test-" })),
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    ),
  );
