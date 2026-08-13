import { resolve } from "node:path";
import { config, maxServerPort, minServerPort } from "../config.js";
import { services } from "../appServices.js";
import { asArray, asObject, optionalString, requiredString } from "../storage/valueValidation.js";
import { isInsideServersDirectory } from "../storage/serverIdentity.js";
import { badRequest, optionalStrictBoolean, requireStrictBoolean, validateDockerContainerName, validateDockerImageName, validateJavaArgs, validateOperationId, validateScheduleId, validateServerId } from "../http/validation.js";
import { nextCronRun, parseDockerPorts } from "../core.js";
import { sanitizeScheduleSteps } from "../schedules/steps.js";
import { activeScheduledRunsFor } from "../schedules/activeRuns.js";
import { localNodeId } from "../nodes/nodeService.js";
import { normalizeManagedPorts } from "./ports.js";
import { normalizeRuntimeProfile } from "../runtime/profile.js";
import type { ManagedServer, ManagedServerPort, RestartRequiredChange, RestartRequiredModSnapshot, ScheduledActiveRun, ScheduledExecution, ScheduledRun, ScheduledRunStepDetails } from "../types.js";
export function normalizeSchedule(value: unknown): ScheduledExecution {
  const schedule = asObject(value, "schedule");
  const steps = sanitizeScheduleSteps(schedule.steps);
  const waitForPlayersToLeave = optionalStrictBoolean(schedule.waitForPlayersToLeave, "schedule.waitForPlayersToLeave", false);
  return {
    id: validateScheduleId(schedule.id),
    name: requiredString(schedule.name, "schedule.name"),
    cron: requiredString(schedule.cron, "schedule.cron"),
    steps,
    onlyWhenNoPlayers: waitForPlayersToLeave || requireStrictBoolean(schedule.onlyWhenNoPlayers, "schedule.onlyWhenNoPlayers"),
    waitForPlayersToLeave,
    enabled: requireStrictBoolean(schedule.enabled, "schedule.enabled"),
    createdAt: requiredString(schedule.createdAt, "schedule.createdAt"),
    updatedAt: requiredString(schedule.updatedAt, "schedule.updatedAt"),
    lastRunAt: optionalString(schedule.lastRunAt, "schedule.lastRunAt"),
    lastStatus: optionalString(schedule.lastStatus, "schedule.lastStatus"),
    lastMessage: optionalString(schedule.lastMessage, "schedule.lastMessage"),
    recentRuns: schedule.recentRuns === undefined ? undefined : asArray(schedule.recentRuns, "schedule.recentRuns").map(normalizeScheduledRun).slice(0, 25),
    activeRuns: schedule.activeRuns === undefined ? undefined : asArray(schedule.activeRuns, "schedule.activeRuns").map(normalizeScheduledActiveRun).slice(0, 25)
  };
}

export function normalizeScheduledRun(value: unknown): ScheduledRun {
  const run = asObject(value, "scheduled run");
  const details = run.details === undefined ? undefined : asObject(run.details, "run.details");
  return {
    id: requiredString(run.id, "run.id"),
    scheduleId: validateScheduleId(run.scheduleId),
    scheduleName: requiredString(run.scheduleName, "run.scheduleName"),
    status: requiredString(run.status, "run.status"),
    message: optionalString(run.message, "run.message"),
    ranAt: requiredString(run.ranAt, "run.ranAt"),
    details: details ? {
      stepCount: typeof details.stepCount === "number" ? details.stepCount : 0,
      completedStepCount: typeof details.completedStepCount === "number" ? details.completedStepCount : 0,
      terminalStepIndex: typeof details.terminalStepIndex === "number" ? details.terminalStepIndex : undefined,
      terminalStep: optionalString(details.terminalStep, "run.details.terminalStep"),
      steps: details.steps === undefined
        ? undefined
        : asArray(details.steps, "run.details.steps").map(normalizeScheduledRunStep).slice(0, 100)
    } : undefined
  };
}

