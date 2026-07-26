import { runtimeForServer, services } from "../appServices.js";

import { logWarn, errorLogFields } from "../logging.js";

import { serverLogFields } from "../runtime/local/dockerContainers.js";

import type { ForegroundOperationInput } from "../operations/operationService.js";
import type { ManagedServer, OperationRecord, OperationType } from "../types.js";
export function operationErrorMessage(error: unknown, fallback = "Operation failed") {
  return error instanceof Error ? error.message : fallback;
}

export async function recordOperation<T>(
  input: ForegroundOperationInput<T>,
  action: (operation: OperationRecord) => Promise<T>
) {
  return services.operationService.run(input, action);
}

export const stoppedServerMutationMessage = "Stop the server before changing mods, plugins, or server properties.";
export const blockingRuntimeOperationTypes = new Set<OperationType>(["server.start", "server.stop", "server.restart"]);
export const stoppedLikeDockerStates = new Set(["created", "dead", "exited"]);

export function blockingRuntimeOperations(serverId: string) {
  return services.operationsRepository.listActive(serverId).filter((operation) => blockingRuntimeOperationTypes.has(operation.type));
}

export function mutableServerConfigurationBlockedReason(status: unknown, operations: Array<{ type?: string }> = []) {
  if (operations.some((operation) => blockingRuntimeOperationTypes.has(operation.type as OperationType))) {
    return stoppedServerMutationMessage;
  }
  const docker = status && typeof status === "object" && "docker" in status
    ? (status as { docker?: { configured?: unknown; available?: unknown; running?: unknown; state?: unknown; message?: unknown } }).docker
    : status as { configured?: unknown; available?: unknown; running?: unknown; state?: unknown; message?: unknown } | undefined;
  if (docker?.running === true) return stoppedServerMutationMessage;
  const state = typeof docker?.state === "string" ? docker.state : "";
  const message = typeof docker?.message === "string" ? docker.message : "";
  if (state === "unknown") {
    return docker?.configured === false || (docker?.available === true && /container (?:will be created|not found|does not exist)|configured container does not exist/i.test(message))
      ? ""
      : stoppedServerMutationMessage;
  }
  if (state && !stoppedLikeDockerStates.has(state)) return stoppedServerMutationMessage;
  return "";
}

export async function requireServerStoppedForMutableConfiguration(server: ManagedServer) {
  const status = await runtimeForServer(server).serverStatus(server);
  const reason = mutableServerConfigurationBlockedReason(status, blockingRuntimeOperations(server.id));
  if (reason) throw new Error(reason);
}

export function runtimeResultRunning(value: unknown) {
  if (!value || typeof value !== "object") return false;
  const result = value as { running?: unknown; docker?: { running?: unknown } };
  return result.running === true || result.docker?.running === true;
}

export function runtimeStatusRunning(value: unknown): boolean | undefined {
  if (!value || typeof value !== "object") return undefined;
  const status = value as { running?: unknown; docker?: { available?: unknown; running?: unknown; state?: unknown; message?: unknown } };
  if (status.running === true || status.docker?.running === true) return true;
  if (status.docker?.available === false) return undefined;
  if (status.docker?.state === "unknown") {
    const message = typeof status.docker.message === "string" ? status.docker.message : "";
    return /container (?:will be created|not found|does not exist)|configured container does not exist/i.test(message) ? false : undefined;
  }
  if (status.running === false || status.docker?.running === false) return false;
  return undefined;
}

export const activeLifecycleActions = new Set<string>();

export function setRuntimeLifecycle(server: ManagedServer, patch: Partial<Pick<ManagedServer, "runtimeIntent" | "restartPhase" | "crashAttemptTimestamps" | "crashNextRetryAt" | "crashLoopSince" | "crashStableSince">>) {
  Object.assign(server, patch);
  server.runtimeIntent ??= "stopped";
  services.serversRepository.setRuntimeLifecycle(server.id, server);
}

export async function withLifecycleLock<T>(server: ManagedServer, operation: () => Promise<T>) {
  if (activeLifecycleActions.has(server.id)) throw new Error("Another lifecycle action is already running for this server");
  activeLifecycleActions.add(server.id);
  try {
    return await operation();
  } finally {
    activeLifecycleActions.delete(server.id);
  }
}

export async function waitForRuntimeState(server: ManagedServer, running: boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const observed = await runtimeForServer(server).serverStatus(server).then(runtimeStatusRunning).catch(() => undefined);
    if (observed === running) return true;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return false;
}

