import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { ModHistoryPage } from "./ModHistoryPage";
import { useDemoModHistory } from "./useDemoModHistory";
import { toast } from "sonner";
import type { RequestConfirmation } from "../../components/ConfirmationModal";
import type { ServerRuntimeType } from "@serversentinel/contracts";
import type { ActivePage, GeneralJob, InstalledMod, ManagedServer, ModUpdatePlan, Notify, ServerStatus } from "../../types";
import { errorMessage } from "../../utils/appHelpers";
import { ModsPage } from "../../pages/ModsPage";
import { modUpdateRefreshResultMessage } from "../../pages/OverviewPage";
import type { ManagedContentTerminology } from "./contentTerminology";
import { resolveModGuards } from "./modAccess";
import { useModsWorkspace } from "./useModsWorkspace";

/**
 * The managed-content module's browser surface: the mods workspace and its page, behind one dynamic
 * import. Nothing in the shell references either, so a visitor who cannot reach managed content —
 * because the module is off, or because their account lacks `mods.view` — never downloads it.
 *
 * Unlike the schedules module, this one is mounted for the whole server workspace rather than only
 * while its page is open: the overview's content-health card and the file manager's "refresh after
 * a change under /mods" both read from the same workspace, and giving them a second copy would mean
 * a second update-plan fetch and a list that disagrees with the page. What they need travels up
 * through `onBridgeChange` instead, so the shell holds a view of the module rather than its state.
 */
export type ModsModuleBridge = {
  updatePlan: ModUpdatePlan | null;
  updatePlanLoading: boolean;
  /** A mod mutation the UI cache control must not interrupt. */
  mutating: boolean;
  /** Re-checks for updates and reports the outcome, for the overview's refresh control. */
  refreshUpdates(): Promise<void>;
  /** Re-reads the installed list after the file manager changed something under the content folder. */
  refreshAfterFileChange(): Promise<unknown> | unknown;
};

export type ModsModuleProps = {
  active: boolean;
  activePage: ActivePage;
  activeServer: ManagedServer | undefined;
  activeServerIsDemo: boolean;
  activeServerUsesInternalNode: boolean;
  activeNodeRuntimeBlocked: boolean;
  activeNodeBlockMessage: string;
  demoMode: boolean;
  demoInstalledMods: InstalledMod[];
  setDemoInstalledMods: Dispatch<SetStateAction<InstalledMod[]>>;
  modrinthConfigured: boolean;
  isProvisioning: boolean;
  canManage: boolean;
  canInstall: boolean;
  /** Conditions the shell owns for its own reasons; what they mean for mods is decided here. */
  dockerOperationalLock: boolean;
  activeStatus: ServerStatus | null;
  activeJobs: readonly GeneralJob[];
  runtimeControlsDisabledReason: string;
  exportMutationLocked: boolean;
  exportMutationBlockedReason: string;
  notify: Notify;
  setNotice: Dispatch<SetStateAction<string>>;
  setActiveJobs: Dispatch<SetStateAction<GeneralJob[]>>;
  handleStaleSession(error: unknown): boolean;
  refreshFiles(serverId: string, path: string): Promise<unknown>;
  refreshServerState(): Promise<unknown>;
  requestConfirmation: RequestConfirmation;
  onBridgeChange(bridge: ModsModuleBridge | null): void;
  managedContent: ManagedContentTerminology;
  runtimeType: ServerRuntimeType;
  restartRequiredChanges: ManagedServer["restartRequiredChanges"];
  minecraftVersion: string;
  versionsUnknown: boolean;
  contextMessage: string;
  relativeTimestamps: boolean;
  formatDate(value: string | number | Date): string;
  formatNumber(value: number): string;
};

