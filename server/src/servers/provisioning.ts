import { existsSync } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { serverRuntimeDefinition } from "@serversentinel/contracts";
import { config } from "../config.js";
import { runtimeForNodeId, runtimeForServer, services } from "../appServices.js";
import { appUserAgentFor } from "../buildInfo.js";
import { detailedError, detailedErrorMessage, durationSince, errorLogFields, logError, logInfo, logWarn } from "../logging.js";
import { validateDockerContainerName, validateDockerImageName, validateJavaArgs } from "../http/validation.js";
import { dockerAvailable } from "../docker/dockerClient.js";
import { defaultServerJarProvider } from "../runtime/serverJarProvider.js";
import { assertRuntimeArtifactUrl, maxRuntimeArtifactBytes, readRuntimeArtifact, verifyRuntimeArtifact } from "../runtime/artifact.js";
import { runtimeProfileForServer, type ServerJarProvider } from "../runtime/profile.js";
import { runtimeSelection } from "../runtime/selection.js";
import { defaultDockerImageForMinecraftVersion, ensureDockerContainer, removeManagedDockerContainer, serverLogFields, updateServerProperties } from "../runtime/local/dockerContainers.js";

import { ensureInsideServer } from "../core.js";
import { newServerId, serverDirectory, serverStorageName, defaultServerContainerName } from "../storage/serverIdentity.js";
import { requiredString } from "../storage/valueValidation.js";
import { activeProvisionPortReservations, assertNodePortsAvailable, normalizeCreateServerPorts, type CreateServerInput } from "./ports.js";
import { localNodeId } from "../nodes/nodeService.js";
import { listManagedServers } from "./store.js";
import { writeVersionMetadataFile } from "./versions.js";
import type { ManagedServer, ServerRuntimeProfile, ServerRuntimeType } from "../types.js";

export const serverJarProvider: ServerJarProvider = defaultServerJarProvider;

export function parseServerRuntimeType(value: unknown, field = "runtimeType"): ServerRuntimeType {
  const runtimeType = requiredString(value, field);
  if (runtimeType !== "fabric" && runtimeType !== "paper") {
    throw new Error(`${field} must be fabric or paper`);
  }
  return runtimeType;
}

export async function downloadServerJar(server: ManagedServer) {
  const profile = runtimeProfileForServer(server);
  const runtime = serverRuntimeDefinition(profile.runtimeType);
  const artifact = profile?.jarArtifact;
  const downloadUrl = artifact?.downloadUrl;
  const filename = artifact?.filename;
  if (!profile || !filename) {
    throw new Error(`A resolved ${runtime.displayName} runtime profile is required before downloading the server jar`);
  }
  if (!downloadUrl) {
    throw new Error(`The runtime profile does not include a ${runtime.displayName} server jar download URL`);
  }
  const safeDownloadUrl = assertRuntimeArtifactUrl(profile, config.mcjarsBaseUrl);

  const target = ensureInsideServer(server, filename);
  const startedAt = Date.now();
  logInfo({ ...serverLogFields(server), runtimeType: profile.runtimeType, minecraftVersion: profile.minecraftVersion, runtimeVersion: profile.runtimeVersion, jarProvider: profile.jarProvider, filename }, `Downloading ${runtime.displayName} server runtime`);
  const response = await fetch(safeDownloadUrl, {
    headers: {
      "User-Agent": appUserAgentFor(`${runtime.displayName} runtime downloader`)
    },
    signal: AbortSignal.timeout(60_000),
    redirect: "error"
  });
  if (!response.ok || !response.body) {
    const body = !response.ok ? await response.text().catch(() => "") : "";
    const details = `${runtime.displayName} server runtime download failed\nurl=${downloadUrl}\nstatus=${response.status} ${response.statusText}\nbody=${body || "(empty)"}`;
    const error = detailedError(new Error(`${runtime.displayName} server download failed: ${response.status} ${response.statusText}`), details);
    logError({ ...serverLogFields(server), runtimeType: profile.runtimeType, downloadUrl, statusCode: response.status, responseBody: body || undefined, errorDetails: details, durationMs: durationSince(startedAt) }, `${runtime.displayName} server runtime download failed`);
    throw error;
  }
  const declaredSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > maxRuntimeArtifactBytes) {
    throw new Error(`Downloaded ${runtime.displayName} server artifact exceeds ${Math.floor(maxRuntimeArtifactBytes / 1024 / 1024)} MiB`);
  }
  const content = await readRuntimeArtifact(response);
  verifyRuntimeArtifact(profile, content);
  await writeFile(target, content);
  const downloaded = await stat(target);
  if (!downloaded.isFile() || downloaded.size === 0) {
    throw new Error(`${runtime.displayName} server download did not produce a runnable jar`);
  }
  logInfo({ ...serverLogFields(server), runtimeType: profile.runtimeType, filename, size: downloaded.size, durationMs: durationSince(startedAt) }, `${runtime.displayName} server runtime downloaded`);
}

