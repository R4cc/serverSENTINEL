import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { totalmem } from "node:os";
import { config } from "../../config.js";
import { dockerHostPortBindings, ensureInsideServer, parseDockerPorts, validateExistingInsideServer } from "../../core.js";
import { consoleLogLineLimit, readConsoleLogTail } from "../../consoleLogs.js";
import { validateDockerContainerName, validateDockerImageName, validateJavaArgs } from "../../http/validation.js";
import { defaultServerContainerName } from "../../storage/serverIdentity.js";
import { summarizeRuntimeExit } from "../../runtimeErrors.js";
import { containerConfigHash, isManagedContainer, isManagedContainerFor, managedContainerLabels, type ContainerLabels } from "../containerLabels.js";
import { computeContainerResourceSample } from "../containerStats.js";
import { defaultDockerImageForMinecraftVersion, runtimeProfileForServer, runtimeTarget } from "../profile.js";
export { defaultDockerImageForMinecraftVersion } from "../profile.js";
import { dockerAvailable, dockerBufferRequest, dockerJsonRequest, dockerLogTailMaxBytes, dockerRequest, isMissingDockerNetworkError, sendDockerContainerStdinLine } from "../../docker/dockerClient.js";
import { stripDockerLogHeaders } from "../../docker/dockerLogs.js";
import { shellQuote } from "../../docker/shell.js";
import { durationSince, errorLogFields, logError, logInfo, logWarn, type LogFields } from "../../logging.js";
import { minecraftTerminalConfigFingerprint, minecraftTerminalContainerConfig } from "../terminal.js";
import { parseServerProperties, serializeServerProperties } from "./../serverProperties.js";
import type { DockerState, ManagedServer } from "../../types.js";

export type DockerContainerInspect = {
  Id?: string;
  State?: { Status?: DockerState; Running?: boolean; ExitCode?: number; OOMKilled?: boolean; StartedAt?: string; FinishedAt?: string };
  Name?: string;
  Config?: { Labels?: Record<string, string>; OpenStdin?: boolean; AttachStdin?: boolean; Tty?: boolean };
  HostConfig?: { RestartPolicy?: { Name?: string } };
  Mounts?: Array<{ Type?: string; Name?: string; Source?: string; Destination?: string }>;
  NetworkSettings?: { Networks?: Record<string, DockerNetworkAttachment> };
};

export type DockerNetworkAttachment = {
  IPAMConfig?: unknown;
  Aliases?: string[];
  DriverOpts?: Record<string, string>;
  EndpointID?: string;
  NetworkID?: string;
  IPAddress?: string;
  Gateway?: string;
  IPPrefixLen?: number;
  IPv6Gateway?: string;
  GlobalIPv6Address?: string;
  GlobalIPv6PrefixLen?: number;
  MacAddress?: string;
};

export type DockerNetworkingConfig = {
  EndpointsConfig: Record<string, { IPAMConfig?: unknown; Aliases?: string[]; DriverOpts?: Record<string, string> }>;
};

export type DockerStats = {
  read?: string;
  memory_stats?: { usage?: number; limit?: number; stats?: { cache?: number; inactive_file?: number } };
  cpu_stats?: {
    online_cpus?: number;
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
  };
  precpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
  };
  networks?: Record<string, { rx_bytes?: number; tx_bytes?: number }>;
};

export type DockerInfo = {
  MemTotal?: number;
};

export function serverLogFields(server: ManagedServer): LogFields {
  return {
    serverId: server.id,
    serverName: server.displayName,
    containerName: dockerContainerName(server)
  };
}

export function dockerContainerName(server: ManagedServer) {
  if (server.dockerContainer?.trim()) {
    return validateDockerContainerName(server.dockerContainer);
  }
  return validateDockerContainerName(defaultServerContainerName(server.id));
}

export function dockerControlConfigured(server: ManagedServer) {
  return Boolean(server.dockerContainer || (server.dockerMountSource && runtimeTarget(server).serverJar));
}

export function serverDockerMountSource(server: ManagedServer) {
  if (server.dockerMountSource && server.dockerMountSource !== server.serverDir) {
    return server.dockerMountSource;
  }
  return config.serversDockerVolume || server.dockerMountSource || server.serverDir;
}