export function normalizeScheduledRunStep(value: unknown, fallbackIndex: number): ScheduledRunStepDetails {
  const step = asObject(value, `run.details.steps[${fallbackIndex}]`);
  const type = requiredString(step.type, `run.details.steps[${fallbackIndex}].type`);
  if (type !== "command" && type !== "action") badRequest("Scheduled run step type must be command or action");
  const status = requiredString(step.status, `run.details.steps[${fallbackIndex}].status`);
  if (status !== "success" && status !== "failed") badRequest("Scheduled run step status must be success or failed");
  const procedure = optionalString(step.procedure, `run.details.steps[${fallbackIndex}].procedure`);
  if (procedure !== undefined && procedure !== "restart") badRequest("Scheduled run action must use the restart procedure");
  const logCaptureStatus = optionalString(step.logCaptureStatus, `run.details.steps[${fallbackIndex}].logCaptureStatus`);
  if (logCaptureStatus !== undefined && !["captured", "empty", "unavailable"].includes(logCaptureStatus)) {
    badRequest("Scheduled run log capture status is invalid");
  }
  return {
    stepIndex: typeof step.stepIndex === "number" ? step.stepIndex : fallbackIndex,
    type,
    command: optionalString(step.command, `run.details.steps[${fallbackIndex}].command`),
    procedure,
    delaySeconds: typeof step.delaySeconds === "number" ? step.delaySeconds : 0,
    status,
    startedAt: requiredString(step.startedAt, `run.details.steps[${fallbackIndex}].startedAt`),
    completedAt: optionalString(step.completedAt, `run.details.steps[${fallbackIndex}].completedAt`),
    logs: step.logs === undefined
      ? undefined
      : asArray(step.logs, `run.details.steps[${fallbackIndex}].logs`)
        .map((entry, index) => requiredString(entry, `run.details.steps[${fallbackIndex}].logs[${index}]`))
        .slice(0, 60),
    logCaptureStatus: logCaptureStatus as ScheduledRunStepDetails["logCaptureStatus"]
  };
}

export function normalizeScheduledActiveRun(value: unknown): ScheduledActiveRun {
  const run = asObject(value, "active scheduled run");
  return {
    id: validateOperationId(run.id),
    scheduleId: validateScheduleId(run.scheduleId),
    scheduleName: requiredString(run.scheduleName, "activeRun.scheduleName"),
    status: "running",
    startedAt: requiredString(run.startedAt, "activeRun.startedAt"),
    stepCount: typeof run.stepCount === "number" ? run.stepCount : 0,
    currentStepIndex: typeof run.currentStepIndex === "number" ? run.currentStepIndex : undefined,
    currentStep: optionalString(run.currentStep, "activeRun.currentStep"),
    cancellable: run.cancellable !== false,
    waitingUntil: optionalString(run.waitingUntil, "activeRun.waitingUntil"),
    waitingDelaySeconds: typeof run.waitingDelaySeconds === "number" ? run.waitingDelaySeconds : undefined,
    message: optionalString(run.message, "activeRun.message")
  };
}

/**
 * A run as it appears in a list: everything except the captured console output.
 *
 * Each command step may hold up to 24 KiB of log text and a schedule retains 25 runs, so a
 * server with a few multi-step schedules carried well over a megabyte of logs in every
 * `/api/app` reply -- a payload the Schedules page polls, and which the panel refetches after
 * most mutations. The logs are only ever rendered inside the run details dialog, one run at a
 * time, so that dialog fetches them from the per-run endpoint instead. `logCaptureStatus`
 * stays, because the list needs it to tell "nothing was captured" from "logs are available".
 */
export function scheduledRunSummary(run: ScheduledRun): ScheduledRun {
  if (!run.details?.steps?.length) return run;
  return {
    ...run,
    details: {
      ...run.details,
      steps: run.details.steps.map(({ logs: _logs, ...step }) => step)
    }
  };
}

