import { useRef, useState, type Dispatch, type SetStateAction } from "react";
import { api } from "../../api";
import type { RequestConfirmation } from "../../components/ConfirmationModal";
import { demoStatus } from "../../demo";
import type { ManagedServer, ScheduledActiveRun, ScheduledExecution, ScheduledRun, ScheduledRunStepDetails, ServerStatus } from "../../types";
import { errorMessage } from "../../utils/appHelpers";
import { clientId } from "../../utils/files";
import {
  createDemoSchedule,
  scheduleDisabledReason,
  scheduleUpdateLabel,
  scheduleValidationMessage,
  type SchedulePatch
} from "./scheduleWorkspaceHelpers";

type Notify = (type: "success" | "error" | "info" | "warning", text: string) => void;

type SchedulesWorkspaceInputs = {
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
  runtimeControlsDisabledReason: string;
  canManage: boolean;
  notify: Notify;
  setNotice: Dispatch<SetStateAction<string>>;
  requestConfirmation: RequestConfirmation;
  handleStaleSession(error: unknown): boolean;
  refreshApp(): Promise<void>;
};

export function useSchedulesWorkspace({
  activeServer,
  activeServerIsDemo,
  demoRunning,
  setDemoRunning,
  setDemoSchedules,
  setStatus,
  loading,
  error,
  isProvisioning,
  dockerOperationalLock,
  runtimeControlsDisabledReason,
  canManage,
  notify,
  setNotice,
  requestConfirmation,
  handleStaleSession,
  refreshApp
}: SchedulesWorkspaceInputs) {
  const [busy, setBusy] = useState(false);
  const demoRunControllersRef = useRef(new Map<string, AbortController>());
  const locked = isProvisioning || busy || dockerOperationalLock || !canManage || !activeServer;

  async function createSchedule(patch: SchedulePatch) {
    if (locked || !activeServer) return false;
    setNotice("");
    setBusy(true);
    const validationMessage = scheduleValidationMessage(patch);
    if (validationMessage) {
      setNotice(validationMessage);
      notify("error", validationMessage);
      setBusy(false);
      return false;
    }
    if (activeServerIsDemo) {
      const schedule = createDemoSchedule(patch, clientId(), new Date().toISOString());
      setDemoSchedules((current) => [schedule, ...current]);
      notify("success", "Demo schedule created");
      setBusy(false);
      return true;
    }
    try {
      await api<ScheduledExecution>(`/api/servers/${activeServer.id}/schedules`, {
        method: "POST",
        body: JSON.stringify({
          name: patch.name,
          cron: patch.cron,
          steps: patch.steps,
          onlyWhenNoPlayers: patch.onlyWhenNoPlayers,
          enabled: patch.enabled
        })
      });
      notify("success", "Schedule created");
      await refreshApp();
      return true;
    } catch (createError) {
      if (handleStaleSession(createError)) return false;
      const message = errorMessage(createError, "Could not create the schedule. Check the cron expression and commands.");
      setNotice(message);
      notify("error", message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function updateSchedule(schedule: ScheduledExecution, patch: Partial<ScheduledExecution>) {
    if (locked || !activeServer) return false;
    setBusy(true);
    const actionLabel = scheduleUpdateLabel(patch);
    if (activeServerIsDemo) {
      setDemoSchedules((current) => current.map((candidate) => (
        candidate.id === schedule.id
          ? { ...candidate, ...patch, updatedAt: new Date().toISOString() }
          : candidate
      )));
      notify("success", actionLabel);
      setBusy(false);
      return true;
    }
    try {
      const next = { ...schedule, ...patch };
      await api<ScheduledExecution>(`/api/servers/${activeServer.id}/schedules/${schedule.id}`, {
        method: "PUT",
        body: JSON.stringify({
          name: next.name,
          cron: next.cron,
          steps: next.steps,
          onlyWhenNoPlayers: next.onlyWhenNoPlayers,
          enabled: next.enabled
        })
      });
      notify("success", actionLabel);
      await refreshApp();
      return true;
    } catch (updateError) {
      if (handleStaleSession(updateError)) return false;
      const message = errorMessage(updateError, "Could not update the schedule. Try again after refreshing.");
      setNotice(message);
      notify("error", message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function deleteSchedule(schedule: ScheduledExecution) {
    if (locked || !activeServer) return;
    const confirmed = await requestConfirmation({
      title: `Delete ${schedule.name}?`,
      description: "Delete this schedule and its configured actions.",
      warning: "This action cannot be undone.",
      confirmLabel: "Delete schedule",
      variant: "critical"
    });
    if (!confirmed) return;
    setBusy(true);
    if (activeServerIsDemo) {
      setDemoSchedules((current) => current.filter((candidate) => candidate.id !== schedule.id));
      notify("success", `Deleted ${schedule.name}`);
      setBusy(false);
      return;
    }
    try {
      await api(`/api/servers/${activeServer.id}/schedules/${schedule.id}`, { method: "DELETE" });
      notify("success", `Deleted ${schedule.name}`);
      await refreshApp();
    } catch (deleteError) {
      if (handleStaleSession(deleteError)) return;
      const message = errorMessage(deleteError, "Could not delete the schedule. Try again after refreshing.");
      setNotice(message);
      notify("error", message);
    } finally {
      setBusy(false);
    }
  }

  async function runScheduleNow(schedule: ScheduledExecution) {
    if (locked || !activeServer) return false;
    setBusy(true);
    if (activeServerIsDemo) {
      const runId = clientId();
      const startedAt = new Date().toISOString();
      if (!demoRunning) {
        const message = "Skipped because Minecraft server is stopped";
        const run: ScheduledRun = { id: runId, scheduleId: schedule.id, scheduleName: schedule.name, status: "skipped", message, ranAt: startedAt, details: { stepCount: schedule.steps.length, completedStepCount: 0 } };
        setDemoSchedules((current) => current.map((candidate) => candidate.id === schedule.id ? { ...candidate, lastRunAt: startedAt, lastStatus: "skipped", lastMessage: message, recentRuns: [run, ...(candidate.recentRuns ?? [])].slice(0, 25) } : candidate));
        notify("info", `${schedule.name} was skipped`);
        setBusy(false);
        return true;
      }
      const controller = new AbortController();
      demoRunControllersRef.current.set(runId, controller);
      const activeRun: ScheduledActiveRun = { id: runId, scheduleId: schedule.id, scheduleName: schedule.name, status: "running", startedAt, stepCount: schedule.steps.length, cancellable: true, message: "Starting" };
      setDemoSchedules((current) => current.map((candidate) => candidate.id === schedule.id ? { ...candidate, activeRuns: [activeRun] } : candidate));
      notify("success", `Started ${schedule.name}`);
      setBusy(false);
      void runDemoSchedule(schedule, activeServer, activeRun, controller);
      return true;
    }
    try {
      await api<{ run: ScheduledActiveRun }>(`/api/servers/${activeServer.id}/schedules/${schedule.id}/run`, { method: "POST" });
      notify("success", `Started ${schedule.name}`);
      await refreshApp();
      return true;
    } catch (runError) {
      if (handleStaleSession(runError)) return false;
      const message = errorMessage(runError, "Could not start the schedule. It may already be running.");
      setNotice(message);
      notify("error", message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function runDemoSchedule(
    schedule: ScheduledExecution,
    server: ManagedServer,
    activeRun: ScheduledActiveRun,
    controller: AbortController
  ) {
    let completedStepCount = 0;
    let terminalStep = "";
    let terminalStepIndex: number | undefined;
    let outcome: "success" | "cancelled" | "failed" = "success";
    let message = "";
    const steps: ScheduledRunStepDetails[] = [];
    try {
      for (const [index, step] of schedule.steps.entries()) {
        terminalStepIndex = index;
        terminalStep = step.type === "command" ? step.command : "Restart";
        const delayMs = Math.min(step.delaySeconds * 1000, 5_000);
        const update = (patch: Partial<ScheduledActiveRun>) => setDemoSchedules((current) => current.map((candidate) => candidate.id === schedule.id ? { ...candidate, activeRuns: [{ ...activeRun, currentStepIndex: index, currentStep: terminalStep, ...patch }] } : candidate));
        if (delayMs) {
          update({ waitingUntil: new Date(Date.now() + delayMs).toISOString(), waitingDelaySeconds: delayMs / 1000, message: `Waiting before step ${index + 1}` });
          await new Promise<void>((resolve, reject) => {
            const timer = window.setTimeout(resolve, delayMs);
            controller.signal.addEventListener("abort", () => {
              window.clearTimeout(timer);
              reject(new DOMException("Cancelled", "AbortError"));
            }, { once: true });
          });
        }
        const stepDetails: ScheduledRunStepDetails = {
          stepIndex: index,
          type: step.type,
          command: step.type === "command" ? step.command : undefined,
          procedure: step.type === "action" ? step.procedure : undefined,
          delaySeconds: step.delaySeconds,
          status: "success",
          startedAt: new Date().toISOString()
        };
        steps.push(stepDetails);
        if (step.type === "action") {
          update({ cancellable: false, waitingUntil: undefined, waitingDelaySeconds: undefined, message: "Restarting server" });
          setDemoRunning(false);
          setStatus(demoStatus(server, false));
          await new Promise((resolve) => window.setTimeout(resolve, 1_500));
          setDemoRunning(true);
          setStatus(demoStatus(server, true));
        } else {
          update({ waitingUntil: undefined, waitingDelaySeconds: undefined, message: `Sent command ${index + 1}` });
          stepDetails.logs = [
            `[Server thread/INFO]: Executing scheduled command: ${step.command}`,
            "[Server thread/INFO]: Demo command completed successfully"
          ];
          stepDetails.logCaptureStatus = "captured";
        }
        stepDetails.completedAt = new Date().toISOString();
        completedStepCount += 1;
      }
      message = `Completed ${schedule.steps.length} step${schedule.steps.length === 1 ? "" : "s"}`;
    } catch (runError) {
      outcome = runError instanceof DOMException && runError.name === "AbortError" ? "cancelled" : "failed";
      message = outcome === "cancelled" ? "Cancelled by user" : errorMessage(runError, "Demo schedule failed");
      if (outcome === "failed" && steps.at(-1) && !steps.at(-1)?.completedAt) {
        steps[steps.length - 1].status = "failed";
        steps[steps.length - 1].completedAt = new Date().toISOString();
      }
    } finally {
      demoRunControllersRef.current.delete(activeRun.id);
      const run: ScheduledRun = { id: activeRun.id, scheduleId: schedule.id, scheduleName: schedule.name, status: outcome, message, ranAt: activeRun.startedAt, details: { stepCount: schedule.steps.length, completedStepCount, terminalStepIndex, terminalStep, steps } };
      setDemoSchedules((current) => current.map((candidate) => candidate.id === schedule.id ? { ...candidate, activeRuns: [], lastRunAt: activeRun.startedAt, lastStatus: outcome, lastMessage: message, recentRuns: [run, ...(candidate.recentRuns ?? [])].slice(0, 25) } : candidate));
    }
  }

  async function cancelScheduleRun(run: ScheduledActiveRun) {
    if (locked || !activeServer) return false;
    const confirmed = await requestConfirmation({
      title: `Cancel ${run.scheduleName}?`,
      description: "Cancel the currently active scheduled run.",
      warning: "Any remaining scheduled actions will not execute.",
      confirmLabel: "Cancel run",
      variant: "critical"
    });
    if (!confirmed) return false;
    if (activeServerIsDemo) {
      demoRunControllersRef.current.get(run.id)?.abort();
      notify("success", `Cancelled ${run.scheduleName}`);
      return true;
    }
    setBusy(true);
    try {
      await api(`/api/servers/${activeServer.id}/schedules/${run.scheduleId}/runs/${run.id}/cancel`, { method: "POST" });
      notify("success", `Cancelled ${run.scheduleName}`);
      await refreshApp();
      return true;
    } catch (cancelError) {
      if (handleStaleSession(cancelError)) return false;
      const message = errorMessage(cancelError, "Could not cancel the schedule run. It may have already finished.");
      setNotice(message);
      notify("error", message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  return {
    schedules: activeServer?.schedules ?? [],
    loading,
    error,
    busy,
    disabled: busy || isProvisioning || !canManage || dockerOperationalLock,
    disabledReason: scheduleDisabledReason({
      busy,
      isProvisioning,
      canManage,
      runtimeLocked: dockerOperationalLock,
      runtimeLockedReason: runtimeControlsDisabledReason
    }),
    actions: {
      create: createSchedule,
      toggle: (schedule: ScheduledExecution) => updateSchedule(schedule, { enabled: !schedule.enabled }),
      update: updateSchedule,
      delete: deleteSchedule,
      runNow: runScheduleNow,
      cancelRun: cancelScheduleRun
    }
  };
}