export async function createServerFiles(
  server: ManagedServer,
  acceptEula: boolean,
  serverPort: string,
  queryPort: number,
  report?: (progress: number, task: string) => void
) {
  report?.(35, "Creating server folders");
  await mkdir(server.serverDir, { recursive: true });
  const runtime = serverRuntimeDefinition(server.runtimeProfile.runtimeType);
  await mkdir(ensureInsideServer(server, runtime.contentDirectory), { recursive: true });
  await mkdir(ensureInsideServer(server, "logs"), { recursive: true });
  logInfo(serverLogFields(server), "Managed server files created");
  report?.(45, `Downloading ${runtime.displayName} server runtime`);
  await downloadServerJar(server);
  report?.(65, "Writing Minecraft configuration");
  await updateServerProperties(server, {
    "server-port": serverPort,
    "enable-query": "true",
    "query.port": String(queryPort)
  });
  await writeFile(ensureInsideServer(server, "eula.txt"), `# Managed by serverSENTINEL\n# Only set true if you accept the Minecraft EULA.\neula=${acceptEula ? "true" : "false"}\n`, "utf8");
  await writeVersionMetadataFile(server);
  await writeFile(ensureInsideServer(server, "logs/latest.log"), "", { flag: "a" });
}

export async function createManagedServer(input: CreateServerInput, report?: (progress: number, task: string) => void, jobId?: string) {
  if ((input.nodeId ?? localNodeId) !== localNodeId) {
    throw new Error("Remote server provisioning requires a connected node agent. Select a connected node or use all-in-one mode for local servers.");
  }
  const startedAt = Date.now();
  report?.(5, "Validating server settings");
  const displayName = input.displayName?.trim();
  const selectedRuntime = runtimeSelection(input.runtime);
  const runtimeDefinition = serverRuntimeDefinition(selectedRuntime.runtimeType);
  if (!runtimeDefinition.managedProvisioning) {
    throw new Error(`${runtimeDefinition.displayName} provisioning is not available yet. Existing profiles can be imported for lifecycle compatibility, but new servers cannot be created with this runtime.`);
  }
  const minecraftVersion = selectedRuntime.minecraftVersion;
  if (!displayName || displayName.length > 80 || !minecraftVersion) {
    throw new Error("Display name and Minecraft version are required");
  }
  if (input.acceptEula !== true) {
    throw new Error("You must confirm Minecraft EULA acceptance to create a runnable server");
  }
  if ((await listManagedServers()).some((server) => server.displayName.toLowerCase() === displayName.toLowerCase())) {
    throw new Error("A managed server with this display name already exists");
  }

  report?.(15, "Reserving server storage");
  await mkdir(config.serversDir, { recursive: true });
  const id = newServerId();
  const storageName = serverStorageName(id);
  const resolvedServerDir = serverDirectory(config.serversDir, id);
  if (existsSync(resolvedServerDir)) {
    throw new Error("Generated server id already has a storage directory");
  }

  report?.(25, `Resolving ${runtimeDefinition.displayName} versions`);
  const runtimeProfile = await serverJarProvider.resolveServerJar({
    runtimeType: selectedRuntime.runtimeType,
    minecraftVersion,
    runtimeVersion: selectedRuntime.runtimeVersion || "latest",
    preferStable: true
  });
  const serverJar = selectedRuntime.serverJar || runtimeProfile.jarArtifact.filename;
  const runtimeProfileForRecord: ServerRuntimeProfile = {
    ...runtimeProfile,
    jarArtifact: {
      ...runtimeProfile.jarArtifact,
      filename: serverJar
    }
  };
  const existingServers = await listManagedServers();
  const { serverPort, dockerPorts, queryPort, managedPorts } = normalizeCreateServerPorts(input, existingServers, localNodeId, { ignoreJobId: jobId });
  assertNodePortsAvailable(existingServers, localNodeId, dockerPorts, { ignoreJobId: jobId });
  const dockerContainer = validateDockerContainerName(input.dockerContainer?.trim() || defaultServerContainerName(id));
  const dockerImage = validateDockerImageName(input.dockerImage?.trim() || defaultDockerImageForMinecraftVersion(runtimeProfileForRecord.minecraftVersion));
  const javaArgs = validateJavaArgs(input.javaArgs?.trim() || "-Xms2G -Xmx4G");

  const now = new Date().toISOString();
  const server: ManagedServer = {
    id,
    nodeId: localNodeId,
    displayName,
    serverDir: resolvedServerDir,
    storageName,
    runtimeProfile: runtimeProfileForRecord,
    dockerContainer,
    dockerImage,
    dockerMountSource: config.serversDockerVolume || resolvedServerDir,
    dockerWorkingDir: config.serversDockerVolume ? `/data/servers/${storageName}` : undefined,
    dockerPorts,
    managedPorts,
    javaArgs,
    createdAt: now,
    updatedAt: now
  };

  logInfo({ ...serverLogFields(server), jobId, runtimeType: runtimeProfileForRecord.runtimeType, minecraftVersion: runtimeProfileForRecord.minecraftVersion, runtimeVersion: runtimeProfileForRecord.runtimeVersion, jarProvider: runtimeProfileForRecord.jarProvider }, `${runtimeDefinition.displayName} runtime profile resolved for provisioning`);
  let saved = false;
  try {
    await createServerFiles(server, input.acceptEula, serverPort, queryPort, report);
    if (dockerAvailable()) {
      report?.(78, "Pulling runtime image and creating Docker container");
      await ensureDockerContainer(server);
    } else {
      report?.(78, "Runtime management unavailable; Docker socket is not mounted");
      logWarn({ ...serverLogFields(server), jobId }, "Docker socket is not mounted during provisioning");
    }

    report?.(92, "Saving server registration");
    services.serversRepository.create(server);
    saved = true;
    report?.(100, "Server setup complete");
    logInfo({ ...serverLogFields(server), jobId, durationMs: durationSince(startedAt), status: "succeeded" }, "Provisioning succeeded");
    return server;
  } catch (error) {
    if (!saved) {
      await removeManagedDockerContainer(server).catch(() => undefined);
      await rm(server.serverDir, { recursive: true, force: true }).catch(() => undefined);
    }
    logError({ ...serverLogFields(server), jobId, durationMs: durationSince(startedAt), status: "failed", ...errorLogFields(error) }, "Provisioning failed");
    throw error;
  }
}