export function serverDockerWorkingDir(server: ManagedServer) {
  if (server.dockerWorkingDir) {
    return server.dockerWorkingDir;
  }
  if (config.serversDockerVolume && server.storageName) {
    return `/data/servers/${server.storageName}`;
  }
  return "/data/server";
}

export function serverDockerBindTarget(server: ManagedServer) {
  return serverDockerWorkingDir(server).startsWith("/data/servers/") ? "/data/servers" : "/data/server";
}

export function dockerContainerMountValid(server: ManagedServer, details: DockerContainerInspect) {
  const expectedDestination = serverDockerBindTarget(server);
  const expectedSource = serverDockerMountSource(server);
  return Boolean(details.Mounts?.some((mount) => {
    if (mount.Destination !== expectedDestination) return false;
    if (expectedSource === config.serversDockerVolume) {
      return mount.Type === "volume" && mount.Name === expectedSource;
    }
    return mount.Source === expectedSource || mount.Name === expectedSource;
  }));
}

/**
 * Managed containers carry the id of the server that owns them, and `dockerContainer` is an editable
 * per-server setting. Checking only the managed marker would let a server configured with a sibling's
 * container name drive that sibling's runtime, so every local Docker path checks ownership instead.
 * Returns the refusal message, or undefined when the container really belongs to this server.
 */
function containerOwnershipRefusal(server: ManagedServer, labels: ContainerLabels, verb: "control" | "delete") {
  if (isManagedContainerFor(labels, server.id)) return undefined;
  const cause = isManagedContainer(labels)
    ? "belongs to a different managed server"
    : "exists but is not managed by serverSENTINEL";
  return `Container ${dockerContainerName(server)} ${cause}; refusing to ${verb} it`;
}

export async function removeDockerContainer(server: ManagedServer) {
  logInfo({ ...serverLogFields(server), action: "remove_container" }, "Removing Minecraft runtime container");
  await dockerRequest("DELETE", `/containers/${encodeURIComponent(dockerContainerName(server))}?force=1`, 204);
}

export async function removeManagedDockerContainer(server: ManagedServer) {
  const existing = await inspectDockerContainer(server);
  if (!existing) {
    return false;
  }
  const refusal = containerOwnershipRefusal(server, existing.Config?.Labels, "delete");
  if (refusal) {
    throw new Error(refusal);
  }
  await removeDockerContainer(server);
  return true;
}

export function splitImage(image: string) {
  const slashIndex = image.lastIndexOf("/");
  const colonIndex = image.lastIndexOf(":");
  if (colonIndex > slashIndex) {
    return { fromImage: image.slice(0, colonIndex), tag: image.slice(colonIndex + 1) };
  }
  return { fromImage: image, tag: "latest" };
}

export async function ensureDockerImage(image: string) {
  try {
    await dockerRequest("GET", `/images/${encodeURIComponent(image)}/json`, 200);
    return;
  } catch {
    logInfo({ image }, "Pulling Minecraft runtime image");
    const { fromImage, tag } = splitImage(image);
    await dockerBufferRequest(
      "POST",
      `/images/create?fromImage=${encodeURIComponent(fromImage)}&tag=${encodeURIComponent(tag)}`,
      200
    );
  }
}

export async function inspectDockerContainer(server: ManagedServer) {
  try {
    return await dockerRequest<DockerContainerInspect>(
      "GET",
      `/containers/${encodeURIComponent(dockerContainerName(server))}/json`,
      200
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("No such container") || message.includes("404")) {
      return null;
    }
    throw error;
  }
}

export function dockerRuntimeConfigHashInput(server: ManagedServer, options: { includeTerminal: boolean; restartPolicy: "no" | "unless-stopped" }) {
  const targetRuntime = runtimeTarget(server);
  return {
    image: server.dockerImage || defaultDockerImageForMinecraftVersion(targetRuntime.minecraftVersion),
    workingDir: serverDockerWorkingDir(server),
    bindTarget: serverDockerBindTarget(server),
    ports: server.dockerPorts || "25565:25565/tcp",
    serverJar: targetRuntime.serverJar,
    javaArgs: server.javaArgs || "-Xms2G -Xmx4G",
    ...(options.includeTerminal ? { terminal: minecraftTerminalConfigFingerprint() } : {}),
    restartPolicy: options.restartPolicy
  };
}

