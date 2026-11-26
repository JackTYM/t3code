import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  type HomeSettings,
  type ModelSelection,
  ProjectId,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react";
import { useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { useEnvironmentProviders } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { homeFailure, type HomeFailure } from "../home/homeErrors";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { scheduledTaskDefaultModel } from "./scheduledTasksSettings.logic";
import { useSettingsScope } from "./SettingsScopeContext";
import { useSearchableSetting } from "./settingsSearch";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";

const NO_REPAIR_PROJECT = "none";

export function HomeSettingsPanel() {
  const { environment, connectedEnvironments } = useSettingsScope();
  const environmentId = (environment ?? connectedEnvironments[0])?.environmentId ?? null;
  return environmentId === null ? null : <EnvironmentHomeSettings environmentId={environmentId} />;
}

function EnvironmentHomeSettings({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const home = useAtomValue(
    serverEnvironment.settingsValueAtom(environmentId),
    (settings) => settings?.home ?? null,
  );
  return home === null ? null : <HomeSettingsContent environmentId={environmentId} home={home} />;
}

function HomeSettingsContent({
  environmentId,
  home,
}: {
  readonly environmentId: EnvironmentId;
  readonly home: HomeSettings;
}) {
  const gt = useGT();
  const m = useMessages();
  const setting = useSearchableSetting();
  const settings = useEnvironmentSettings(environmentId);
  const providers = useEnvironmentProviders().get(environmentId) ?? EMPTY_SERVER_PROVIDERS;
  const canOperate = useAtomValue(serverEnvironment.enableHome.permissionAtom(environmentId));
  const enable = useAtomCommand(serverEnvironment.enableHome, { label: "home enable" });
  const disable = useAtomCommand(serverEnvironment.disableHome, { label: "home disable" });
  const reset = useAtomCommand(serverEnvironment.resetHome, { label: "home reset" });
  const setModel = useAtomCommand(serverEnvironment.setHomeModel, { label: "home set model" });
  const setRepairProject = useAtomCommand(serverEnvironment.setHomeRepairProject, {
    label: "home set repair project",
  });
  // The chosen project stays listed after it is archived, so the row never shows a blank.
  const repairProjects = useProjects().filter(
    (project) =>
      project.environmentId === environmentId &&
      (project.archivedAt == null || project.id === home.repairProjectId),
  );
  const repairProject = repairProjects.find((project) => project.id === home.repairProjectId);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<HomeFailure | null>(null);
  // Picked while Home is off, it is sent along when Home is turned on.
  const [picked, setPicked] = useState<ModelSelection | null>(null);

  const instanceEntries = providerInstanceEntriesFor(providers, settings, null);
  const selection =
    picked ??
    home.modelSelection ??
    scheduledTaskDefaultModel(settings, null, instanceEntries) ??
    null;
  const shownInstanceId =
    selection?.instanceId ?? instanceEntries[0]?.instanceId ?? ("" as ProviderInstanceId);
  const shownModel = selection?.model ?? "";
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    providers,
    shownInstanceId,
    shownModel,
  );
  const target = { environmentId, input: {} };

  const run = async (action: () => ReturnType<typeof enable | typeof disable>) => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    const result = await action();
    setBusy(false);
    setFailure(homeFailure(result, m));
  };
  const toggle = (on: boolean) =>
    run(() =>
      on
        ? enable({ environmentId, input: selection === null ? {} : { modelSelection: selection } })
        : disable(target),
    );
  const pickModel = (instanceId: ProviderInstanceId, model: string) => {
    const next = { instanceId, model };
    setPicked(next);
    if (home.enabled) void run(() => setModel({ environmentId, input: { modelSelection: next } }));
  };
  const pickRepairProject = (value: string | null) =>
    void run(() =>
      setRepairProject({
        environmentId,
        input: {
          projectId: value === null || value === NO_REPAIR_PROJECT ? null : ProjectId.make(value),
        },
      }),
    );
  const startFresh = async () => {
    const confirmed = await (requestConfirmDialog(
      gt(
        "Start Home fresh? It begins a new conversation. Its notes, preferences and crew carry over, and the old thread is kept.",
      ),
    ) ?? Promise.resolve(false));
    if (confirmed) await run(() => reset(target));
  };

  return (
    <SettingsPageContainer>
      <SettingsSection {...setting("home")}>
        <SettingsRow
          title={gt("Enable Home")}
          description={gt(
            "One agent on this environment that works across your projects and linked environments.",
          )}
          status={
            failure === null ? null : (
              <span className="text-destructive" role="alert">
                {failure.message}
              </span>
            )
          }
          control={
            <Switch
              checked={home.enabled}
              disabled={!canOperate || busy}
              onCheckedChange={(checked) => void toggle(Boolean(checked))}
              aria-label={gt("Enable Home")}
            />
          }
        />
        <SettingsRow
          title={gt("Model")}
          description={gt("The model Home runs on.")}
          control={
            <ProviderModelPicker
              environmentId={environmentId}
              disabled={!canOperate || busy}
              activeInstanceId={shownInstanceId}
              model={shownModel}
              lockedProvider={null}
              instanceEntries={instanceEntries}
              modelOptionsByInstance={modelOptionsByInstance}
              isComposerOwned={false}
              triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
              onInstanceModelChange={pickModel}
            />
          }
        />
        <SettingsRow
          title={gt("Repair project")}
          description={gt(
            "Where a repair crew works when something in how a Bot runs keeps failing: a checkout of T3 Code itself. The crew fixes it on a new branch and opens a pull request; changes to the parts that guard the Bot are left for you to merge. None turns repairs off.",
          )}
          control={
            <div className="w-full sm:w-56">
              <Select
                value={home.repairProjectId ?? NO_REPAIR_PROJECT}
                disabled={!canOperate || busy}
                onValueChange={pickRepairProject}
              >
                <SelectTrigger
                  size="sm"
                  className="w-full min-w-0"
                  aria-label={gt("Repair project")}
                >
                  <SelectValue>{repairProject?.title ?? gt("None")}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value={NO_REPAIR_PROJECT}>{gt("None")}</SelectItem>
                  {repairProjects.map((project) => (
                    <SelectItem key={project.id} value={project.id} label={project.title}>
                      <span className="block truncate">{project.title}</span>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          }
        />
        <SettingsRow
          title={gt("Start fresh")}
          description={gt("Begin a new Home conversation. Notes, preferences and crew carry over.")}
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={!canOperate || busy || !home.enabled}
              onClick={() => void startFresh()}
            >
              <T>Start fresh</T>
            </Button>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
