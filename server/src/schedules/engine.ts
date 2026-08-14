import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { runtimeForServer, services } from "../appServices.js";
import { cronMatches, timeZoneMinuteKey, validateCron } from "../core.js";
import { optionalStrictBoolean } from "../http/validation.js";
import { durationSince, logError, logInfo, logWarn, errorLogFields } from "../logging.js";
import { captureScheduledCommandLogs } from "./runLogCapture.js";
import { serverLogFields } from "../runtime/local/dockerContainers.js";
import { listManagedServers } from "../servers/store.js";
import { restartServerGracefully, sendConsoleCommandWithIntent, startServerWithIntent, stopServerWithIntent } from "../servers/lifecycle.js";
import { activeScheduleExecutions, activeScheduledRunsFor, runningSchedules, scheduleExecutionKey, type ActiveScheduleExecution } from "./activeRuns.js";
import { sanitizeScheduleSteps, ScheduleCancellationError, throwIfScheduleCancelled, waitForCommandDelay } from "./steps.js";
import type { NodeRuntime } from "../nodes/types.js";
import type { ManagedServer, OperationRecord, ScheduleProcedure, ScheduledExecution, ScheduledRun, ScheduledRunDetails, ScheduledRunStepDetails } from "../types.js";

const scheduleWaitRecoveryKind = "schedule.wait-for-empty";

type ScheduleWaitRecovery = {
  kind: typeof scheduleWaitRecoveryKind;
  version: 1;
  phase: "waiting" | "executing";
  runId: string;
  startedAt: string;
  schedule: ScheduledExecution;
};

type ResumedScheduleExecution = {
  operationId: string;
  runId: string;
  startedAt: string;
};

function recoveryScheduleSnapshot(schedule: ScheduledExecution): ScheduledExecution {
  return {
    id: schedule.id,
    name: schedule.name,
    cron: schedule.cron,
    steps: schedule.steps,
    onlyWhenNoPlayers: schedule.onlyWhenNoPlayers,
    waitForPlayersToLeave: schedule.waitForPlayersToLeave,
    enabled: schedule.enabled,
    createdAt: schedule.createdAt,
    updatedAt: schedule.updatedAt
  };
}

function scheduleWaitRecovery(
  schedule: ScheduledExecution,
  runId: string,
  startedAt: string,
  phase: ScheduleWaitRecovery["phase"]
): ScheduleWaitRecovery {
  return {
    kind: scheduleWaitRecoveryKind,
    version: 1,
    phase,
    runId,
    startedAt,
    schedule: recoveryScheduleSnapshot(schedule)
  };
}

function parseScheduleWaitRecovery(operation: OperationRecord): ScheduleWaitRecovery | undefined {
  const value = operation.result;
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<ScheduleWaitRecovery>;
  if (candidate.kind !== scheduleWaitRecoveryKind || candidate.version !== 1 || candidate.phase !== "waiting") return undefined;
  if (typeof candidate.runId !== "string" || typeof candidate.startedAt !== "string") return undefined;
  const schedule = candidate.schedule;
  if (!schedule || typeof schedule !== "object"
    || typeof schedule.id !== "string" || typeof schedule.name !== "string" || typeof schedule.cron !== "string"
    || typeof schedule.onlyWhenNoPlayers !== "boolean" || schedule.waitForPlayersToLeave !== true
    || typeof schedule.enabled !== "boolean" || typeof schedule.createdAt !== "string" || typeof schedule.updatedAt !== "string") {
    return undefined;
  }
  try {
    return { ...candidate, schedule: { ...schedule, steps: sanitizeScheduleSteps(schedule.steps) } } as ScheduleWaitRecovery;
  } catch {
    return undefined;
  }
}

