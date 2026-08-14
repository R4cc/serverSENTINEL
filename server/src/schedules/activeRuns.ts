import { services } from "../appServices.js";
import type { ScheduledActiveRun } from "../types.js";

export type ActiveScheduleExecution = ScheduledActiveRun & {
  serverId: string;
  operationId: string;
  controller: AbortController;
};

export const runningSchedules = new Set<string>();
export const activeScheduleExecutions = new Map<string, ActiveScheduleExecution>();

export function scheduleExecutionKey(serverId: string, scheduleId: string) {
  return `${serverId}:${scheduleId}`;
}

function publicActiveScheduleRun(run: ActiveScheduleExecution): ScheduledActiveRun {
  return {
    id: run.id,
    scheduleId: run.scheduleId,
    scheduleName: run.scheduleName,
    status: "running",
    startedAt: run.startedAt,
    stepCount: run.stepCount,
    currentStepIndex: run.currentStepIndex,
    currentStep: run.currentStep,
    cancellable: run.cancellable,
    waitingUntil: run.waitingUntil,
    waitingDelaySeconds: run.waitingDelaySeconds,
    message: run.message
  };
}

export function activeScheduledRunsFor(serverId: string, scheduleId: string) {
  return [...activeScheduleExecutions.values()]
    .filter((run) => run.serverId === serverId && run.scheduleId === scheduleId)
    .map(publicActiveScheduleRun);
}

/**
 * Cancels every active run of one schedule, so removing the schedule cannot strand an execution
 * that keeps sending commands with no row left in the UI to cancel it from. Reports false without
 * cancelling anything when a run is past its point of no return, leaving the caller to refuse
 * rather than delete the schedule out from under a restart that still has to finish.
 */
export function cancelActiveScheduleRunsForSchedule(serverId: string, scheduleId: string) {
  const runs = [...activeScheduleExecutions.values()]
    .filter((run) => run.serverId === serverId && run.scheduleId === scheduleId);
  if (runs.some((run) => !run.cancellable)) return false;
  for (const run of runs) cancelActiveScheduleRun(serverId, scheduleId, run.id);
  return true;
}

export function cancelActiveScheduleRun(serverId: string, scheduleId: string, runId: string) {
  const active = activeScheduleExecutions.get(runId);
  if (!active || active.serverId !== serverId || active.scheduleId !== scheduleId) return undefined;
  if (!active.cancellable) return null;
  if (!active.controller.signal.aborted) {
    active.message = "Cancellation requested";
    active.waitingDelaySeconds = undefined;
    active.waitingUntil = undefined;
    active.controller.abort();
    services.operationsRepository.update(active.operationId, { task: "Cancelling schedule run" });
  }
  return publicActiveScheduleRun(active);
}

