import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { runtimeForServer, services } from "../appServices.js";
import { cronMatches, timeZoneMinuteKey, validateCron } from "../core.js";
import { optionalStrictBoolean } from "../http/validation.js";
import { durationSince, logError, logInfo, logWarn, errorLogFields } from "../logging.js";
import { captureScheduledCommandLogs } from "./runLogCapture.js";
import { serverLogFields } from "../runtime/local/dockerContainers.js";
import { listManagedServers } from "../servers/store.js";
import { restartServerGracefully, sendConsoleCommandWithIntent } from "../servers/lifecycle.js";
import { activeScheduleExecutions, activeScheduledRunsFor, runningSchedules, scheduleExecutionKey, type ActiveScheduleExecution } from "./activeRuns.js";
import { sanitizeScheduleSteps, ScheduleCancellationError, throwIfScheduleCancelled, waitForCommandDelay } from "./steps.js";
import type { NodeRuntime } from "../nodes/types.js";
import type { ManagedServer, ScheduledExecution, ScheduledRun, ScheduledRunDetails, ScheduledRunStepDetails } from "../types.js";
export function scheduleFromBody(body: {
  name?: string;
  cron?: string;
  steps?: unknown;
  onlyWhenNoPlayers?: boolean;
  enabled?: boolean;
}, existing?: ScheduledExecution): ScheduledExecution {
  const name = body.name?.trim();
  const cron = body.cron?.trim();
  if (!name) {
    throw new Error("Schedule name is required");
  }
  if (!cron) {
    throw new Error("Cron schedule is required");
  }
  validateCron(cron);
  const steps = sanitizeScheduleSteps(body.steps);
  const now = new Date().toISOString();
  return {
    id: existing?.id ?? randomUUID(),
    name,
    cron,
    steps,
    onlyWhenNoPlayers: optionalStrictBoolean(body.onlyWhenNoPlayers, "onlyWhenNoPlayers", false),
    enabled: optionalStrictBoolean(body.enabled, "enabled", existing?.enabled ?? true),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastRunAt: existing?.lastRunAt,
    lastStatus: existing?.lastStatus,
    lastMessage: existing?.lastMessage,
    recentRuns: existing?.recentRuns
  };
}

