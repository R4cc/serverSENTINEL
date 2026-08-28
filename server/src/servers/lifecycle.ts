import { runtimeForServer, services } from "../appServices.js";

import { logWarn, errorLogFields } from "../logging.js";

import { serverLogFields } from "../runtime/local/dockerContainers.js";

import { blockingRuntimeOperationTypes, mutableServerConfigurationBlockedReason } from "./mutableConfigurationGate.js";
import { unresolvedServerPortIssues } from "./ports.js";
import { conflict as requestConflict } from "../http/errors.js";

import type { ForegroundOperationInput } from "../operations/operationService.js";
import type { ManagedServer, OperationRecord } from "../types.js";
export function operationErrorMessage(error: unknown, fallback = "Operation failed") {
  return error instanceof Error ? error.message : fallback;
}

export async function recordOperation<T>(
  input: ForegroundOperationInput<T>,
  action: (operation: OperationRecord) => Promise<T>
) {
  return services.operationService.run(input, action);
}

export function blockingRuntimeOperations(serverId: string) {
  return services.operationsRepository.listActive(serverId).filter((operation) => blockingRuntimeOperationTypes.has(operation.type));
}

export async function requireServerStoppedForMutableConfiguration(server: ManagedServer) {
  services.exportCoordinator.assertMutationAllowed(server.id);
  const status = await runtimeForServer(server).serverStatus(server);
  const reason = mutableServerConfigurationBlockedReason(status, blockingRuntimeOperations(server.id));
  if (reason) throw new Error(reason);
}

export function runtimeResultRunning(value: unknown) {
  if (!value || typeof value !== "object") return false;
  const result = value as { running?: unknown; docker?: { running?: unknown } };
  return result.running === true || result.docker?.running === true;
}

function runtimeStatusRunning(value: unknown): boolean | undefined {
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

async function withLifecycleLock<T>(server: ManagedServer, operation: () => Promise<T>) {
  return services.exportCoordinator.withMutation(server.id, async () => {
    if (activeLifecycleActions.has(server.id)) throw new Error("Another lifecycle action is already running for this server");
    activeLifecycleActions.add(server.id);
    try {
      return await operation();
    } finally {
      activeLifecycleActions.delete(server.id);
    }
  });
}

async function waitForRuntimeState(server: ManagedServer, running: boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const observed = await runtimeForServer(server).serverStatus(server).then(runtimeStatusRunning).catch(() => undefined);
    if (observed === running) return true;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return false;
}

function requireResolvedServerPorts(server: ManagedServer) {
  if (!server.portConflictUnresolved) return;
  const issues = unresolvedServerPortIssues(server, services.serversRepository.list());
  if (issues.length === 0) {
    server.portConflictUnresolved = false;
    services.serversRepository.clearPortConflictUnresolved(server.id);
    return;
  }
  const conflict = issues[0];
  requestConflict(
    `Port ${conflict.port}/${conflict.protocol} is already used on this node by "${conflict.conflictingServerName}". Change the imported server's port in Properties before starting it.`,
    { code: "PORT_CONFLICT", details: { port: conflict.port, protocol: conflict.protocol, conflictingServerId: conflict.conflictingServerId } }
  );
}

export async function startServerWithIntent(server: ManagedServer) {
  return withLifecycleLock(server, async () => {
    requireResolvedServerPorts(server);
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
    const result = await runtimeForServer(server).lifecycle(server, "stop");
    // The stopped process cannot be running stale mods, and the next start loads whatever is on
    // disk, so a stop resolves a pending restart just as a restart does.
    services.serversRepository.clearRestartRequired(server.id);
    return result;
  });
}

export async function restartServerGracefully(server: ManagedServer) {
  return withLifecycleLock(server, async () => {
    requireResolvedServerPorts(server);
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
  return services.exportCoordinator.withMutation(server.id, async () => {
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
  });
}