export function publicSchedule(serverId: string, schedule: ScheduledExecution): ScheduledExecution {
  const nextRun = schedule.enabled ? safeNextCronRun(schedule.cron) : null;
  return {
    ...schedule,
    nextRunAt: nextRun?.toISOString(),
    recentRuns: (schedule.recentRuns ?? []).slice(0, 25).map(scheduledRunSummary),
    activeRuns: activeScheduledRunsFor(serverId, schedule.id)
  };
}

export function findScheduledRun(server: ManagedServer, scheduleId: string, runId: string) {
  const schedule = server.schedules?.find((candidate) => candidate.id === scheduleId);
  return schedule?.recentRuns?.find((run) => run.id === runId);
}

export function safeNextCronRun(cron: string) {
  try {
    return nextCronRun(cron);
  } catch {
    return null;
  }
}

export function normalizeManagedServer(value: unknown): ManagedServer {
  const server = asObject(value, "managed server");
  const dockerPorts = optionalString(server.dockerPorts, "server.dockerPorts");
  if (dockerPorts) parseDockerPorts(dockerPorts);
  const rawManagedPorts = Array.isArray(server.managedPorts) ? server.managedPorts : [];
  const managedPorts = normalizeManagedPorts(dockerPorts || "25565:25565/tcp", rawManagedPorts.map((port, index) => {
    const value = asObject(port, `server.managedPorts[${index}]`);
    const protocol = optionalString(value.protocol, `server.managedPorts[${index}].protocol`);
    const type = optionalString(value.type, `server.managedPorts[${index}].type`);
    return {
      id: optionalString(value.id, `server.managedPorts[${index}].id`) || `${type || "custom"}-${index}`,
      name: optionalString(value.name, `server.managedPorts[${index}].name`) || "Port",
      type: type === "minecraft" || type === "query" ? type : "custom",
      protocol: protocol === "udp" ? "udp" : "tcp",
      internalPort: Number(value.internalPort),
      externalPort: Number(value.externalPort),
      required: Boolean(value.required),
      removable: Boolean(value.removable),
      advanced: Boolean(value.advanced)
    } satisfies ManagedServerPort;
  }).filter((port) => (
    Number.isInteger(port.internalPort)
    && Number.isInteger(port.externalPort)
    && port.internalPort >= minServerPort
    && port.internalPort <= maxServerPort
    && port.externalPort >= minServerPort
    && port.externalPort <= maxServerPort
  )));
  const id = validateServerId(server.id);
  const nodeId = requiredString(server.nodeId, "server.nodeId");
  const serverDir = nodeId === localNodeId
    ? resolve(requiredString(server.serverDir, "server.serverDir"))
    : resolve(requiredString(server.serverDir, "server.serverDir"));
  if (nodeId === localNodeId && !isInsideServersDirectory(config.serversDir, serverDir)) {
    throw new Error("managed server serverDir must be inside the canonical data root servers directory");
  }
  const restartRequiredChanges = server.restartRequiredChanges === undefined ? undefined : asArray(server.restartRequiredChanges, "server.restartRequiredChanges").map((entry, index) => {
    const change = asObject(entry, `server.restartRequiredChanges[${index}]`);
    const action = requiredString(change.action, `server.restartRequiredChanges[${index}].action`);
    if (!new Set(["added", "removed", "enabled", "disabled", "updated"]).has(action)) throw new Error("Invalid restart-required mod action");
    return {
      type: "mod" as const,
      identity: requiredString(change.identity, `server.restartRequiredChanges[${index}].identity`),
      displayName: requiredString(change.displayName, `server.restartRequiredChanges[${index}].displayName`),
      filename: optionalString(change.filename, `server.restartRequiredChanges[${index}].filename`),
      action: action as RestartRequiredChange["action"]
    };
  });
  const restartRequiredModBaseline = server.restartRequiredModBaseline === undefined ? undefined : asArray(server.restartRequiredModBaseline, "server.restartRequiredModBaseline").map((entry, index) => {
    const mod = asObject(entry, `server.restartRequiredModBaseline[${index}]`);
    return {
      identity: requiredString(mod.identity, `server.restartRequiredModBaseline[${index}].identity`),
      displayName: requiredString(mod.displayName, `server.restartRequiredModBaseline[${index}].displayName`),
      filename: requiredString(mod.filename, `server.restartRequiredModBaseline[${index}].filename`),
      enabled: Boolean(mod.enabled),
      sha1: optionalString(mod.sha1, `server.restartRequiredModBaseline[${index}].sha1`) || ""
    } satisfies RestartRequiredModSnapshot;
  });
  return {
    id,
    nodeId,
    displayName: requiredString(server.displayName, "server.displayName"),
    serverDir,
    storageName: optionalString(server.storageName, "server.storageName"),
    runtimeProfile: normalizeRuntimeProfile(server.runtimeProfile),
    dockerContainer: server.dockerContainer === undefined ? undefined : validateDockerContainerName(server.dockerContainer),
    dockerImage: server.dockerImage === undefined ? undefined : validateDockerImageName(server.dockerImage),
    dockerMountSource: optionalString(server.dockerMountSource, "server.dockerMountSource"),
    dockerWorkingDir: optionalString(server.dockerWorkingDir, "server.dockerWorkingDir"),
    dockerPorts,
    managedPorts,
    javaArgs: server.javaArgs === undefined ? undefined : validateJavaArgs(server.javaArgs),
    startOnNodeStart: optionalStrictBoolean(server.startOnNodeStart, "server.startOnNodeStart", false),
    runtimeIntent: server.runtimeIntent === "running" || server.runtimeIntent === "stopped" || server.runtimeIntent === "restarting"
      ? server.runtimeIntent
      : undefined,
    restartPhase: server.restartPhase === "stopping" || server.restartPhase === "starting" ? server.restartPhase : undefined,
    crashAttemptTimestamps: server.crashAttemptTimestamps === undefined
      ? []
      : asArray(server.crashAttemptTimestamps, "server.crashAttemptTimestamps").map((value, index) => requiredString(value, `server.crashAttemptTimestamps[${index}]`)),
    crashNextRetryAt: optionalString(server.crashNextRetryAt, "server.crashNextRetryAt"),
    crashLoopSince: optionalString(server.crashLoopSince, "server.crashLoopSince"),
    crashStableSince: optionalString(server.crashStableSince, "server.crashStableSince"),
    portConflictUnresolved: optionalStrictBoolean(server.portConflictUnresolved, "server.portConflictUnresolved", false),
    restartRequiredSince: optionalString(server.restartRequiredSince, "server.restartRequiredSince"),
    restartRequiredChanges,
    restartRequiredModBaseline,
    schedules: server.schedules === undefined ? undefined : asArray(server.schedules, "server.schedules").map(normalizeSchedule),
    createdAt: requiredString(server.createdAt, "server.createdAt"),
    updatedAt: requiredString(server.updatedAt, "server.updatedAt")
  };
}

export async function readServers() {
  return services.serversRepository.list();
}

export function listManagedServers() {
  return readServers();
}

export async function getServer(serverId?: string) {
  if (serverId !== undefined) {
    validateServerId(serverId);
  }
  const server = serverId ? services.serversRepository.find(serverId) : (await listManagedServers())[0];
  if (!server) {
    throw new Error("No managed server instance is registered");
  }
  return server;
}

export function ensureManagedServerDirectory(server: ManagedServer) {
  const serverDir = resolve(server.serverDir);
  if (!isInsideServersDirectory(config.serversDir, serverDir)) {
    throw new Error("Server files can only be deleted when the directory is inside the managed servers directory");
  }
  return serverDir;
}