export function resumableScheduleWaitOperations(operations: readonly OperationRecord[]) {
  return operations.filter((operation) => Boolean(operation.serverId && parseScheduleWaitRecovery(operation)));
}
export function scheduleFromBody(body: {
  name?: string;
  cron?: string;
  steps?: unknown;
  onlyWhenNoPlayers?: boolean;
  waitForPlayersToLeave?: boolean;
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
  const waitForPlayersToLeave = optionalStrictBoolean(body.waitForPlayersToLeave, "waitForPlayersToLeave", false);
  const now = new Date().toISOString();
  return {
    id: existing?.id ?? randomUUID(),
    name,
    cron,
    steps,
    onlyWhenNoPlayers: waitForPlayersToLeave || optionalStrictBoolean(body.onlyWhenNoPlayers, "onlyWhenNoPlayers", false),
    waitForPlayersToLeave,
    enabled: optionalStrictBoolean(body.enabled, "enabled", existing?.enabled ?? true),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastRunAt: existing?.lastRunAt,
    lastStatus: existing?.lastStatus,
    lastMessage: existing?.lastMessage,
    recentRuns: existing?.recentRuns
  };
}

async function runScheduledExecution(server: ManagedServer, schedule: ScheduledExecution, active: ActiveScheduleExecution) {
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
    // A run allowed to wait already accepts an unbounded delay, and withScheduleMutation blocks it
    // on the export further down. Every other policy used to be dropped by the tick before it even
    // tested the cron match, which lost the occurrence with nothing recorded to explain it, so the
    // export becomes a reported skip rather than a silent no-op.
    if (!schedule.waitForPlayersToLeave && services.exportCoordinator.activeOperationId(server.id)) {
      logInfo({ ...serverLogFields(server), scheduleId: schedule.id, reason: "export_in_progress" }, "Schedule skipped");
      return { status: "skipped", message: "Skipped because a server export was running", details: details() };
    }
    if (schedule.waitForPlayersToLeave) {
      throwIfScheduleCancelled(active.controller.signal);
      const waitResult = await waitUntilServerIsEmpty(server, schedule, active);
      if (waitResult === "stopped") {
        logInfo({ ...serverLogFields(server), scheduleId: schedule.id, reason: "server_offline_while_waiting" }, "Schedule skipped");
        return { status: "skipped", message: "Skipped because Minecraft server stopped while waiting for players to leave", details: details() };
      }
    }

    return await withScheduleMutation(server.id, active, schedule.waitForPlayersToLeave, async () => {
    throwIfScheduleCancelled(active.controller.signal);
    active.message = "Checking server status";
    const status = await runtime.serverStatus(server) as { docker?: { running?: boolean } };
    if (!status.docker?.running && scheduleRequiresRunningServer(schedule)) {
      logInfo({ ...serverLogFields(server), scheduleId: schedule.id, reason: "server_offline" }, "Schedule skipped");
      return { status: "skipped", message: "Skipped because Minecraft server is stopped", details: details() };
    }
    if (schedule.onlyWhenNoPlayers && !schedule.waitForPlayersToLeave) {
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

    if (schedule.waitForPlayersToLeave) {
      // Player and export waits are safe to resume. Persist the phase change at the last possible
      // point before step delays and side effects, so a restart never replays a command or action.
      services.operationsRepository.update(active.operationId, {
        result: scheduleWaitRecovery(schedule, active.id, active.startedAt, "executing")
      });
    }

    for (const [index, step] of schedule.steps.entries()) {
      throwIfScheduleCancelled(active.controller.signal);
      const delaySeconds = step.delaySeconds;
      const label = step.type === "command" ? step.command : scheduleProcedureLabel[step.procedure];
      terminalStepIndex = index;
      terminalStep = label;
      active.currentStepIndex = index;
      active.currentStep = label;
      active.waitingDelaySeconds = delaySeconds || undefined;
      active.waitingUntil = delaySeconds ? new Date(Date.now() + delaySeconds * 1000).toISOString() : undefined;
      const runningMessage = step.type === "command"
        ? `Sending command ${index + 1} of ${schedule.steps.length}`
        : scheduleProcedureRunningMessage[step.procedure];
      active.message = delaySeconds
        ? `Waiting before step ${index + 1} of ${schedule.steps.length}`
        : runningMessage;
      await waitForCommandDelay(delaySeconds, active.controller.signal);
      active.waitingDelaySeconds = undefined;
      active.waitingUntil = undefined;
      active.message = runningMessage;
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
          await runScheduleProcedure(server, step.procedure);
          active.message = scheduleProcedureCompletedMessage[step.procedure];
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
    });
  } catch (error) {
    if (error instanceof ScheduleCancellationError || active.controller.signal.aborted) {
      logInfo({ ...serverLogFields(server), scheduleId: schedule.id, stepCount: schedule.steps.length, durationMs: durationSince(startedAt), status: "cancelled" }, "Schedule execution cancelled");
      return { status: "cancelled", message: "Cancelled by user", details: details() };
    }
    logError({ ...serverLogFields(server), scheduleId: schedule.id, stepCount: schedule.steps.length, durationMs: durationSince(startedAt), status: "failed", ...errorLogFields(error) }, "Schedule execution failed");
    return { status: "failed", message: error instanceof Error ? error.message : "Scheduled execution failed", details: details() };
  }
}

const scheduleProcedureLabel: Record<ScheduleProcedure, string> = {
  restart: "Restart",
  stop: "Stop",
  start: "Start"
};

const scheduleProcedureRunningMessage: Record<ScheduleProcedure, string> = {
  restart: "Restarting server",
  stop: "Stopping server",
  start: "Starting server"
};

const scheduleProcedureCompletedMessage: Record<ScheduleProcedure, string> = {
  restart: "Server restarted",
  stop: "Server stopped",
  start: "Server started"
};

function runScheduleProcedure(server: ManagedServer, procedure: ScheduleProcedure) {
  if (procedure === "restart") return restartServerGracefully(server);
  if (procedure === "stop") return stopServerWithIntent(server);
  return startServerWithIntent(server);
}

/**
 * Whether the run needs a running server to mean anything. Commands cannot reach a stopped server
 * and neither Restart nor Stop has anything to act on, so those runs are skipped rather than failed.
 * A schedule whose only action is Start is the exception: a stopped server is precisely its purpose.
 */
export function scheduleRequiresRunningServer(schedule: Pick<ScheduledExecution, "steps">) {
  return schedule.steps.some((step) => step.type === "command" || step.procedure !== "start");
}

const schedulePlayerWaitPollSeconds = 30;

export async function waitUntilServerIsEmpty(
  server: ManagedServer,
  schedule: ScheduledExecution,
  active: ActiveScheduleExecution,
  pollSeconds = schedulePlayerWaitPollSeconds
) {
  let lastMessage = "";
  while (true) {
    throwIfScheduleCancelled(active.controller.signal);
    let status: { docker?: { running?: boolean } };
    try {
      status = await runtimeForServer(server).serverStatus(server) as { docker?: { running?: boolean } };
    } catch (error) {
      active.message = "Waiting for server status";
      if (lastMessage !== active.message) {
        lastMessage = active.message;
        services.operationsRepository.update(active.operationId, { progress: 10, task: active.message });
        logWarn({ ...serverLogFields(server), scheduleId: schedule.id, reason: "server_status_unavailable", ...errorLogFields(error) }, active.message);
      }
      await waitForCommandDelay(pollSeconds, active.controller.signal);
      continue;
    }
    if (!status.docker?.running) return "stopped" as const;

    const count = await services.playerSnapshotCoordinator!.freshOnlineCount(server);
    throwIfScheduleCancelled(active.controller.signal);
    if (count === 0) {
      active.message = "Server is empty; preparing schedule";
      if (lastMessage !== active.message) {
        services.operationsRepository.update(active.operationId, { progress: 15, task: active.message });
      }
      return "empty" as const;
    }

    active.message = count === null
      ? "Waiting for player status"
      : `Waiting for ${count} player${count === 1 ? "" : "s"} to leave`;
    if (lastMessage !== active.message) {
      lastMessage = active.message;
      services.operationsRepository.update(active.operationId, { progress: 10, task: active.message });
      logInfo({ ...serverLogFields(server), scheduleId: schedule.id, playersOnline: count ?? undefined, reason: count === null ? "player_count_unknown" : "waiting_for_players" }, active.message);
    }
    await waitForCommandDelay(pollSeconds, active.controller.signal);
  }
}

async function withScheduleMutation<T>(
  serverId: string,
  active: ActiveScheduleExecution,
  waitForAvailability: boolean,
  action: () => Promise<T>
) {
  if (!waitForAvailability) return services.exportCoordinator.withMutation(serverId, action);
  while (services.exportCoordinator.activeOperationId(serverId)) {
    throwIfScheduleCancelled(active.controller.signal);
    if (active.message !== "Server is empty; waiting for export to finish") {
      active.message = "Server is empty; waiting for export to finish";
      services.operationsRepository.update(active.operationId, { progress: 15, task: active.message });
    }
    await waitForCommandDelay(1, active.controller.signal);
  }
  // The final availability check and mutation registration are synchronous. An export cannot
  // slip between them on this event loop, while action failures still propagate without retrying
  // already-executed schedule steps.
  return services.exportCoordinator.withMutation(serverId, action);
}

function scheduledRunLogSnapshot(runtime: NodeRuntime, server: ManagedServer) {
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

async function scheduledRunCommandLogCapture(runtime: NodeRuntime, server: ManagedServer, before: string | undefined) {
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

export async function executeMatchedSchedule(
  server: ManagedServer,
  schedule: ScheduledExecution,
  resumed?: ResumedScheduleExecution
) {
  logInfo({ ...serverLogFields(server), scheduleId: schedule.id, stepCount: schedule.steps.length }, "Schedule matched");
  const runId = resumed?.runId ?? randomUUID();
  const startedAt = resumed?.startedAt ?? new Date().toISOString();
  const operation = resumed
    ? services.operationsRepository.find(resumed.operationId)
    : services.operationsRepository.create({
        type: "schedule.run",
        serverId: server.id,
        nodeId: server.nodeId,
        task: `Running schedule ${schedule.name}`,
        progress: 0,
        result: schedule.waitForPlayersToLeave
          ? scheduleWaitRecovery(schedule, runId, startedAt, "waiting")
          : undefined
      });
  if (!operation || (operation.status !== "queued" && operation.status !== "running")) {
    throw new Error(`Schedule operation ${resumed?.operationId ?? "could not be created"} is not resumable`);
  }
  services.operationsRepository.start(operation.id, {
    progress: 10,
    task: resumed ? `Resuming schedule ${schedule.name}` : `Running schedule ${schedule.name}`
  });
  const active: ActiveScheduleExecution = {
    id: runId,
    serverId: server.id,
    scheduleId: schedule.id,
    scheduleName: schedule.name,
    status: "running",
    startedAt,
    stepCount: schedule.steps.length,
    cancellable: true,
    message: resumed ? "Resuming after panel restart" : "Starting",
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

/**
 * `requireAvailability` decides what an active export means. A person pressing Run now gets the
 * refusal reported back to them, so the assertion stands; the scheduler asks for it to be relaxed
 * because it has nobody to report to, and records the skip against the run history instead.
 */
export function startScheduleExecution(
  server: ManagedServer,
  schedule: ScheduledExecution,
  { requireAvailability = true }: { requireAvailability?: boolean } = {}
) {
  const key = scheduleExecutionKey(server.id, schedule.id);
  if (runningSchedules.has(key)) return undefined;
  if (requireAvailability) services.exportCoordinator.assertMutationAllowed(server.id);

  runningSchedules.add(key);
  void executeMatchedSchedule(server, schedule)
    .catch((error) => {
      logError({ ...serverLogFields(server), scheduleId: schedule.id, ...errorLogFields(error) }, "Schedule run could not be recorded");
    })
    .finally(() => runningSchedules.delete(key));

  return activeScheduledRunsFor(server.id, schedule.id)[0];
}

export function resumeWaitingScheduleExecutions(operations: readonly OperationRecord[]) {
  let resumed = 0;
  for (const operation of operations) {
    const recovery = parseScheduleWaitRecovery(operation);
    const server = operation.serverId ? services.serversRepository.find(operation.serverId) : undefined;
    const scheduleStillExists = server?.schedules?.some((schedule) => schedule.id === recovery?.schedule.id);
    if (!recovery || !server || !scheduleStillExists) {
      services.operationsRepository.fail(
        operation.id,
        "Waiting schedule could not be resumed after serverSENTINEL restarted",
        { task: "Schedule recovery failed" }
      );
      continue;
    }

    const key = scheduleExecutionKey(server.id, recovery.schedule.id);
    if (runningSchedules.has(key)) {
      services.operationsRepository.fail(
        operation.id,
        "A newer execution of this schedule was already active after serverSENTINEL restarted",
        { task: "Schedule recovery skipped" }
      );
      continue;
    }

    runningSchedules.add(key);
    resumed += 1;
    logInfo({
      ...serverLogFields(server),
      scheduleId: recovery.schedule.id,
      runId: recovery.runId,
      operationId: operation.id
    }, "Resuming schedule that was waiting for players to leave");
    void executeMatchedSchedule(server, recovery.schedule, {
      operationId: operation.id,
      runId: recovery.runId,
      startedAt: recovery.startedAt
    })
      .catch((error) => {
        logError({ ...serverLogFields(server), scheduleId: recovery.schedule.id, ...errorLogFields(error) }, "Waiting schedule could not be resumed");
        services.operationsRepository.fail(operation.id, error instanceof Error ? error.message : "Schedule recovery failed", {
          task: "Schedule recovery failed"
        });
      })
      .finally(() => runningSchedules.delete(key));
  }
  return resumed;
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

      // Started even while an export holds the server. Cron matching is per wall-clock minute and
      // never retroactive, so refusing here spent the occurrence with nothing to show for it; the
      // run itself now decides whether to skip or wait, and either way it says so.
      startScheduleExecution(server, schedule, { requireAvailability: false });
    }
  }
}