export function dockerRuntimeConfigHash(server: ManagedServer, options: { includeTerminal: boolean; restartPolicy: "no" | "unless-stopped" } = { includeTerminal: false, restartPolicy: "no" }) {
  return createHash("sha256").update(JSON.stringify(dockerRuntimeConfigHashInput(server, options))).digest("hex");
}

export async function reconcileDockerRestartPolicy(server: ManagedServer, details: DockerContainerInspect) {
  if (!isManagedContainerFor(details.Config?.Labels, server.id)) return;
  const restartPolicy = details.HostConfig?.RestartPolicy?.Name;
  if (!restartPolicy || restartPolicy === "no") return;
  await dockerJsonRequest(
    "POST",
    `/containers/${encodeURIComponent(dockerContainerName(server))}/update`,
    { RestartPolicy: { Name: "no" } },
    200
  );
  details.HostConfig = { ...details.HostConfig, RestartPolicy: { Name: "no" } };
  logInfo({ ...serverLogFields(server), previousRestartPolicy: restartPolicy }, "Updated Minecraft runtime restart policy");
}

export async function detectedTotalMemory() {
  if (dockerAvailable()) {
    try {
      const info = await dockerRequest<DockerInfo>("GET", "/info", 200);
      if (typeof info.MemTotal === "number" && info.MemTotal > 0) {
        return info.MemTotal;
      }
    } catch {
      // Fall through to Node's view of memory when Docker host info is unavailable.
    }
  }
  return totalmem();
}

export function currentContainerId() {
  return process.env.HOSTNAME || "";
}

export async function currentContainerInspect() {
  const id = currentContainerId();
  if (!id) return null;
  return dockerRequest<DockerContainerInspect>("GET", `/containers/${encodeURIComponent(id)}/json`, 200);
}

export function dockerNetworkingConfigFromInspect(inspect?: Pick<DockerContainerInspect, "NetworkSettings"> | null): DockerNetworkingConfig | undefined {
  const networks = inspect?.NetworkSettings?.Networks;
  if (!networks || Object.keys(networks).length === 0) return undefined;
  return {
    EndpointsConfig: Object.fromEntries(Object.entries(networks).map(([name, network]) => [name, {
      IPAMConfig: network.IPAMConfig,
      Aliases: network.Aliases,
      DriverOpts: network.DriverOpts
    }]))
  };
}

export function minecraftContainerNetworkingConfig(existing?: Pick<DockerContainerInspect, "NetworkSettings"> | null, fallback?: Pick<DockerContainerInspect, "NetworkSettings"> | null) {
  return dockerNetworkingConfigFromInspect(existing) ?? dockerNetworkingConfigFromInspect(fallback);
}

export async function currentContainerNetworkingConfig() {
  return dockerNetworkingConfigFromInspect(await currentContainerInspect().catch(() => null));
}