export async function startServerWithIntent(server: ManagedServer) {
  return withLifecycleLock(server, async () => {
    services.playerSnapshotCoordinator?.invalidate(server.id);
    const previous = server.runtimeIntent ?? "stopped";
    setRuntimeLifecycle(server, {
      runtimeIntent: "running",
      restartPhase: undefined,
      crashAttemptTimestamps: [],
      crashNextRetryAt: undefined,
      crashLoopSince: undefined,
      crashStableSince: undefined
    });
    try {
      const result = await runtimeForServer(server).lifecycle(server, "start");
      services.runtimeStateCoordinator?.noteRunning(server.id);
      return result;
    } catch (error) {
      const observed = await runtimeForServer(server).serverStatus(server).then(runtimeStatusRunning).catch(() => undefined);
      setRuntimeLifecycle(server, { runtimeIntent: observed === true ? "running" : previous === "restarting" ? "running" : previous });
      if (observed === true) services.runtimeStateCoordinator?.noteRunning(server.id);
      else services.runtimeStateCoordinator?.noteStopped(server.id);
      throw error;
    }
  });
}

export async function stopServerWithIntent(server: ManagedServer) {
  return withLifecycleLock(server, async () => {
    services.playerSnapshotCoordinator?.invalidate(server.id);
    setRuntimeLifecycle(server, {
      runtimeIntent: "stopped",
      restartPhase: undefined,
      crashAttemptTimestamps: [],
      crashNextRetryAt: undefined,
      crashLoopSince: undefined,
      crashStableSince: undefined
    });
    services.runtimeStateCoordinator?.noteStopped(server.id);
    return runtimeForServer(server).lifecycle(server, "stop");
  });
}

export async function restartServerGracefully(server: ManagedServer) {
  return withLifecycleLock(server, async () => {
    services.playerSnapshotCoordinator?.invalidate(server.id);
    setRuntimeLifecycle(server, {
      runtimeIntent: "restarting",
      restartPhase: "stopping",
      crashAttemptTimestamps: [],
      crashNextRetryAt: undefined,
      crashLoopSince: undefined,
      crashStableSince: undefined
    });
    services.runtimeStateCoordinator?.noteStopped(server.id);

    const running = await runtimeForServer(server).serverStatus(server).then(runtimeStatusRunning).catch(() => undefined);
    if (running === true) {
      await runtimeForServer(server).sendConsoleCommand(server, "stop").catch((error) => {
        logWarn({ ...serverLogFields(server), ...errorLogFields(error), action: "graceful_restart" }, "Minecraft stop command failed; Docker stop fallback will be used");
      });
    }
    let stopped = running === false || await waitForRuntimeState(server, false, 60_000);
    if (!stopped) {
      await runtimeForServer(server).lifecycle(server, "stop");
      stopped = await waitForRuntimeState(server, false, 10_000);
    }
    if (!stopped) {
      setRuntimeLifecycle(server, { runtimeIntent: "stopped", restartPhase: undefined });
      throw new Error("Minecraft did not stop within the graceful restart timeout");
    }

    setRuntimeLifecycle(server, { runtimeIntent: "restarting", restartPhase: "starting" });
    const result = await runtimeForServer(server).lifecycle(server, "start");
    if (!runtimeResultRunning(result) && !await waitForRuntimeState(server, true, 10_000)) {
      setRuntimeLifecycle(server, { runtimeIntent: "stopped", restartPhase: undefined });
      throw new Error("Minecraft did not remain running after restart");
    }
    setRuntimeLifecycle(server, { runtimeIntent: "running", restartPhase: undefined, crashStableSince: new Date().toISOString() });
    services.runtimeStateCoordinator?.noteRunning(server.id);
    services.serversRepository.clearRestartRequired(server.id);
    return result;
  });
}

export async function lifecycleWithIntent(server: ManagedServer, action: "start" | "stop" | "restart") {
  if (action === "start") return startServerWithIntent(server);
  if (action === "stop") return stopServerWithIntent(server);
  return restartServerGracefully(server);
}

export function isMinecraftStopCommand(command: unknown) {
  return typeof command === "string" && /^\/?stop$/i.test(command.trim());
}

export async function sendConsoleCommandWithIntent(server: ManagedServer, command: unknown) {
  if (!isMinecraftStopCommand(command)) return runtimeForServer(server).sendConsoleCommand(server, command);
  if (activeLifecycleActions.has(server.id)) throw new Error("A lifecycle action is already running for this server");
  const previous = server.runtimeIntent ?? "running";
  setRuntimeLifecycle(server, { runtimeIntent: "stopped", restartPhase: undefined, crashAttemptTimestamps: [], crashNextRetryAt: undefined, crashLoopSince: undefined, crashStableSince: undefined });
  services.runtimeStateCoordinator?.noteStopped(server.id);
  try {
    return await runtimeForServer(server).sendConsoleCommand(server, command);
  } catch (error) {
    const observed = await runtimeForServer(server).serverStatus(server).then(runtimeStatusRunning).catch(() => undefined);
    const fallback = observed === true ? "running" : observed === false ? "stopped" : previous;
    setRuntimeLifecycle(server, { runtimeIntent: fallback === "restarting" ? "running" : fallback });
    if (fallback !== "stopped") services.runtimeStateCoordinator?.noteRunning(server.id);
    throw error;
  }
}