export async function runScheduledExecution(server: ManagedServer, schedule: ScheduledExecution, active: ActiveScheduleExecution) {
  const startedAt = Date.now();
  let completedStepCount = 0;
  let terminalStepIndex: number | undefined;
  let terminalStep: string | undefined;
  const steps: ScheduledRunStepDetails[] = [];
  const details = (): ScheduledRunDetails => ({
    stepCount: schedule.steps.length,
    completedStepCount,
    terminalStepIndex,
    terminalStep,
    steps
  });
  try {
    const runtime = runtimeForServer(server);
    throwIfScheduleCancelled(active.controller.signal);
    active.message = "Checking server status";
    const status = await runtime.serverStatus(server) as { docker?: { running?: boolean } };
    if (!status.docker?.running) {
      logInfo({ ...serverLogFields(server), scheduleId: schedule.id, reason: "server_offline" }, "Schedule skipped");
      return { status: "skipped", message: "Skipped because Minecraft server is stopped", details: details() };
    }
    if (schedule.onlyWhenNoPlayers) {
      throwIfScheduleCancelled(active.controller.signal);
      active.message = "Checking online players";
      const count = await services.playerSnapshotCoordinator!.freshOnlineCount(server);
      if (count === null) {
        logWarn({ ...serverLogFields(server), scheduleId: schedule.id, stepCount: schedule.steps.length, reason: "player_count_unknown" }, "Schedule skipped");
        return { status: "skipped", message: "Skipped because online player count could not be determined", details: details() };
      }
      if (count > 0) {
        logInfo({ ...serverLogFields(server), scheduleId: schedule.id, stepCount: schedule.steps.length, playersOnline: count, reason: "players_online" }, "Schedule skipped");
        return { status: "skipped", message: `Skipped because ${count} player${count === 1 ? "" : "s"} are online`, details: details() };
      }
    }

    for (const [index, step] of schedule.steps.entries()) {
      throwIfScheduleCancelled(active.controller.signal);
      const delaySeconds = step.delaySeconds;
      const label = step.type === "command" ? step.command : "Restart";
      terminalStepIndex = index;
      terminalStep = label;
      active.currentStepIndex = index;
      active.currentStep = label;
      active.waitingDelaySeconds = delaySeconds || undefined;
      active.waitingUntil = delaySeconds ? new Date(Date.now() + delaySeconds * 1000).toISOString() : undefined;
      active.message = delaySeconds
        ? `Waiting before step ${index + 1} of ${schedule.steps.length}`
        : step.type === "command" ? `Sending command ${index + 1} of ${schedule.steps.length}` : "Restarting server";
      await waitForCommandDelay(delaySeconds, active.controller.signal);
      active.waitingDelaySeconds = undefined;
      active.waitingUntil = undefined;
      active.message = step.type === "command" ? `Sending command ${index + 1} of ${schedule.steps.length}` : "Restarting server";
      throwIfScheduleCancelled(active.controller.signal);
      const stepDetails: ScheduledRunStepDetails = {
        stepIndex: index,
        type: step.type,
        command: step.type === "command" ? step.command : undefined,
        procedure: step.type === "action" ? step.procedure : undefined,
        delaySeconds,
        status: "success",
        startedAt: new Date().toISOString()
      };
      steps.push(stepDetails);
      if (step.type === "command") {
        const logsBefore = await scheduledRunLogSnapshot(runtime, server);
        try {
          await sendConsoleCommandWithIntent(server, step.command);
          active.message = `Sent command ${index + 1} of ${schedule.steps.length}`;
        } catch (error) {
          stepDetails.status = "failed";
          throw error;
        } finally {
          stepDetails.completedAt = new Date().toISOString();
          Object.assign(stepDetails, await scheduledRunCommandLogCapture(runtime, server, logsBefore));
        }
      } else {
        active.cancellable = false;
        try {
          await restartServerGracefully(server);
          active.message = "Server restarted";
        } catch (error) {
          stepDetails.status = "failed";
          throw error;
        } finally {
          stepDetails.completedAt = new Date().toISOString();
        }
      }
      completedStepCount += 1;
    }
    logInfo({ ...serverLogFields(server), scheduleId: schedule.id, stepCount: schedule.steps.length, durationMs: durationSince(startedAt), status: "success" }, "Schedule execution succeeded");
    return { status: "success", message: `Completed ${schedule.steps.length} step${schedule.steps.length === 1 ? "" : "s"}`, details: details() };
  } catch (error) {
    if (error instanceof ScheduleCancellationError || active.controller.signal.aborted) {
      logInfo({ ...serverLogFields(server), scheduleId: schedule.id, stepCount: schedule.steps.length, durationMs: durationSince(startedAt), status: "cancelled" }, "Schedule execution cancelled");
      return { status: "cancelled", message: "Cancelled by user", details: details() };
    }
    logError({ ...serverLogFields(server), scheduleId: schedule.id, stepCount: schedule.steps.length, durationMs: durationSince(startedAt), status: "failed", ...errorLogFields(error) }, "Schedule execution failed");
    return { status: "failed", message: error instanceof Error ? error.message : "Scheduled execution failed", details: details() };
  }
}

export function scheduledRunLogSnapshot(runtime: NodeRuntime, server: ManagedServer) {
  return new Promise<string | undefined>((resolveSnapshot) => {
    const timer = setTimeout(() => resolveSnapshot(undefined), 1_500);
    void runtime.serverLogs(server).then((result) => {
      clearTimeout(timer);
      const text = (result as { text?: unknown } | undefined)?.text;
      resolveSnapshot(typeof text === "string" ? text : undefined);
    }, () => {
      clearTimeout(timer);
      resolveSnapshot(undefined);
    });
  });
}

export async function scheduledRunCommandLogCapture(runtime: NodeRuntime, server: ManagedServer, before: string | undefined) {
  let after = await scheduledRunLogSnapshot(runtime, server);
  for (let attempt = 0; attempt < 3 && before !== undefined && after === before; attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    after = await scheduledRunLogSnapshot(runtime, server);
  }
  if (before !== undefined && after !== undefined && after !== before) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 75));
    after = await scheduledRunLogSnapshot(runtime, server) ?? after;
  }
  return captureScheduledCommandLogs(before, after);
}