export async function ensureDockerContainer(server: ManagedServer, preferredNetworkingConfig?: DockerNetworkingConfig) {
  const expectedConfigHash = dockerRuntimeConfigHash(server);
  const legacyConfigHashes = new Set([
    dockerRuntimeConfigHash(server, { includeTerminal: false, restartPolicy: "unless-stopped" }),
    dockerRuntimeConfigHash(server, { includeTerminal: true, restartPolicy: "unless-stopped" })
  ]);
  const existing = await inspectDockerContainer(server);
  let networkingConfig = preferredNetworkingConfig;
  if (existing) {
    const refusal = containerOwnershipRefusal(server, existing.Config?.Labels, "control");
    if (refusal) {
      logWarn(serverLogFields(server), "Refusing to control Docker container owned by another server or unmanaged");
      throw new Error(refusal);
    }
    await reconcileDockerRestartPolicy(server, existing);
    const existingConfigHash = containerConfigHash(existing.Config?.Labels);
    const compatibleConfigHash = existingConfigHash === expectedConfigHash || legacyConfigHashes.has(existingConfigHash || "");
    if (dockerContainerMountValid(server, existing) && compatibleConfigHash && existing.Config?.OpenStdin && existing.Config?.AttachStdin) {
      return;
    }
    networkingConfig = minecraftContainerNetworkingConfig(existing) ?? networkingConfig;
    logWarn(serverLogFields(server), "Removing managed Docker container with stale runtime configuration");
    await removeDockerContainer(server);
  }
  const runtime = runtimeTarget(server);
  if (!serverDockerMountSource(server) || !runtime.serverJar) {
    throw new Error("Docker managed control requires Docker mount source and server jar filename");
  }

  const startedAt = Date.now();
  const image = validateDockerImageName(server.dockerImage || defaultDockerImageForMinecraftVersion(runtimeTarget(server).minecraftVersion));
  await ensureDockerImage(image);
  const { exposedPorts, portBindings } = parseDockerPorts(server.dockerPorts || "25565:25565/tcp");
  const javaArgs = validateJavaArgs(server.javaArgs || "-Xms2G -Xmx4G");
  const quotedServerJar = shellQuote(runtime.serverJar);
  const command = `test -f ${quotedServerJar} || { echo "serverSENTINEL could not find ${runtime.serverJar} in $(pwd)" >&2; ls -la >&2; exit 66; }; exec java ${javaArgs} -jar ${quotedServerJar} nogui`;
  const workingDir = serverDockerWorkingDir(server);
  const bindTarget = serverDockerBindTarget(server);

  logInfo({ ...serverLogFields(server), image, workingDir, action: "create_container" }, "Creating Minecraft runtime container");
  try {
    await dockerJsonRequest(
      "POST",
      `/containers/create?name=${encodeURIComponent(dockerContainerName(server))}`,
      {
        Image: image,
        WorkingDir: workingDir,
        Cmd: ["sh", "-lc", command],
        OpenStdin: true,
        StdinOnce: false,
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        ...minecraftTerminalContainerConfig(),
        ExposedPorts: exposedPorts,
        HostConfig: {
          Privileged: false,
          PortBindings: portBindings,
          RestartPolicy: { Name: "no" },
          Mounts: [
            {
              Type: serverDockerMountSource(server) === config.serversDockerVolume ? "volume" : "bind",
              Source: serverDockerMountSource(server),
              Target: bindTarget
            }
          ]
        },
        NetworkingConfig: networkingConfig ?? await currentContainerNetworkingConfig(),
        Labels: managedContainerLabels(server.id, expectedConfigHash)
      },
      [201]
    );
    logInfo({ ...serverLogFields(server), action: "create_container", durationMs: durationSince(startedAt), status: "succeeded" }, "Minecraft runtime container created");
  } catch (error) {
    logError({ ...serverLogFields(server), action: "create_container", durationMs: durationSince(startedAt), status: "failed", ...errorLogFields(error) }, "Docker container creation failed");
    throw error;
  }
}