export function ModsModule(props: ModsModuleProps) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const demoHistory = useDemoModHistory(props.activeServer?.id, props.activeServerIsDemo, props.demoInstalledMods, props.setDemoInstalledMods);
  useEffect(() => { setHistoryOpen(false); }, [props.activeServer?.id, props.active]);
  const guards = resolveModGuards({
    isProvisioning: props.isProvisioning,
    dockerOperationalLock: props.dockerOperationalLock,
    canManageMods: props.canManage,
    canInstallMods: props.canInstall,
    activeStatus: props.activeStatus,
    activeJobs: props.activeJobs,
    modrinthApiConfigured: props.modrinthConfigured,
    runtimeControlsDisabledReason: props.runtimeControlsDisabledReason,
    managedContent: props.managedContent,
    exportMutationLocked: props.exportMutationLocked,
    exportMutationBlockedReason: props.exportMutationBlockedReason
  });
  const workspace = useModsWorkspace({
    activeServer: props.activeServer,
    activePage: props.activePage,
    activeServerIsDemo: props.activeServerIsDemo,
    activeServerUsesInternalNode: props.activeServerUsesInternalNode,
    activeNodeRuntimeBlocked: props.activeNodeRuntimeBlocked,
    activeNodeBlockMessage: props.activeNodeBlockMessage,
    demoMode: props.demoMode,
    demoInstalledMods: props.demoInstalledMods,
    setDemoInstalledMods: props.setDemoInstalledMods,
    modrinthConfigured: props.modrinthConfigured,
    isProvisioning: props.isProvisioning,
    canManage: props.canManage,
    canInstall: props.canInstall,
    modsLocked: guards.modsLocked,
    toggleLocked: guards.modToggleLocked,
    notify: props.notify,
    setNotice: props.setNotice,
    setActiveJobs: props.setActiveJobs,
    handleStaleSession: props.handleStaleSession,
    refreshFiles: props.refreshFiles,
    refreshServerState: props.refreshServerState,
    requestConfirmation: props.requestConfirmation
  });

  // The bridge's callbacks must keep a stable identity or the shell would rebuild its own callbacks
  // on every mod list change, so they read the live workspace through a ref instead of closing over it.
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const contentRef = useRef(props.managedContent);
  contentRef.current = props.managedContent;
  const serverIdRef = useRef(props.activeServer?.id);
  serverIdRef.current = props.activeServer?.id;
  const updateCheckInFlightRef = useRef(false);

  const refreshUpdates = useCallback(async () => {
    if (updateCheckInFlightRef.current) return;
    updateCheckInFlightRef.current = true;
    const managedContent = contentRef.current;
    const toastId = `overview-mod-update-check:${serverIdRef.current ?? "current"}`;
    toast.loading("Checking for updates", { id: toastId, duration: Infinity, dismissible: false });
    try {
      const updatePlan = await workspaceRef.current.actions.refresh(true, false);
      if (!updatePlan) {
        toast.error(`Could not check ${managedContent.singular} updates`, { id: toastId, duration: 7000, closeButton: true, dismissible: true });
        return;
      }
      toast.success(modUpdateRefreshResultMessage(updatePlan, managedContent.plural), { id: toastId, duration: 5000, closeButton: true, dismissible: true });
    } catch (error) {
      toast.error(`Could not check ${managedContent.singular} updates`, {
        id: toastId,
        description: errorMessage(error, `Could not check ${managedContent.singular} updates.`),
        duration: 7000,
        closeButton: true,
        dismissible: true
      });
    } finally {
      updateCheckInFlightRef.current = false;
    }
  }, []);

  const refreshAfterFileChange = useCallback(() => workspaceRef.current.actions.refresh(false), []);

  const updatePlan = workspace.data.updatePlan;
  const updatePlanLoading = workspace.state.updatePlanLoading;
  // Includes the module's own panel jobs, so the shell no longer has to know which job types are
  // a mod operation in order to decide whether clearing its cache would interrupt one.
  const mutating = guards.modJobRunning || workspace.state.batchUpdateRunning || Boolean(workspace.state.installState?.installing);
  const bridge = useMemo<ModsModuleBridge>(
    () => ({ updatePlan, updatePlanLoading, mutating, refreshUpdates, refreshAfterFileChange }),
    [updatePlan, updatePlanLoading, mutating, refreshUpdates, refreshAfterFileChange]
  );

  const { onBridgeChange } = props;
  useEffect(() => {
    onBridgeChange(bridge);
  }, [bridge, onBridgeChange]);
  useEffect(() => () => onBridgeChange(null), [onBridgeChange]);

  if (!props.active || !props.activeServer) return null;

  if (historyOpen) return <ModHistoryPage key={props.activeServer.id} serverId={props.activeServer.id}
    terminology={props.managedContent} installedMods={workspace.data.installedMods} locked={guards.modsLocked || mutating}
    requestConfirmation={props.requestConfirmation} onBack={() => setHistoryOpen(false)}
    onChanged={async () => {
      // Demo changes flow through the fixture prop; an in-flight refresh would replay the old array.
      if (!props.activeServerIsDemo && props.activeServer) await Promise.all([
        workspace.actions.refresh(true, false),
        props.refreshFiles(props.activeServer.id, `/${props.managedContent.directory}`)
      ]);
    }}
    formatDate={props.formatDate} handleStaleSession={props.handleStaleSession} source={demoHistory} />;

  return (
    <ModsPage
      onHistory={() => setHistoryOpen(true)}
      workspace={workspace}
      runtimeType={props.runtimeType}
      restartRequiredChanges={props.restartRequiredChanges}
      serverContext={{
        minecraftVersion: props.minecraftVersion,
        versionsUnknown: props.versionsUnknown,
        contextMessage: props.contextMessage
      }}
      access={{
        changesAllowed: !guards.modsLocked,
        locked: guards.modsLocked,
        reviewAcknowledgementLocked: guards.modReviewAcknowledgementLocked,
        toggleLocked: guards.modToggleLocked,
        modrinthConfigured: props.modrinthConfigured,
        addDisabled: guards.addModFromModrinthDisabled,
        addDisabledReason: guards.addModFromModrinthDisabledReason,
        uploadDisabled: guards.uploadModDisabled,
        uploadDisabledReason: guards.uploadModDisabledReason
      }}
      relativeTimestamps={props.relativeTimestamps}
      formatters={{ date: props.formatDate, number: props.formatNumber }}
    />
  );
}
