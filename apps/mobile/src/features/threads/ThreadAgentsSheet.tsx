import { useAtomValue } from "@effect/atom-react";
import {
  deriveWorkflowGroups,
  projectedSubagentsToRuntime,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type {
  ThreadSubagentRunGroup,
  ThreadTurnSubagents,
} from "@t3tools/client-runtime/state/thread-subagents";
import {
  isOrchestrationV2WorkActive,
  type EnvironmentId,
  type OrchestrationV2Subagent,
  type ThreadId,
} from "@t3tools/contracts";
import { deriveSubagentElapsedMs, formatDuration } from "@t3tools/shared/orchestrationTiming";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import * as DateTime from "effect/DateTime";
import { Atom } from "effect/reactivity";
import * as Haptics from "expo-haptics";
import { useMemo } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { ScreenStack } from "react-native-screens";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidSheetHeader } from "../../components/ui/AndroidScreenHeader";
import { AppText as Text } from "../../components/ui/AppText";
import { environmentThreadDetails } from "../../state/threads";
import { NativeStackScreenOptions, nativeHeaderScrollEdgeEffects } from "../../native/StackHeader";
import { NativeHeader, NativeScreen } from "../../native/ThemedScreenStack";
import { useEnvironments } from "../../state/environments";
import { SubagentRow } from "./SubagentRow";
import { subagentRunGroupLabel } from "./thread-agents-presentation";
import { useVisibleSecondClock } from "./use-visible-second-clock";
import { SubagentStopButton } from "./SubagentStopButton";
import { ThreadWorkflowGroup } from "./ThreadWorkflowGroup";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { subagentThreadTarget } from "./threadAgentsPresentation";

import { useOpenThreadInspector } from "./thread-inspector-navigation";

const HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);

type AgentsTarget = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };

const EMPTY_TURN_SUBAGENTS_ATOM = Atom.make<ThreadTurnSubagents | null>(null).pipe(
  Atom.withLabel("mobile-thread-turn-subagents:empty"),
);

export function useThreadTurnSubagents(target: AgentsTarget | null): ThreadTurnSubagents | null {
  return useAtomValue(
    target === null
      ? EMPTY_TURN_SUBAGENTS_ATOM
      : environmentThreadDetails.turnSubagentsAtom(target),
  );
}

const EMPTY_RUN_GROUPS_ATOM = Atom.make<ReadonlyArray<ThreadSubagentRunGroup>>([]).pipe(
  Atom.withLabel("mobile-thread-subagent-runs:empty"),
);

export function useThreadSubagentRunGroups(
  target: AgentsTarget | null,
): ReadonlyArray<ThreadSubagentRunGroup> {
  return useAtomValue(
    target === null
      ? EMPTY_RUN_GROUPS_ATOM
      : environmentThreadDetails.subagentRunGroupsAtom(target),
  );
}

