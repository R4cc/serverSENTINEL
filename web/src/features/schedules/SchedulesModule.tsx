import { useEffect, type Dispatch, type SetStateAction } from "react";
import type { RequestConfirmation } from "../../components/ConfirmationModal";
import type { ManagedServer, Notify, ScheduleNavigationTarget, ScheduledExecution, ServerStatus } from "../../types";
import { SchedulePage } from "../../pages/SchedulesPage";
import { useSchedulesWorkspace } from "./useSchedulesWorkspace";

/**
 * The schedules module's entire browser surface: its workspace state and its page, behind one
 * dynamic import. The shell never references either directly, so a visitor who cannot reach
 * schedules — because the module is off, or because their account lacks `schedules.view` — never
 * downloads this chunk.
 *
 * The one thing the shell still needs from here is whether a schedule mutation is in flight, which
 * the UI cache control has to know before it may clear anything. That leaves through
 * `onBusyChange` rather than by hoisting the workspace back into the shell.
 */
export type SchedulesModuleProps = {
  activeServer: ManagedServer | null;
  activeServerIsDemo: boolean;
  demoRunning: boolean;
  setDemoRunning: Dispatch<SetStateAction<boolean>>;
  setDemoSchedules: Dispatch<SetStateAction<ScheduledExecution[]>>;
  setStatus: Dispatch<SetStateAction<ServerStatus | null>>;
  loading: boolean;
  error: string;
  isProvisioning: boolean;
  dockerOperationalLock: boolean;
  serverMutationLocked: boolean;
  serverMutationBlockedReason: string;
  runtimeControlsDisabledReason: string;
  canManage: boolean;
  notify: Notify;
  setNotice: Dispatch<SetStateAction<string>>;
  requestConfirmation: RequestConfirmation;
  handleStaleSession(error: unknown): boolean;
  refreshApp(): Promise<void>;
  onBusyChange(busy: boolean): void;
  relativeTimestamps: boolean;
  scheduleTimeZone: string;
  displayTimeZone: string;
  navigationTarget: ScheduleNavigationTarget | null;
  onNavigationTargetHandled(): void;
  formatDate(value: string | number | Date): string;
};

export function SchedulesModule(props: SchedulesModuleProps) {
  const workspace = useSchedulesWorkspace({
    activeServer: props.activeServer,
    activeServerIsDemo: props.activeServerIsDemo,
    demoRunning: props.demoRunning,
    setDemoRunning: props.setDemoRunning,
    setDemoSchedules: props.setDemoSchedules,
    setStatus: props.setStatus,
    loading: props.loading,
    error: props.error,
    isProvisioning: props.isProvisioning,
    dockerOperationalLock: props.dockerOperationalLock,
    serverMutationLocked: props.serverMutationLocked,
    serverMutationBlockedReason: props.serverMutationBlockedReason,
    runtimeControlsDisabledReason: props.runtimeControlsDisabledReason,
    canManage: props.canManage,
    notify: props.notify,
    setNotice: props.setNotice,
    requestConfirmation: props.requestConfirmation,
    handleStaleSession: props.handleStaleSession,
    refreshApp: props.refreshApp
  });

  const { busy } = workspace;
  const { onBusyChange } = props;
  useEffect(() => {
    onBusyChange(busy);
    // Leaving the page has to clear the flag too, or a mutation that was running as the visitor
    // navigated away would keep the cache control locked for the rest of the session.
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);

  return (
    <SchedulePage
      schedules={workspace.schedules}
      formatDate={props.formatDate}
      relativeTimestamps={props.relativeTimestamps}
      scheduleTimeZone={props.scheduleTimeZone}
      displayTimeZone={props.displayTimeZone}
      navigationTarget={props.navigationTarget}
      onNavigationTargetHandled={props.onNavigationTargetHandled}
      onCreate={workspace.actions.create}
      onToggle={workspace.actions.toggle}
      onUpdate={workspace.actions.update}
      onDelete={workspace.actions.delete}
      onRunNow={workspace.actions.runNow}
      onCancelRun={workspace.actions.cancelRun}
      onLoadRunLogs={workspace.actions.loadRunLogs}
      loading={workspace.loading}
      error={workspace.error}
      onReload={() => { void props.refreshApp(); }}
      disabled={workspace.disabled}
      disabledReason={workspace.disabledReason}
    />
  );
}