export async function executeMatchedSchedule(server: ManagedServer, schedule: ScheduledExecution) {
  logInfo({ ...serverLogFields(server), scheduleId: schedule.id, stepCount: schedule.steps.length }, "Schedule matched");
  const operation = services.operationsRepository.create({
    type: "schedule.run",
    serverId: server.id,
    nodeId: server.nodeId,
    task: `Running schedule ${schedule.name}`,
    progress: 0
  });
  services.operationsRepository.start(operation.id, { progress: 10, task: `Running schedule ${schedule.name}` });
  const runId = randomUUID();
  const active: ActiveScheduleExecution = {
    id: runId,
    serverId: server.id,
    scheduleId: schedule.id,
    scheduleName: schedule.name,
    status: "running",
    startedAt: new Date().toISOString(),
    stepCount: schedule.steps.length,
    cancellable: true,
    message: "Starting",
    operationId: operation.id,
    controller: new AbortController()
  };
  activeScheduleExecutions.set(runId, active);
  let result: Awaited<ReturnType<typeof runScheduledExecution>>;
  try {
    result = await runScheduledExecution(server, schedule, active);
  } finally {
    // Nothing after this point may leave the run in the active list: a stranded entry keeps the
    // schedule reported as running forever and leaves its cancel control armed against a run
    // that has already finished.
    activeScheduleExecutions.delete(runId);
  }
  // Run history represents the invocation instant, not the completion instant.
  // Keeping this aligned with the matched cron minute also makes the durable
  // duplicate guard correct for long-running actions and DST overlaps.
  const ranAt = active.startedAt;
  const run: ScheduledRun = {
    id: runId,
    scheduleId: schedule.id,
    scheduleName: schedule.name,
    status: result.status,
    message: result.message,
    ranAt,
    details: result.details
  };
  try {
    services.serversRepository.recordScheduledRun(server.id, schedule.id, run);
  } catch (error) {
    // History is best effort; the operation record below is what the console and the run list
    // fall back on, so a persistence failure must not also abandon it in the running state.
    logError({ ...serverLogFields(server), scheduleId: schedule.id, runId, ...errorLogFields(error) }, "Schedule run history could not be recorded");
  }
  if (result.status === "failed") {
    services.operationsRepository.fail(operation.id, result.message, {
      progress: 100,
      task: "Schedule run failed",
      result: { scheduleId: schedule.id, run }
    });
  } else if (result.status === "cancelled") {
    services.operationsRepository.update(operation.id, {
      progress: 100,
      task: "Schedule run cancelled",
      result: { scheduleId: schedule.id, run }
    });
    services.operationsRepository.cancel(operation.id, result.message);
  } else {
    services.operationsRepository.succeed(operation.id, {
      progress: 100,
      task: result.status === "skipped" ? "Schedule run skipped" : "Schedule run complete",
      result: { scheduleId: schedule.id, run }
    });
  }
}

export function startScheduleExecution(server: ManagedServer, schedule: ScheduledExecution) {
  const key = scheduleExecutionKey(server.id, schedule.id);
  if (runningSchedules.has(key)) return undefined;

  runningSchedules.add(key);
  void executeMatchedSchedule(server, schedule)
    .catch((error) => {
      logError({ ...serverLogFields(server), scheduleId: schedule.id, ...errorLogFields(error) }, "Schedule run could not be recorded");
    })
    .finally(() => runningSchedules.delete(key));

  return activeScheduledRunsFor(server.id, schedule.id)[0];
}

export async function tickSchedules() {
  const now = new Date();
  const runKey = timeZoneMinuteKey(now, config.timeZone);
  const servers = await listManagedServers();
  for (const server of servers) {
    for (const schedule of server.schedules ?? []) {
      if (!schedule.enabled) continue;
      const key = scheduleExecutionKey(server.id, schedule.id);
      const lastRun = schedule.lastRunAt ? new Date(schedule.lastRunAt) : null;
      const alreadyRanThisWallMinute = lastRun && !Number.isNaN(lastRun.getTime())
        ? timeZoneMinuteKey(lastRun, config.timeZone) === runKey
        : false;
      if (runningSchedules.has(key) || alreadyRanThisWallMinute) continue;
      try {
        if (!cronMatches(schedule.cron, now)) continue;
      } catch {
        logWarn({ ...serverLogFields(server), scheduleId: schedule.id, cron: schedule.cron, reason: "invalid_cron" }, "Schedule skipped");
        continue;
      }

      startScheduleExecution(server, schedule);
    }
  }
}