export async function startProvisionOperation(input: CreateServerInput, createdBy: string) {
  const nodeId = input.nodeId?.trim() || (config.runtimeMode === "all-in-one" ? localNodeId : "");
  if (!nodeId) {
    throw new Error("nodeId is required when serverSENTINEL runs in panel mode");
  }
  const existingServers = await listManagedServers();
  const { dockerPorts, queryPort } = normalizeCreateServerPorts(input, existingServers, nodeId);
  assertNodePortsAvailable(existingServers, nodeId, dockerPorts);
  input.dockerPorts = dockerPorts;
  input.queryPort = String(queryPort);
  return services.operationService.enqueue<ManagedServer>({
    type: "server.create",
    nodeId,
    createdBy,
    task: "Queued server setup",
    runningTask: "Queued server setup",
    successTask: "Server setup complete",
    failureTask: "Server setup failed",
    failureFallback: "Server setup failed",
    serverIdFromResult: (server) => server.id,
    result: async (server) => ({ server: await runtimeForServer(server).publicServer(server) }),
    onStarted: (operation) => {
      activeProvisionPortReservations.set(operation.id, {
        nodeId,
        dockerPorts,
        displayName: input.displayName?.trim() || "unnamed server"
      });
      logInfo({ operationId: operation.id, serverName: input.displayName?.trim() }, "Provisioning operation started");
    },
    onError: (error, operation) => {
      logError({ operationId: operation.id, nodeId, serverName: input.displayName?.trim(), errorDetails: detailedErrorMessage(error), ...errorLogFields(error) }, "Provisioning operation failed");
    },
    onSettled: (operation) => { activeProvisionPortReservations.delete(operation.id); }
  }, (operation, report) => runtimeForNodeId(nodeId).createServer({ ...input, nodeId }, report, operation.id));
}