export function ThreadAgentsSheet({ route }: StaticScreenProps<AgentsTarget>) {
  const { layout } = useAdaptiveWorkspaceLayout();
  const target = route.params;
  const navigation = useNavigation();
  const openInspector = useOpenThreadInspector();
  const insets = useSafeAreaInsets();
  const runGroups = useThreadSubagentRunGroups(target);
  const hasLiveAgent = runGroups.some((group) => group.liveCount > 0);
  const workflowGroups = useMemo(
    () =>
      new Map(
        deriveWorkflowGroups(
          projectedSubagentsToRuntime(runGroups.flatMap((group) => group.subagents)),
        ).map((group) => [group.workflow.id, group]),
      ),
    [runGroups],
  );

  const openChildThread = (child: { environmentId: EnvironmentId; threadId: ThreadId }) => {
    void Haptics.selectionAsync();
    if (
      openInspector(target, {
        type: "thread",
        environmentId: child.environmentId,
        threadId: child.threadId,
      })
    )
      return;
    // Replace this leaf sheet so the child enters the workspace stack expected by Home's Back button.
    navigation.dispatch(
      StackActions.replace("Thread", {
        environmentId: child.environmentId,
        threadId: child.threadId,
      }),
    );
  };

  const content = (
    <ScrollView
      nestedScrollEnabled
      className="flex-1"
      // UIKit must inset content beneath the floating translucent iOS header.
      contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
      contentContainerClassName="px-5 pb-6"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
    >
      {runGroups.length === 0 ? (
        <Text className="pt-6 text-center text-sm text-foreground-muted">No agents yet.</Text>
      ) : (
        runGroups.map((group) => (
          <View key={group.runId ?? "no-run"}>
            <Text
              accessibilityRole="header"
              className="pb-1 pt-4 text-sm font-t3-medium text-foreground-muted"
            >
              {subagentRunGroupLabel(group)}
            </Text>
            {group.subagents.map((subagent) => {
              const workflowGroup = workflowGroups.get(subagent.id);
              return workflowGroup === undefined ? (
                <View key={subagent.id} className="border-b border-border">
                  <AgentRow
                    subagent={subagent}
                    environmentId={target.environmentId}
                    tickSeconds={hasLiveAgent}
                    onOpen={openChildThread}
                  />
                </View>
              ) : (
                <ThreadWorkflowGroup
                  key={subagent.id}
                  environmentId={target.environmentId}
                  subagent={subagent}
                  group={workflowGroup}
                  onOpen={(threadId) =>
                    openChildThread({ environmentId: target.environmentId, threadId })
                  }
                />
              );
            })}
          </View>
        ))
      )}
    </ScrollView>
  );

  if (Platform.OS === "ios") {
    // Plain formSheets lack stack headers; host one in a nested native stack.
    return (
      <View collapsable={false} className="flex-1 bg-sheet">
        <ScreenStack style={{ flex: 1 }}>
          <NativeScreen
            activityState={2}
            enabled
            isNativeStack
            screenId="thread-agents-sheet-native"
            scrollEdgeEffects={HEADER_SCROLL_EDGE_EFFECTS}
            className="flex-1 bg-sheet"
          >
            {content}
            <NativeHeader
              backgroundColor="rgba(0,0,0,0)"
              tintColorClassName="accent-foreground"
              hideBackButton
              hideShadow={false}
              title="Agents"
              titleColorClassName="accent-foreground"
              titleFontSize={18}
              titleFontWeight="800"
              translucent
            />
          </NativeScreen>
        </ScreenStack>
      </View>
    );
  }

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <NativeStackScreenOptions options={{ sheetCornerRadius: 28 }} />
      <AndroidSheetHeader title="Agents" onBack={() => navigation.goBack()} />
      <ScreenContent insetHorizontal={layout.usesSplitView}>{content}</ScreenContent>
    </View>
  );
}

function AgentRow(props: {
  readonly environmentId: EnvironmentId;
  readonly subagent: OrchestrationV2Subagent;
  readonly tickSeconds: boolean;
  readonly onOpen: (child: { environmentId: EnvironmentId; threadId: ThreadId }) => void;
}) {
  const { subagent } = props;
  const { presentationById } = useEnvironments();
  const target = subagentThreadTarget(subagent, props.environmentId, (id) =>
    presentationById.has(id),
  );

  const row = (
    <View className="py-3.5">
      <SubagentRow
        environmentId={props.environmentId}
        subagent={subagent}
        canOpenRemote={target !== null}
        elapsed={<AgentElapsed subagent={subagent} tickSeconds={props.tickSeconds} />}
      />
    </View>
  );

  const content =
    target === null ? (
      <View
        accessible
        className="min-w-0 flex-1"
        accessibilityHint={
          subagent.remoteChild === undefined
            ? "Provider-managed agent. Its work appears in the transcript."
            : `Runs on ${subagent.remoteChild.label}. Connect to it to open its thread.`
        }
      >
        {row}
      </View>
    ) : (
      <Pressable
        accessibilityRole="link"
        accessibilityHint="Opens this agent's thread"
        onPress={() => props.onOpen(target)}
        className="min-w-0 flex-1 active:opacity-70"
      >
        {row}
      </Pressable>
    );

  return (
    <View className="flex-row items-center">
      {content}
      <SubagentStopButton environmentId={props.environmentId} subagent={subagent} />
    </View>
  );
}

function AgentElapsed(props: {
  readonly subagent: OrchestrationV2Subagent;
  readonly tickSeconds: boolean;
}) {
  const elapsed = useSubagentElapsed(props.subagent, props.tickSeconds);
  return elapsed === null ? null : (
    <Text className="shrink-0 text-xs tabular-nums text-foreground-muted">{elapsed}</Text>
  );
}

function useSubagentElapsed(
  subagent: Pick<OrchestrationV2Subagent, "status" | "startedAt" | "completedAt">,
  tickSeconds: boolean,
): string | null {
  const running = isOrchestrationV2WorkActive(subagent.status);
  const nowMs = useVisibleSecondClock(tickSeconds && running);
  const elapsedMs = deriveSubagentElapsedMs(
    {
      status: subagent.status,
      startedAt: subagent.startedAt === null ? null : DateTime.formatIso(subagent.startedAt),
      completedAt: subagent.completedAt === null ? null : DateTime.formatIso(subagent.completedAt),
    },
    nowMs,
  );
  return elapsedMs === null || elapsedMs === 0 ? null : formatDuration(elapsedMs);
}
