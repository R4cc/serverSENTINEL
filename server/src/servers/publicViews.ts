import { findServerNode, localNodeId, readNodes } from "../nodes/nodeService.js";
import { publicSchedule } from "./store.js";
import { resolveServerVersions, versionResolution } from "./versions.js";
import { runtimeProfileForServer, runtimeTarget } from "../runtime/profile.js";
import type { ManagedNode, ManagedServer, PublicServer } from "../types.js";

export async function publicServer(server: ManagedServer, nodes?: ManagedNode[]): Promise<PublicServer> {
  const availableNodes = nodes ?? await readNodes();
  const node = findServerNode(server, availableNodes);
  const target = runtimeTarget(server);
  const resolvedAt = new Date().toISOString();
  return {
    id: server.id,
    nodeId: server.nodeId,
    displayName: server.displayName,
    storageName: server.storageName,
    dockerContainer: server.dockerContainer,
    dockerImage: server.dockerImage,
    dockerPorts: server.dockerPorts,
    javaArgs: server.javaArgs,
    startOnNodeStart: server.startOnNodeStart,
    restartRequiredSince: server.restartRequiredSince,
    restartRequiredChanges: server.restartRequiredChanges,
    schedules: (server.schedules ?? []).map((schedule) => publicSchedule(server.id, schedule)),
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
    directoryLabel: server.storageName || server.id,
    hasDockerContainer: Boolean(server.dockerContainer),
    nodeName: node?.name,
    runtimeProfile: runtimeProfileForServer(server),
    resolvedVersions: server.nodeId === localNodeId ? await resolveServerVersions(server) : {
      minecraftVersion: versionResolution(target.minecraftVersion, target.minecraftVersion ? "profile" : "unknown", resolvedAt),
      runtimeVersion: versionResolution(target.runtimeVersion, target.runtimeVersion ? "profile" : "unknown", resolvedAt)
    }
  };
}

export function publicDockerStatus(value: unknown) {
  const docker = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    configured: docker.configured === true,
    available: docker.available === true,
    controllable: docker.controllable === true,
    state: typeof docker.state === "string" ? docker.state : "unknown",
    running: typeof docker.running === "boolean" ? docker.running : undefined,
    container: typeof docker.container === "string" ? docker.container : undefined,
    message: typeof docker.message === "string" && docker.message ? docker.message : undefined
  };
}

export function publicServerStatus(status: unknown, server: Pick<ManagedServer, "id"> & Partial<ManagedServer>) {
  const source = status && typeof status === "object" ? status as Record<string, unknown> : {};
  const docker = publicDockerStatus(source.docker);
  const intent = server.runtimeIntent ?? (docker.running ? "running" : "stopped");
  const lifecycleState = server.crashLoopSince
    ? "crash-loop" as const
    : server.crashNextRetryAt
      ? "recovering" as const
      : intent === "restarting"
        ? server.restartPhase === "starting" ? "starting" as const : "stopping" as const
        : intent === "stopped" && docker.running ? "stopping" as const
        : docker.running ? "running" as const : "stopped" as const;
  const attempts = server.crashAttemptTimestamps?.length ?? 0;
  return {
    server: { id: server.id },
    docker,
    fileLogsAvailable: source.fileLogsAvailable === true,
    controlAvailable: source.controlAvailable === true,
    commandInputAvailable: source.commandInputAvailable === true,
    commandInputMessage: typeof source.commandInputMessage === "string" ? source.commandInputMessage : "",
    lifecycle: {
      intent,
      state: lifecycleState,
      recoveryAttempt: lifecycleState === "recovering" || lifecycleState === "crash-loop" ? attempts : undefined,
      recoveryLimit: lifecycleState === "recovering" || lifecycleState === "crash-loop" ? 3 : undefined,
      nextRetryAt: server.crashNextRetryAt,
      crashLoopSince: server.crashLoopSince,
      message: lifecycleState === "crash-loop"
        ? "Automatic restart stopped after three attempts within 10 minutes"
        : lifecycleState === "recovering"
          ? `Unexpected crash; automatic restart attempt ${Math.min(attempts + 1, 3)} of 3 is scheduled`
          : lifecycleState === "stopping" ? intent === "restarting" ? "Gracefully stopping Minecraft for restart" : "Stopping Minecraft to honor intentional stop"
          : lifecycleState === "starting" ? "Starting Minecraft after intentional restart"
          : undefined
    }
  };
}

export function publicModCompatibility(value: unknown) {
  if (!value || typeof value !== "object") return value;
  const compatibility = value as Record<string, unknown>;
  const file = compatibility.file && typeof compatibility.file === "object" ? compatibility.file as Record<string, unknown> : undefined;
  return {
    ...compatibility,
    file: file ? {
      filename: typeof file.filename === "string" ? file.filename : undefined,
      size: typeof file.size === "number" ? file.size : undefined
    } : undefined
  };
}

export function publicInstalledModMetadata(value: unknown) {
  if (!value || typeof value !== "object") return value;
  const metadata = value as Record<string, unknown>;
  const { hashes: _hashes, ...publicMetadata } = metadata;
  return publicMetadata;
}

export function publicInstalledModsResult(result: unknown) {
  if (!result || typeof result !== "object" || !Array.isArray((result as { mods?: unknown }).mods)) return result;
  const base = result as { mods: Array<Record<string, unknown>> };
  return {
    ...base,
    mods: base.mods.map((mod) => {
      const { sha1: _sha1, ...publicMod } = mod;
      return {
        ...publicMod,
        compatibility: publicModCompatibility(mod.compatibility),
        modrinth: publicInstalledModMetadata(mod.modrinth)
      };
    })
  };
}