export async function dockerStatus(server: ManagedServer) {
  if (!dockerControlConfigured(server)) {
    return {
      configured: false,
      available: dockerAvailable(),
      controllable: false,
      state: "unknown" as DockerState,
      message: "No Docker integration is configured for this managed server instance"
    };
  }

  if (!dockerAvailable()) {
    return {
      configured: true,
      available: false,
      controllable: false,
      state: "unknown" as DockerState,
      container: dockerContainerName(server),
      message: "Docker socket is not mounted"
    };
  }

  const details = await inspectDockerContainer(server);
  if (!details) {
    return {
      configured: true,
      available: true,
      controllable: Boolean(server.dockerMountSource && runtimeTarget(server).serverJar),
      state: "unknown" as DockerState,
      container: dockerContainerName(server),
      message: server.dockerMountSource && runtimeTarget(server).serverJar
        ? "Managed container will be created on start"
        : "Configured container does not exist"
    };
  }
  const owned = isManagedContainerFor(details.Config?.Labels, server.id);
  if (owned) await reconcileDockerRestartPolicy(server, details);
  const mountValid = dockerContainerMountValid(server, details);
  return {
    configured: true,
    available: true,
    controllable: owned && mountValid,
    state: details.State?.Status ?? "unknown",
    running: Boolean(details.State?.Running),
    container: dockerContainerName(server),
    name: details.Name?.replace(/^\//, ""),
    message: !owned
      ? isManagedContainer(details.Config?.Labels)
        ? "A same-named Docker container belongs to a different managed server"
        : "A same-named Docker container exists but is not managed by serverSENTINEL"
      : !mountValid
        ? "Managed container has an incompatible server volume mount"
        : undefined
  };
}

export async function dockerAction(server: ManagedServer, action: "start" | "stop" | "restart") {
  const startedAt = Date.now();
  logInfo({ ...serverLogFields(server), action }, "Runtime container action requested");
  if (!dockerControlConfigured(server)) {
    logWarn({ ...serverLogFields(server), action }, "Runtime action rejected because Docker integration is not configured");
    throw new Error("Docker integration is not configured for this managed server instance");
  }
  try {
    if (action === "start" || action === "restart") {
      await ensureDockerContainer(server);
    } else {
      const existing = await inspectDockerContainer(server);
      const refusal = containerOwnershipRefusal(server, existing?.Config?.Labels, "control");
      if (refusal) {
        throw new Error(refusal);
      }
    }
    const requestAction = () => dockerRequest("POST", `/containers/${encodeURIComponent(dockerContainerName(server))}/${action}`, [200, 204, 304]);
    try {
      await requestAction();
    } catch (error) {
      if ((action !== "start" && action !== "restart") || !isMissingDockerNetworkError(error)) throw error;
      const existing = await inspectDockerContainer(server);
      const networkingConfig = minecraftContainerNetworkingConfig(existing, await currentContainerInspect().catch(() => null));
      logWarn({ ...serverLogFields(server), action }, "Recreating managed Docker container after its network attachment became stale");
      await removeManagedDockerContainer(server);
      await ensureDockerContainer(server, networkingConfig);
      await requestAction();
    }
    if (action === "start" || action === "restart") {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const status = await dockerStatus(server);
      if (!status.running) {
        logWarn({ ...serverLogFields(server), action, durationMs: durationSince(startedAt), status: status.state }, "Runtime container exited unexpectedly after action");
        const logs = await dockerRecentLogs(server).catch(() => "");
        throw new Error(summarizeRuntimeExit(action, logs));
      }
      logInfo({ ...serverLogFields(server), action, durationMs: durationSince(startedAt), status: status.state }, "Runtime container action completed");
      return status;
    }
    const status = await dockerStatus(server);
    logInfo({ ...serverLogFields(server), action, durationMs: durationSince(startedAt), status: status.state }, "Runtime container action completed");
    return status;
  } catch (error) {
    logError({ ...serverLogFields(server), action, durationMs: durationSince(startedAt), status: "failed", ...errorLogFields(error) }, "Runtime container action failed");
    throw error;
  }
}

export async function dockerCommandInputCapability(server: ManagedServer, currentStatus?: Awaited<ReturnType<typeof dockerStatus>>) {
  if (!dockerControlConfigured(server) || !dockerAvailable()) {
    return {
      available: false,
      message: "Console command input requires Docker integration and a mounted Docker socket"
    };
  }

  const status = currentStatus ?? await dockerStatus(server);
  if (!status.running) {
    return {
      available: false,
      message: "Start the runtime container before sending console commands"
    };
  }

  const details = await inspectDockerContainer(server);
  if (!details) {
    return {
      available: false,
      message: "Runtime container was not found"
    };
  }

  if (!isManagedContainerFor(details.Config?.Labels, server.id)) {
    return {
      available: false,
      message: isManagedContainer(details.Config?.Labels)
        ? "This container belongs to a different managed server and console command input is disabled"
        : "Console command input is best-effort only for non-managed containers and is disabled"
    };
  }

  if (!details.Config?.OpenStdin || !details.Config.AttachStdin) {
    return {
      available: false,
      message: "Runtime container was not created with reliable stdin settings"
    };
  }

  return {
    available: true,
    message: "Console command input is available for this managed runtime container"
  };
}

export async function sendDockerStdinCommand(server: ManagedServer, command: string) {
  if (!dockerControlConfigured(server)) {
    throw new Error("Command input is not configured for this server");
  }
  if (!dockerAvailable()) {
    throw new Error("Docker integration is not configured; mount /var/run/docker.sock to enable console input");
  }

  const status = await dockerStatus(server);
  if (!status.running) {
    throw new Error("The Minecraft runtime container must be running before commands can be sent");
  }
  const capability = await dockerCommandInputCapability(server, status);
  if (!capability.available) {
    throw new Error(capability.message);
  }

  const line = command.trim();
  if (!line) {
    throw new Error("Command is required");
  }
  if (/\r|\n/.test(line)) {
    throw new Error("Only one console command can be sent at a time");
  }

  await sendDockerContainerStdinLine(dockerContainerName(server), line, { timeoutMs: 5000 });
  return { ok: true };
}

export async function dockerRecentLogs(server: ManagedServer, lineLimit = 200) {
  if (!dockerControlConfigured(server)) {
    throw new Error("Console logs are not configured for this managed server instance");
  }
  const tail = consoleLogLineLimit(lineLimit, 200);
  const response = await dockerBufferRequest(
    "GET",
    `/containers/${encodeURIComponent(dockerContainerName(server))}/logs?stdout=1&stderr=1&tail=${tail}`,
    200,
    15000,
    undefined,
    dockerLogTailMaxBytes
  );
  return stripDockerLogHeaders(response).toString("utf8");
}

export async function dockerResourceStats(server: ManagedServer) {
  if (!dockerControlConfigured(server)) {
    return {
      available: false,
      running: false,
      cpuPercent: 0,
      memoryUsageBytes: 0,
      memoryLimitBytes: 0,
      readAt: new Date().toISOString(),
      message: "Docker container stats are not configured for this server"
    };
  }
  const status = await dockerStatus(server);
  if (!status.running) {
    return {
      available: false,
      running: false,
      cpuPercent: 0,
      memoryUsageBytes: 0,
      memoryLimitBytes: 0,
      readAt: new Date().toISOString(),
      container: dockerContainerName(server),
      message: status.message || "Container is not running"
    };
  }

  let stats: DockerStats;
  try {
    stats = await dockerRequest<DockerStats>(
      "GET",
      `/containers/${encodeURIComponent(dockerContainerName(server))}/stats?stream=false`,
      200
    );
  } catch (error) {
    return {
      available: false,
      running: true,
      cpuPercent: 0,
      memoryUsageBytes: 0,
      memoryLimitBytes: 0,
      readAt: new Date().toISOString(),
      container: dockerContainerName(server),
      message: (error as Error).message || "Docker stats are unavailable"
    };
  }
  return {
    available: true,
    running: true,
    ...computeContainerResourceSample(stats),
    container: dockerContainerName(server)
  };
}

export function readFileRange(filePath: string, start: number, end: number) {
  return new Promise<Buffer>((resolveRead, rejectRead) => {
    const chunks: Buffer[] = [];
    const stream = createReadStream(filePath, { start, end });
    stream.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.on("error", rejectRead);
    stream.on("end", () => resolveRead(Buffer.concat(chunks)));
  });
}

export async function readLatestServerLog(server: ManagedServer, lineLimit?: number) {
  const logPath = await validateExistingInsideServer(server, "logs/latest.log");
  if (lineLimit !== undefined) return readConsoleLogTail(logPath, lineLimit);
  const logStat = await stat(logPath);
  if (!logStat.isFile()) {
    throw new Error("logs/latest.log is not a file");
  }
  if (logStat.size === 0) {
    return "";
  }

  const start = Math.max(0, logStat.size - 128 * 1024);
  return (await readFileRange(logPath, start, logStat.size - 1)).toString("utf8");
}

export async function updateServerProperties(server: ManagedServer, updates: Record<string, string>) {
  const path = ensureInsideServer(server, "server.properties");
  let values: Record<string, string> = {};
  try {
    values = parseServerProperties(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeFile(path, serializeServerProperties({ ...values, ...updates }), "utf8");
}

export function normalizeJavaRuntime(server: ManagedServer) {
  const image = server.dockerImage || "";
  if (/temurin/i.test(image)) {
    const version = image.match(/temurin:([^,\s]+)/i)?.[1];
    return version ? `Temurin ${version.replace(/-jre$/i, "")}` : "Temurin";
  }
  if (/java/i.test(image) || /jdk|jre/i.test(image)) return image;
  const runtime = runtimeProfileForServer(server);
  if (runtime.javaMajorVersion) return `Java ${runtime.javaMajorVersion}`;
  return undefined;
}

export function configuredServerPort(server: ManagedServer, props: Record<string, string>) {
  if (props["server-port"]) return props["server-port"];
  const tcpPort = dockerHostPortBindings(server.dockerPorts || "25565:25565/tcp").find((port) => port.protocol === "tcp");
  return tcpPort?.port || "25565";
}

export function validDockerTimestamp(value?: string) {
  return value && !value.startsWith("0001-") ? value : undefined;
}
