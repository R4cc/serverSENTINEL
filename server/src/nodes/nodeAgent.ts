import { existsSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, posix, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import http from "node:http";
import WebSocket from "ws";
import { defaultDockerImageForMinecraftVersion, EXPORT_ARTIFACT_TYPE, EXPORT_MANIFEST_ENTRY, EXPORT_SCHEMA_VERSION, serverRuntimeDefinition, type NodeUpdateFailure, type NodeUpdateFailureStage } from "@serversentinel/contracts";
import { config, maxServerPort, minServerPort } from "../config.js";
import { containerConfigHash, isManagedContainerFor, managedContainerLabels } from "../runtime/containerLabels.js";
import { computeContainerResourceSample, type DockerStatsSample } from "../runtime/containerStats.js";
import { isValidServerPort, queryPortEntry } from "../servers/ports.js";
import { planServerUpdate } from "../servers/serverUpdatePlan.js";
import { storageSpaceForPath } from "../servers/storageSpace.js";
import { mutableServerConfigurationBlockedReason } from "../servers/mutableConfigurationGate.js";
import { appBuildId, appUserAgentFor, appVersion } from "../buildInfo.js";
import { consoleLogLineLimit, readConsoleLogTail } from "../consoleLogs.js";
import { ensureInsideServer, ensureWritableInsideServer, ensureWritableResolvedInsideServer, openContainedReadStream, parseDockerPorts, safeInstalledModFilename, safeModFilename, validateExistingInsideServer } from "../core.js";
import { dockerAvailable, dockerBufferRequest, dockerErrorMessage, dockerJsonRequest, dockerLogTailMaxBytes, dockerReachable, dockerRequest, isMissingDockerNetworkError, sendDockerContainerStdinLine } from "../docker/dockerClient.js";
import { dockerLiveRestoreEnabled, dockerLiveRestoreGuidance, dockerStopQuery, dockerStopRequestTimeoutMs } from "../docker/dockerDaemon.js";
import { DockerLogDecoder, stripDockerLogHeaders } from "../docker/dockerLogs.js";
import { javaArgsToArgv, requireStrictBoolean, validateDockerContainerName, validateDockerImageName, validateJavaArgs, validateModrinthProjectId, validateModrinthVersionId, validateRuntimeJarFilename } from "../http/validation.js";
import { fetchProject, fetchProjectVersions, resolveModrinthProjectCompatibility, resolveSelectedProjectVersion, versionChannel } from "../modrinth/compatibility.js";
import {
  assertDownloadableModrinthFile,
  assertModrinthJarHashes,
  assertVersionInstallable,
  compatibilityFromSelectedVersion,
  managedContentNaming
} from "../modrinth/installPolicy.js";
import { modrinthFetch } from "../modrinth/modrinthClient.js";
import { ModHashCache } from "../modHashCache.js";
import { managedContentFileSizeLimit } from "../managedContentLimits.js";
import { registerShutdownHandlers } from "../shutdown.js";
import { defaultServerJarProvider } from "../runtime/serverJarProvider.js";
import { assertRuntimeArtifactUrl, maxRuntimeArtifactBytes, readRuntimeArtifact, verifyRuntimeArtifact } from "../runtime/artifact.js";
import {
  copyServerFile,
  createServerFolder,
  deleteServerEntry,
  editorFileSizeLimit,
  fileUploadSizeLimit,
  listServerDirectory,
  moveServerEntry,
  previewServerFile,
  publicZipExtractionPlan,
  readServerTextFile,
  renameServerEntry,
  safeFileManagerName,
  toPublicServerPath,
  writeServerTextFile
} from "../runtime/local/fileService.js";
import { detectedTotalMemory, minecraftContainerNetworkingConfig } from "../runtime/local/dockerContainers.js";
import { detailedError, detailedErrorMessage } from "../logging.js";
import { runtimeProfileForServer, runtimeTarget } from "../runtime/profile.js";
import { runtimeSelection } from "../runtime/selection.js";
import { minecraftTerminalConfigFingerprint, minecraftTerminalContainerConfig } from "../runtime/terminal.js";
import { parseServerProperties, serializeServerProperties } from "../runtime/serverProperties.js";
import type { ManagedServer, ReleaseChannel, ServerRuntimeProfile } from "../types.js";
import { resolveMinecraftQueryEndpoints } from "../queryEndpoint.js";
import { readMinecraftPlayerObservation } from "../playerObservationReader.js";
import { decodeTransferChunk, encodeTransferChunk, isNodeCapability, nodeCapabilities, nodeFeatures, nodeProtocolControlMessageMaxBytes, nodeProtocolMaxActiveRequests, nodeProtocolMaxActiveStreams, nodeProtocolMaxActiveTransfers, nodeProtocolTransferChunkBytes, nodeProtocolVersion, normalizeNodeUpdateFailure, normalizePanelToNodeMessage, normalizeServerObservationRequest } from "./protocol.js";
import type { NodeCancelMessage, NodeHello, NodeRequestMessage, NodeResponseMessage, NodeStreamDataMessage, NodeStreamEndMessage, NodeStreamStartMessage, NodeStreamStopMessage, NodeTransferCancelMessage, NodeTransferFinishMessage, NodeTransferResultMessage, NodeTransferStartMessage, PanelWelcome, ServerLogCursor, ServerObservationItem, ServerObservationResponse, ServerObservationResultItem, ServerObservationSection } from "./protocol.js";
import { openStorageDatabase, type StorageDatabase } from "../storage/database.js";
import { initializeRuntimeDataRoot } from "../storage/runtimePaths.js";
import { defaultServerContainerName, newServerId, serverDirectory, serverStorageName } from "../storage/serverIdentity.js";
import { extractZipArchive, planZipExtraction, type ZipExtractionPlan } from "../zipArchive.js";
import { createZipArchiveStream, safeArchiveFilename, type FileArchiveEntry } from "../downloadArchive.js";
import { exportArchiveCompressionLevel } from "../exportCompression.js";

type NodeIdentity = { nodeId: string; nodeSecret: string };
const modHashCache = new ModHashCache();
type NodeUpdateRequest = {
  image?: string;
};
type NodeContainerInspect = {
  Id: string;
  Name?: string;
  /** The image id the container was created from, which is what its inherited config came from. */
  Image?: string;
  State?: { Status?: string; Running?: boolean; ExitCode?: number; OOMKilled?: boolean; StartedAt?: string; FinishedAt?: string; Health?: { Status?: string } };
  Config?: Record<string, unknown> & {
    Image?: string;
    Env?: string[];
    Labels?: Record<string, string>;
    OpenStdin?: boolean;
    AttachStdin?: boolean;
  };
  HostConfig?: Record<string, unknown> & { RestartPolicy?: { Name?: string } };
  NetworkSettings?: {
    Networks?: Record<string, NodeNetworkAttachment>;
  };
};

type NodeNetworkAttachment = {
  IPAMConfig?: unknown;
  Aliases?: string[];
  DriverOpts?: Record<string, string>;
  NetworkID?: string;
  EndpointID?: string;
  Gateway?: string;
  IPAddress?: string;
  IPPrefixLen?: number;
  IPv6Gateway?: string;
  GlobalIPv6Address?: string;
  GlobalIPv6PrefixLen?: number;
  MacAddress?: string;
};

type NodeNetworkingConfig = {
  EndpointsConfig: Record<string, { IPAMConfig?: unknown; Aliases?: string[]; DriverOpts?: Record<string, string> }>;
};
type DockerContainerListItem = {
  Id: string;
  Names?: string[];
  State?: string;
  Status?: string;
};
type CreateInput = {
  nodeId?: string;
  displayName?: string;
  runtime?: {
    runtimeType?: string;
    runtimeVersion?: string;
    minecraftVersion?: string;
    serverJar?: string;
  };
  dockerContainer?: string;
  dockerImage?: string;
  dockerPorts?: string;
  queryPort?: string;
  javaArgs?: string;
  startOnNodeStart?: boolean;
  acceptEula?: boolean;
  serverPort?: string;
};
type UpdateInput = Omit<CreateInput, "nodeId" | "acceptEula">;

const nodeIdentityMetadataKey = "node.identity";
const nodeUpdateFailureMetadataKey = "node.update.failure";
const nodeUpdateDir = config.paths.nodeUpdatesDir;
const serversRoot = resolve(config.nodeDataDir, "servers");
const uploadLimit = managedContentFileSizeLimit;
const recentLogTailBytes = 128 * 1024;
const zipLimits = { maxEntries: config.fileZipMaxEntries, maxExpandedBytes: config.fileZipMaxExpandedBytes };
const reconnectBaseDelayMs = 1000;
const reconnectMaxDelayMs = 30_000;
const panelHeartbeatTimeoutMs = 45_000;

export function nodeReconnectDelayMs(attempt: number, random = Math.random) {
  const ceiling = Math.min(reconnectMaxDelayMs, reconnectBaseDelayMs * (2 ** Math.min(Math.max(0, attempt), 5)));
  return Math.round(reconnectBaseDelayMs + (ceiling - reconnectBaseDelayMs) * Math.min(1, Math.max(0, random())));
}
const removablePreviousNodeStates = new Set(["created", "dead", "exited", "removing"]);

let nodeStorageDatabase: StorageDatabase | undefined;
let nodeUpdateInProgress = false;
/**
 * Set by the running agent so a failed self-update can hand its report to the panel immediately.
 * The panel marks a node offline the moment an update starts and then waits for it to come back, so
 * a node that stays on its original session after a failure would sit there looking offline.
 */
let reconnectToPanel: ((reason: string) => void) | undefined;

function nodeStorage() {
  nodeStorageDatabase ??= openStorageDatabase();
  return nodeStorageDatabase;
}

function parseNodeIdentity(value: string): NodeIdentity {
  const parsed = JSON.parse(value) as Partial<NodeIdentity>;
  if (typeof parsed.nodeId !== "string" || typeof parsed.nodeSecret !== "string") {
    throw new Error("Stored node identity is invalid");
  }
  return { nodeId: parsed.nodeId, nodeSecret: parsed.nodeSecret };
}

/**
 * The node's own record of an update that did not finish. It is persisted because the report has to
 * survive the agent restart that recovery can involve, and it is cleared as soon as the panel has
 * accepted a session carrying it.
 */
function readStoredNodeUpdateFailure(): NodeUpdateFailure | undefined {
  const value = nodeStorage().metadata(nodeUpdateFailureMetadataKey);
  return value === undefined ? undefined : normalizeNodeUpdateFailure(safeJsonParse(value));
}

function safeJsonParse(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function recordNodeUpdateFailure(failure: NodeUpdateFailure) {
  nodeStorage().setMetadata(nodeUpdateFailureMetadataKey, JSON.stringify(failure));
}

function clearStoredNodeUpdateFailure(reportedAt?: string) {
  const stored = readStoredNodeUpdateFailure();
  if (!stored || (reportedAt && stored.at !== reportedAt)) return;
  nodeStorage().setMetadata(nodeUpdateFailureMetadataKey, "");
}

async function readNodeIdentity() {
  const value = nodeStorage().metadata(nodeIdentityMetadataKey);
  return value === undefined ? null : parseNodeIdentity(value);
}

async function writeNodeIdentity(nodeIdentity: NodeIdentity) {
  nodeStorage().setMetadata(nodeIdentityMetadataKey, JSON.stringify(nodeIdentity));
}

function panelWebSocketUrl() {
  if (!config.panelUrl) throw new Error("SS_PANEL_URL is required in SS_MODE=node");
  const url = new URL(config.panelUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/api/nodes/connect";
  url.search = "";
  return url.toString();
}

function safeName(value: unknown) {
  return safeFileManagerName(typeof value === "string" ? value : undefined);
}

function safeRelative(value: unknown) {
  const raw = typeof value === "string" ? value : ".";
  if (raw.includes("\0") || raw.includes("\\") || /[\r\n]/.test(raw) || raw.startsWith("/") || raw.split("/").includes("..")) throw new Error("Invalid relative path");
  if (raw === "" || raw === ".") return ".";
  if (raw.split("/").some((segment) => !segment || segment === ".")) throw new Error("Invalid relative path");
  return raw;
}

async function serverRoot(server: ManagedServer) {
  const id = server.storageName || server.id;
  const root = resolve(serversRoot, id);
  if (root !== serversRoot && !root.startsWith(serversRoot + sep)) throw new Error("Invalid server root");
  await mkdir(root, { recursive: true });
  return root;
}

async function inside(server: ManagedServer, rel: unknown, mustExist = true) {
  const root = await serverRoot(server);
  const path = safeRelative(rel);
  return mustExist ? validateExistingInsideServer({ serverDir: root }, path) : ensureInsideServer({ serverDir: root }, path);
}

async function writableInside(server: ManagedServer, rel: unknown) {
  const root = await serverRoot(server);
  return ensureWritableInsideServer({ serverDir: root }, safeRelative(rel));
}

async function writableResolvedInside(server: ManagedServer, targetPath: string) {
  const root = await serverRoot(server);
  return ensureWritableResolvedInsideServer({ serverDir: root }, targetPath);
}

function publicPath(root: string, target: string) {
  return toPublicServerPath({ serverDir: root }, target);
}

function assertJarBuffer(buffer: Buffer, contentName = "managed-content file") {
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b || ![0x03, 0x05, 0x07].includes(buffer[2])) {
    throw new Error(`Uploaded ${contentName} must be a valid .jar file`);
  }
}

function containerName(server: ManagedServer) {
  return validateDockerContainerName(server.dockerContainer?.trim() || defaultServerContainerName(server.id));
}

function runtimeConfigHashInput(server: ManagedServer, options: { includeTerminal: boolean; includeRestartPolicy: boolean }) {
  const targetRuntime = runtimeTarget(server);
  return {
    image: validateDockerImageName(server.dockerImage || defaultDockerImageForMinecraftVersion(targetRuntime.minecraftVersion)),
    ports: server.dockerPorts || "25565:25565/tcp",
    serverJar: validateRuntimeJarFilename(targetRuntime.serverJar || serverRuntimeDefinition(targetRuntime.runtimeType).serverJarFilename),
    javaArgs: validateJavaArgs(server.javaArgs || "-Xms2G -Xmx4G"),
    timeZone: config.timeZone,
    ...(options.includeTerminal ? { terminal: minecraftTerminalConfigFingerprint() } : {}),
    ...(options.includeRestartPolicy ? { restartPolicy: "no" } : {}),
    // Docker only accepts a stop timeout at create time, so it belongs in the hash: a container
    // built with the old grace period has to be replaced before the new one takes effect.
    stopTimeoutSeconds: config.minecraftStopTimeoutSeconds
  };
}

function runtimeConfigHash(server: ManagedServer, options = { includeTerminal: false, includeRestartPolicy: true }) {
  return createHash("sha256").update(JSON.stringify(runtimeConfigHashInput(server, options))).digest("hex");
}

async function reconcileRestartPolicy(server: ManagedServer, details: NodeContainerInspect) {
  if (!isManagedContainerFor(details.Config?.Labels, server.id)) return;
  const restartPolicy = details.HostConfig?.RestartPolicy?.Name;
  if (!restartPolicy || restartPolicy === "no") return;
  await dockerJsonRequest(
    "POST",
    `/containers/${encodeURIComponent(containerName(server))}/update`,
    { RestartPolicy: { Name: "no" } },
    200
  );
  details.HostConfig = { ...details.HostConfig, RestartPolicy: { Name: "no" } };
}

function minecraftContainerEnvironment() {
  return [...minecraftTerminalContainerConfig().Env, `TZ=${config.timeZone}`];
}

async function dockerServerRoot(server: ManagedServer) {
  const root = await serverRoot(server);
  const rel = relative(config.nodeDataDir, root);
  if (rel.startsWith("..") || rel === ".." || resolve(config.nodeDataDir, rel) !== root) {
    return root;
  }
  return join(config.nodeDockerDataDir, rel);
}

function queryPortFromInput(input: { queryPort?: string; dockerPorts?: string }) {
  if (input.queryPort?.trim() && isValidServerPort(input.queryPort.trim())) return Number(input.queryPort.trim());
  const udpBinding = (input.dockerPorts || "").split(",").map((part) => part.trim()).find((part) => part.endsWith("/udp"));
  const port = udpBinding?.split(":", 1)[0]?.trim();
  return port && isValidServerPort(port) ? Number(port) : 25566;
}

function ensureQueryDockerPort(dockerPorts: string, queryPort: number) {
  const queryKey = `${queryPort}/udp`;
  const ports = new Set(dockerPorts.split(",").map((part) => part.trim()).filter(Boolean));
  const hasQuery = [...ports].some((part) => {
    const [hostPort, target = hostPort] = part.includes(":") ? part.split(":", 2) : [part, part];
    return hostPort === String(queryPort) && target === queryKey;
  });
  if (!hasQuery) ports.add(`${queryPort}:${queryPort}/udp`);
  return [...ports].join(",");
}

async function writeVersionMetadata(server: ManagedServer) {
  const now = new Date().toISOString();
  const targetRuntime = runtimeTarget(server);
  const target = await writableInside(server, ".serversentinel-version.json");
  let createdAt = now;
  try {
    const existing = JSON.parse(await readFile(target, "utf8")) as { createdAt?: string };
    createdAt = existing.createdAt ?? now;
  } catch {
    createdAt = now;
  }
  await writeFile(target, `${JSON.stringify({
    minecraftVersion: targetRuntime.minecraftVersion,
    runtimeType: targetRuntime.runtimeType,
    runtimeVersion: targetRuntime.runtimeVersion,
    createdAt,
    updatedAt: now
  }, null, 2)}\n`, "utf8");
}

async function pullImage(image: string) {
  validateDockerImageName(image);
  const [fromImage, tag] = image.includes(":") ? image.split(/:(.*)/, 2) : [image, "latest"];
  await dockerBufferRequest("POST", `/images/create?fromImage=${encodeURIComponent(fromImage)}&tag=${encodeURIComponent(tag || "latest")}`, [200, 201]);
}

async function createContainer(server: ManagedServer, networkingConfig?: NodeNetworkingConfig) {
  const targetRuntime = runtimeTarget(server);
  const image = validateDockerImageName(server.dockerImage || defaultDockerImageForMinecraftVersion(targetRuntime.minecraftVersion));
  await pullImage(image);
  const root = await dockerServerRoot(server);
  const binds = [`${root}:/data`];
  const { exposedPorts, portBindings } = parseDockerPorts(server.dockerPorts ?? "25565:25565/tcp");
  const command = minecraftContainerCommand(server);
  const terminalConfig = minecraftTerminalContainerConfig();
  await dockerJsonRequest("POST", `/containers/create?name=${encodeURIComponent(validateDockerContainerName(containerName(server)))}`, {
    Image: image,
    WorkingDir: "/data",
    Cmd: command,
    OpenStdin: true,
    AttachStdin: true,
    // Applies to every stop this container ever receives, including the one the daemon issues to
    // all containers when Docker itself is restarted or upgraded, which the node agent never sees.
    StopTimeout: config.minecraftStopTimeoutSeconds,
    ...terminalConfig,
    Env: minecraftContainerEnvironment(),
    ExposedPorts: exposedPorts,
    HostConfig: { Binds: binds, PortBindings: portBindings, RestartPolicy: { Name: "no" } },
    NetworkingConfig: networkingConfig ?? minecraftContainerNetworkingConfig(await inspectCurrentContainer().catch(() => null)),
    Labels: managedContainerLabels(server.id, runtimeConfigHash(server))
  }, [201, 409]);
}

function minecraftContainerCommand(server: ManagedServer) {
  const targetRuntime = runtimeTarget(server);
  const serverJar = validateRuntimeJarFilename(targetRuntime.serverJar ?? serverRuntimeDefinition(targetRuntime.runtimeType).serverJarFilename);
  return [
    "sh",
    "-c",
    "server_jar=$1; shift; if [ ! -f \"$server_jar\" ]; then printf '%s\\n' \"serverSENTINEL could not find $server_jar in $(pwd)\" >&2; ls -la >&2; exit 66; fi; exec java \"$@\" -jar \"$server_jar\" nogui",
    "serversentinel-entrypoint",
    serverJar,
    ...javaArgsToArgv(server.javaArgs ?? "-Xms2G -Xmx4G")
  ];
}

async function removeManagedContainer(server: ManagedServer) {
  let details: NodeContainerInspect | null;
  try {
    details = await inspect(server) as NodeContainerInspect;
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("No such container") || message.includes("404")) return false;
    throw error;
  }
  if (!details) return false;
  if (!isManagedContainerFor(details.Config?.Labels, server.id)) {
    throw new Error(`Container ${containerName(server)} exists but is not managed by serverSENTINEL; refusing to delete it`);
  }
  await dockerRequest("DELETE", `/containers/${encodeURIComponent(containerName(server))}?force=1`, [204, 404]);
  return true;
}

async function ensureContainer(server: ManagedServer, preferredNetworkingConfig?: NodeNetworkingConfig) {
  const details = await inspect(server).catch(() => null) as NodeContainerInspect | null;
  if (!details) {
    await createContainer(server, preferredNetworkingConfig);
    return;
  }
  if (!isManagedContainerFor(details.Config?.Labels, server.id)) {
    throw new Error(`Container ${containerName(server)} exists but is not managed by serverSENTINEL; refusing to control it`);
  }
  await reconcileRestartPolicy(server, details);
  const configHash = containerConfigHash(details.Config?.Labels);
  const compatibleConfigHash = configHash === runtimeConfigHash(server)
    || configHash === runtimeConfigHash(server, { includeTerminal: false, includeRestartPolicy: false })
    || configHash === runtimeConfigHash(server, { includeTerminal: true, includeRestartPolicy: false });
  if (!compatibleConfigHash || !details.Config?.OpenStdin || !details.Config?.AttachStdin) {
    const networkingConfig = minecraftContainerNetworkingConfig(details) ?? preferredNetworkingConfig;
    await removeManagedContainer(server);
    await createContainer(server, networkingConfig);
  }
}

async function recreateContainerAfterMissingNetwork(server: ManagedServer) {
  const details = await inspect(server).catch(() => null) as NodeContainerInspect | null;
  const networkingConfig = minecraftContainerNetworkingConfig(details, await inspectCurrentContainer().catch(() => null));
  await removeManagedContainer(server);
  await createContainer(server, networkingConfig);
}

async function requestContainerLifecycleAction(server: ManagedServer, action: "start" | "restart", signal?: AbortSignal) {
  const name = encodeURIComponent(containerName(server));
  const path = action === "start" ? `/containers/${name}/start` : `/containers/${name}/restart${dockerStopQuery()}`;
  const expectedStatus = action === "start" ? [204, 304] : 204;
  const timeoutMs = action === "start" ? undefined : dockerStopRequestTimeoutMs();
  const request = () => dockerRequest("POST", path, expectedStatus, signal, timeoutMs);
  signal?.throwIfAborted();
  try {
    await request();
  } catch (error) {
    if (!isMissingDockerNetworkError(error)) throw error;
    signal?.throwIfAborted();
    await recreateContainerAfterMissingNetwork(server);
    signal?.throwIfAborted();
    await request();
  }
}

async function downloadServerJar(server: ManagedServer, signal?: AbortSignal) {
  const profile = runtimeProfileForServer(server);
  const runtime = serverRuntimeDefinition(profile.runtimeType);
  const artifact = profile?.jarArtifact;
  if (!artifact?.downloadUrl) throw new Error(`A resolved ${runtime.displayName} runtime profile is required before downloading the server jar`);
  const safeDownloadUrl = assertRuntimeArtifactUrl(profile, config.mcjarsBaseUrl);
  const res = await fetch(safeDownloadUrl, {
    headers: { "User-Agent": appUserAgentFor(`node ${runtime.displayName} runtime downloader`) },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
    redirect: "error"
  });
  if (!res.ok || !res.body) {
    const body = !res.ok ? await res.text().catch(() => "") : "";
    const details = `${runtime.displayName} server runtime download failed\nurl=${artifact.downloadUrl}\nstatus=${res.status} ${res.statusText}\nbody=${body || "(empty)"}`;
    console.error(details);
    throw detailedError(new Error(`${runtime.displayName} server download failed: ${res.status} ${res.statusText}`), details);
  }
  const declaredSize = Number(res.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > maxRuntimeArtifactBytes) {
    throw new Error(`Downloaded ${runtime.displayName} server artifact exceeds ${Math.floor(maxRuntimeArtifactBytes / 1024 / 1024)} MiB`);
  }
  const content = await readRuntimeArtifact(res);
  verifyRuntimeArtifact(profile, content);
  const target = await writableInside(server, artifact.filename);
  await writeFile(target, content);
}

function createdServerRecord(input: CreateInput, resolvedRuntime: ServerRuntimeProfile, now = new Date().toISOString()) {
  const displayName = input.displayName?.trim();
  const selectedRuntime = runtimeSelection(input.runtime);
  const runtimeDefinition = serverRuntimeDefinition(selectedRuntime.runtimeType);
  if (!runtimeDefinition.managedProvisioning) throw new Error(`${runtimeDefinition.displayName} provisioning is not available on this node yet`);
  if (!displayName || displayName.length > 80 || !selectedRuntime.minecraftVersion) throw new Error("Display name and Minecraft version are required");
  if (input.acceptEula !== true) throw new Error("Minecraft EULA acceptance is required");
  const serverPort = input.serverPort?.trim() || "25565";
  if (!isValidServerPort(serverPort)) {
    throw new Error(`Server port must be between ${minServerPort} and ${maxServerPort}`);
  }
  const id = newServerId();
  const storageName = serverStorageName(id);
  const serverJar = selectedRuntime.serverJar || resolvedRuntime.jarArtifact.filename;
  const runtimeProfile: ServerRuntimeProfile = {
    ...resolvedRuntime,
    jarArtifact: {
      ...resolvedRuntime.jarArtifact,
      filename: serverJar
    }
  };
  const queryPort = queryPortFromInput(input);
  const dockerPorts = ensureQueryDockerPort(input.dockerPorts?.trim() || `${serverPort}:${serverPort}/tcp`, queryPort);
  parseDockerPorts(dockerPorts);
  const dockerContainer = validateDockerContainerName(input.dockerContainer?.trim() || defaultServerContainerName(id));
  const dockerImageName = validateDockerImageName(input.dockerImage?.trim() || defaultDockerImageForMinecraftVersion(runtimeProfile.minecraftVersion));
  const javaArgs = validateJavaArgs(input.javaArgs?.trim() || "-Xms2G -Xmx4G");
  const server: ManagedServer = {
    id,
    nodeId: input.nodeId || "",
    displayName,
    serverDir: serverDirectory(serversRoot, id),
    storageName,
    runtimeProfile,
    dockerContainer,
    dockerImage: dockerImageName,
    dockerPorts,
    managedPorts: [queryPortEntry(queryPort)],
    javaArgs,
    createdAt: now,
    updatedAt: now
  };
  return { server, serverPort, queryPort };
}

async function createServer(input: CreateInput, signal?: AbortSignal) {
  const displayName = input.displayName?.trim();
  const selectedRuntime = runtimeSelection(input.runtime);
  const runtimeDefinition = serverRuntimeDefinition(selectedRuntime.runtimeType);
  if (!runtimeDefinition.managedProvisioning) throw new Error(`${runtimeDefinition.displayName} provisioning is not available on this node yet`);
  if (!displayName || displayName.length > 80 || !selectedRuntime.minecraftVersion) throw new Error("Display name and Minecraft version are required");
  if (input.acceptEula !== true) throw new Error("Minecraft EULA acceptance is required");
  validateJavaArgs(input.javaArgs?.trim() || "-Xms2G -Xmx4G");
  const resolvedRuntime = await defaultServerJarProvider.resolveServerJar({
    runtimeType: selectedRuntime.runtimeType,
    minecraftVersion: selectedRuntime.minecraftVersion,
    runtimeVersion: selectedRuntime.runtimeVersion || "latest",
    preferStable: true
  });
  const { server, serverPort, queryPort } = createdServerRecord(input, resolvedRuntime);
  await mkdir(await serverRoot(server), { recursive: true });
  await mkdir(await inside(server, runtimeDefinition.contentDirectory, false), { recursive: true });
  await mkdir(await inside(server, "logs", false), { recursive: true });
  await writeFile(await writableInside(server, "server.properties"), serializeServerProperties({
    "server-port": serverPort,
    "enable-query": "true",
    "query.port": String(queryPort)
  }), { flag: "wx" }).catch((e: any) => { if (e.code !== "EEXIST") throw e; });
  await writeFile(await writableInside(server, "eula.txt"), `eula=${input.acceptEula ? "true" : "false"}\n`, "utf8");
  await writeFile(await writableInside(server, "logs/latest.log"), "", { flag: "a" });
  await downloadServerJar(server, signal);
  if (dockerAvailable()) await ensureContainer(server);
  return server;
}

async function updateServer(server: ManagedServer, input: UpdateInput, signal?: AbortSignal) {
  const status = await runtimeStatus(server);
  await requireStoppedForMutableConfiguration(server);
  const running = (status as { docker?: { running?: boolean } }).docker?.running === true;

  const plan = await planServerUpdate(server, input, {
    resolveServerJar: (request) => defaultServerJarProvider.resolveServerJar(request),
    provisioningUnavailableMessage: (displayName) => `${displayName} version changes are not available on this node yet`
  });
  const { runtimeProfile, dockerContainer, dockerImage: dockerImageName, javaArgs, serverPort, requestedDockerPorts, startOnNodeStart } = plan;
  const queryPort = queryPortFromInput({ queryPort: input.queryPort, dockerPorts: requestedDockerPorts });
  const dockerPorts = requestedDockerPorts ? ensureQueryDockerPort(requestedDockerPorts, queryPort) : requestedDockerPorts;
  if (dockerPorts) parseDockerPorts(dockerPorts);

  const jarChanged = plan.jarChanged;
  const containerConfigChanged = plan.containerConfigChanged(dockerPorts);
  const updated: ManagedServer = {
    ...server,
    displayName: plan.displayName,
    runtimeProfile,
    dockerContainer,
    dockerImage: dockerImageName,
    dockerPorts,
    managedPorts: [queryPortEntry(queryPort)],
    javaArgs,
    startOnNodeStart,
    updatedAt: new Date().toISOString()
  };

  if (jarChanged) {
    await downloadServerJar(updated, signal);
  }
  await writeVersionMetadata(updated);
  if (serverPort || queryPort !== server.managedPorts?.find((port) => port.type === "query")?.externalPort) {
    const propertiesPath = await writableInside(updated, "server.properties");
    let props: Record<string, string> = {};
    try {
      props = parseServerProperties(await readFile(propertiesPath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await writeFile(propertiesPath, serializeServerProperties({
      ...props,
      ...(serverPort ? { "server-port": serverPort } : {}),
      "enable-query": "true",
      "query.port": String(queryPort)
    }), "utf8");
  }
  if (containerConfigChanged && dockerAvailable() && !running) {
    const networkingConfig = minecraftContainerNetworkingConfig(await inspect(server).catch(() => null) as NodeContainerInspect | null);
    await removeManagedContainer(server);
    await ensureContainer(updated, networkingConfig);
  }
  return updated;
}

async function inspect(server: ManagedServer) {
  return dockerRequest("GET", `/containers/${encodeURIComponent(containerName(server))}/json`);
}

async function runtimeStatus(server: ManagedServer, prefetchedDetails?: NodeContainerInspect | null) {
  const details = prefetchedDetails === undefined ? await inspect(server).catch(() => null) as NodeContainerInspect | null : prefetchedDetails;
  const running = Boolean(details?.State?.Running);
  const managed = isManagedContainerFor(details?.Config?.Labels, server.id);
  if (details && managed) await reconcileRestartPolicy(server, details);
  const stdinReady = Boolean(details?.Config?.OpenStdin && details?.Config?.AttachStdin);
  const configured = Boolean(server.dockerContainer);
  const available = dockerAvailable();
  const serverJar = runtimeTarget(server).serverJar;
  const serverJarAvailable = Boolean(serverJar && existsSync(await inside(server, serverJar, false)));
  const recreatable = !details && configured && available && serverJarAvailable;
  const controllable = details ? managed : recreatable;
  // The server record is deliberately not echoed back: the panel builds its status projection from
  // its own stored record (see publicServerStatus), so echoing it duplicated the spec the panel had
  // just sent, once per item in every batched observation.
  return {
    docker: {
      configured,
      available,
      controllable,
      state: details?.State?.Status ?? "unknown",
      running,
      container: containerName(server),
      startedAt: details?.State?.StartedAt,
      finishedAt: details?.State?.FinishedAt,
      message: details
        ? managed ? "" : "A same-named container exists but is not managed by serverSENTINEL"
        : recreatable
          ? "Managed container is missing and will be recreated from persistent server files on start."
          : !available
            ? "Docker is unavailable on the remote node"
            : !configured
              ? "Docker container is not configured for this server"
              : "Managed container is missing and cannot be recreated because the server jar is unavailable"
    },
    fileLogsAvailable: existsSync(await inside(server, "logs/latest.log", false)),
    controlAvailable: controllable,
    commandInputAvailable: running && managed && stdinReady,
    commandInputMessage: !running
      ? "Start the server before sending console commands."
      : !managed
        ? "Console command input is unavailable because the remote container is not managed by serverSENTINEL."
        : !stdinReady
          ? "Console command input is unavailable because the remote container was not created with reliable stdin settings. Stop and recreate it to enable commands."
          : ""
  };
}

async function resourceStats(server: ManagedServer, details?: NodeContainerInspect | null) {
  const inspected = details === undefined ? await inspect(server).catch(() => null) as NodeContainerInspect | null : details;
  const running = inspected?.State?.Running === true;
  if (!running) return { available: true, running: false, cpuPercent: 0, memoryUsageBytes: 0, memoryLimitBytes: 0, networkRxBytes: 0, networkTxBytes: 0, sampledAt: new Date().toISOString() };
  const name = encodeURIComponent(containerName(server));
  const stats = await dockerRequest<DockerStatsSample>("GET", `/containers/${name}/stats?stream=false`);
  // `readAt` is dropped deliberately: the node protocol reports its own `sampledAt` wall-clock stamp.
  const { readAt: _readAt, ...sample } = computeContainerResourceSample(stats);
  return {
    available: true,
    running: true,
    ...sample,
    sampledAt: new Date().toISOString()
  };
}

async function playerObservation(server: ManagedServer, details?: NodeContainerInspect | null) {
  const propsPath = await inside(server, "server.properties", false);
  const props = parseServerProperties(await readFile(propsPath, "utf8").catch(() => ""));
  const minecraftInspect = details === undefined ? await inspect(server).catch(() => null) as NodeContainerInspect | null : details;
  const running = minecraftInspect?.State?.Running === true;
  const callerInspect = running ? await inspectCurrentContainer().catch(() => null) : null;
  const [endpoint = null, ...fallbackEndpoints] = running ? resolveMinecraftQueryEndpoints(server, props, minecraftInspect, callerInspect) : [];
  const instanceId = minecraftInspect?.Id ? `${minecraftInspect.Id}:${minecraftInspect.State?.StartedAt ?? "not-started"}` : undefined;
  return readMinecraftPlayerObservation({ running, instanceId, props, endpoint, fallbackEndpoints });
}

async function requireStoppedForMutableConfiguration(server: ManagedServer) {
  const reason = mutableServerConfigurationBlockedReason(await runtimeStatus(server));
  if (reason) throw new Error(reason);
}

function isMutableConfigurationPath(path: unknown) {
  const normalized = safeRelative(path);
  return normalized === "server.properties";
}

function sendStreamData(socket: WebSocket, id: string, event: NodeStreamDataMessage["event"]) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "streamData", id, event } satisfies NodeStreamDataMessage));
  }
}

function sendStreamEnd(socket: WebSocket, id: string, error?: NodeStreamEndMessage["error"]) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "streamEnd", id, error } satisfies NodeStreamEndMessage));
  }
}

function startConsoleStream(server: ManagedServer, streamId: string, socket: WebSocket, onDone: () => void) {
  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    sendStreamEnd(socket, streamId);
    onDone();
  };

  if (!dockerAvailable()) {
    sendStreamData(socket, streamId, {
      type: "unavailable",
      message: "Docker integration is not configured; mount /var/run/docker.sock to enable it"
    });
    finish();
    return () => undefined;
  }

  const name = encodeURIComponent(containerName(server));
  const request = http.request(
    {
      socketPath: config.dockerSocket,
      path: `/containers/${name}/logs?stdout=1&stderr=1&tail=200&follow=1`,
      method: "GET"
    },
    (response) => {
      if (response.statusCode !== 200) {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const message = dockerErrorMessage(Buffer.concat(chunks).toString("utf8"), response.statusCode);
          sendStreamData(socket, streamId, { type: "unavailable", message });
          finish();
        });
        return;
      }

      const decoder = new DockerLogDecoder();
      response.on("data", (chunk: Buffer) => {
        const text = decoder.write(chunk).toString("utf8");
        if (text) {
          sendStreamData(socket, streamId, { type: "log", source: "docker", text, at: new Date().toISOString() });
        }
      });
      response.on("end", () => finish());
      response.on("error", (error) => {
        sendStreamData(socket, streamId, { type: "unavailable", message: error.message });
        finish();
      });
    }
  );

  request.on("error", (error) => {
    if (closed) return;
    sendStreamData(socket, streamId, { type: "unavailable", message: error.message });
    finish();
  });
  request.end();

  return () => {
    if (closed) return;
    closed = true;
    request.destroy();
    onDone();
  };
}

function currentContainerId() {
  return process.env.HOSTNAME || "";
}

async function inspectCurrentContainer() {
  const id = currentContainerId();
  if (!id) return {} as NodeContainerInspect;
  return dockerRequest<NodeContainerInspect>("GET", `/containers/${encodeURIComponent(id)}/json`, 200);
}

function cleanContainerName(name?: string) {
  return (name || "").replace(/^\/+/, "");
}

async function prepareNodeUpdate(payload: unknown) {
  if (nodeUpdateInProgress) throw new Error("A node update is already in progress");
  const input = (typeof payload === "object" && payload !== null ? payload : {}) as NodeUpdateRequest;
  const image = validateDockerImageName(typeof input.image === "string" && input.image.trim() ? input.image.trim() : config.nodeImage || `nl2109/serversentinel:${appVersion}`);
  if (!dockerAvailable()) {
    throw new Error("Docker socket is not mounted on this node. Mount the Docker socket before updating the node from the panel.");
  }
  const containerId = currentContainerId();
  if (!containerId) {
    throw new Error("Could not determine the current node container id.");
  }

  const inspect = await dockerRequest<NodeContainerInspect>("GET", `/containers/${encodeURIComponent(containerId)}/json`);
  const currentName = cleanContainerName(inspect.Name) || containerId;
  const labels = inspect.Config?.Labels || {};
  const composeManaged = Boolean(labels["com.docker.compose.project"] && labels["com.docker.compose.service"]);
  const plan = {
    createdAt: new Date().toISOString(),
    image,
    containerId: inspect.Id || containerId,
    containerName: currentName,
    composeManaged,
    inspect
  };
  await mkdir(nodeUpdateDir, { recursive: true });
  const planPath = join(nodeUpdateDir, `node-update-${Date.now()}.json`);
  await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  nodeUpdateInProgress = true;

  await clearStoredNodeUpdateFailure();
  setTimeout(() => {
    void selfUpdateContainer(inspect, image, currentName, planPath).catch((error) => {
      nodeUpdateInProgress = false;
      const failure = (error as Error & { updateFailure?: NodeUpdateFailure }).updateFailure ?? {
        at: new Date().toISOString(),
        stage: "start" as const,
        message: (error as Error).message,
        image,
        recovered: false,
        containerName: currentName
      };
      void writeFile(join(nodeUpdateDir, `node-update-error-${Date.now()}.json`), `${JSON.stringify({ ...failure, planPath }, null, 2)}\n`, "utf8").catch(() => null);
      console.error(`Node self-update failed: ${failure.message}`);
      try {
        recordNodeUpdateFailure(failure);
      } catch (storageError) {
        console.error(`Could not persist the node update failure: ${(storageError as Error).message}`);
      }
      // The panel is waiting for this node to come back from the update. Handing it a fresh session
      // is what turns a silent stall into a reported failure on the Nodes page. The cleanup stage is
      // the exception: the replacement already owns the session there, and this container is going
      // away, so the report rides along on the replacement's next handshake instead.
      if (failure.stage !== "cleanup") reconnectToPanel?.("node update failed");
    });
  }, 500);

  return {
    ok: true,
    mode: "self",
    message: "Node update started. The node will reconnect shortly. If the replacement does not start and reconnect, the previous node container is restored and the failure is reported back to the panel.",
    image,
    planPath
  };
}

async function prepareNodeRestart() {
  if (!dockerAvailable()) {
    throw new Error("Docker socket is not mounted on this node. Mount the Docker socket before restarting the node from the panel.");
  }
  const containerId = currentContainerId();
  if (!containerId) {
    throw new Error("Could not determine the current node container id.");
  }

  setTimeout(() => {
    void dockerRequest("POST", `/containers/${encodeURIComponent(containerId)}/restart?t=10`, 204).catch((error) => {
      console.error(`Node self-restart failed: ${(error as Error).message}`);
    });
  }, 500);

  return {
    ok: true,
    message: "Node restart started. The node will reconnect shortly."
  };
}

async function prepareNodeRemoval() {
  if (!dockerAvailable()) {
    throw new Error("Docker socket is not mounted on this node. Stop the node container manually after removing it from the panel.");
  }
  const containerId = currentContainerId();
  if (!containerId) {
    throw new Error("Could not determine the current node container id.");
  }

  const inspect = await dockerRequest<NodeContainerInspect>("GET", `/containers/${encodeURIComponent(containerId)}/json`);
  const currentName = cleanContainerName(inspect.Name) || containerId;
  setTimeout(() => {
    void selfStopContainer(inspect.Id || containerId, currentName).catch((error) => {
      console.error(`Node self-stop failed: ${(error as Error).message}`);
    });
  }, 500);

  return {
    ok: true,
    mode: "self-stop",
    message: "Node removal accepted. The node container will stop itself.",
    containerName: currentName
  };
}

/**
 * Container config keys Docker fills in from the image when the operator did not set them. Copying
 * the running container's resolved config into the replacement pins them to the *old* image, so a
 * release that changes any of them cannot be self-updated into: the entrypoint of the Debian-based
 * image (`docker-entrypoint.sh`) does not exist in the Distroless one, and a container created with
 * it fails to start with "executable file not found in $PATH".
 */
const imageDerivedContainerConfigFields = ["Entrypoint", "Cmd", "WorkingDir", "User", "Healthcheck", "Volumes", "ExposedPorts", "StopSignal", "Shell", "ArgsEscaped", "OnBuild"] as const;

function sameConfigValue(left: unknown, right: unknown) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

/**
 * Builds the create body for the replacement container: everything the operator configured, minus
 * the values that only came from the outgoing image. A field is treated as operator-set when it
 * differs from that image's own config, so an explicit `--entrypoint` or command still survives.
 * When the outgoing image can no longer be inspected the inherited values are dropped anyway —
 * letting the new image supply its defaults recovers, while carrying stale ones cannot.
 */
export function nodeReplacementContainerConfig(
  inspect: NodeContainerInspect,
  image: string,
  previousImageConfig?: Record<string, unknown>
): Record<string, unknown> {
  const config: Record<string, unknown> = { ...inspect.Config };
  for (const field of imageDerivedContainerConfigFields) {
    if (!(field in config)) continue;
    if (previousImageConfig && !sameConfigValue(config[field], previousImageConfig[field])) continue;
    delete config[field];
  }
  const imageLabels = (previousImageConfig?.Labels ?? {}) as Record<string, string>;
  const labels = Object.fromEntries(Object.entries((config.Labels ?? {}) as Record<string, string>)
    .filter(([name, value]) => imageLabels[name] !== value));
  return {
    ...config,
    Labels: labels,
    Image: image,
    Env: withoutInheritedEnvironment(withoutBuildMetadataEnvironment(inspect.Config?.Env), previousImageConfig?.Env as string[] | undefined),
    Hostname: undefined,
    Domainname: undefined,
    MacAddress: undefined,
    NetworkDisabled: undefined,
    HostConfig: inspect.HostConfig,
    NetworkingConfig: minecraftContainerNetworkingConfig(inspect)
  };
}

async function inspectImageConfig(imageReference?: string) {
  if (!imageReference) return undefined;
  try {
    const image = await dockerRequest<{ Config?: Record<string, unknown> }>("GET", `/images/${encodeURIComponent(imageReference)}/json`, 200);
    return image.Config;
  } catch (error) {
    console.warn(`Could not inspect the current node image ${imageReference}: ${(error as Error).message}. Image defaults will be taken from the new image.`);
    return undefined;
  }
}

async function selfUpdateContainer(inspect: NodeContainerInspect, image: string, currentName: string, planPath: string) {
  await mkdir(nodeUpdateDir, { recursive: true });
  const writeStatus = (status: string, extra: Record<string, unknown> = {}) => writeFile(
    join(nodeUpdateDir, `node-update-status-${Date.now()}.json`),
    `${JSON.stringify({ updatedAt: new Date().toISOString(), image, currentName, planPath, status, ...extra }, null, 2)}\n`,
    "utf8"
  );

  let stage: NodeUpdateFailureStage = "pull";
  let oldName: string | undefined;
  let replacementId: string | undefined;
  try {
    await dockerBufferRequest("POST", `/images/create?fromImage=${encodeURIComponent(image)}`, [200, 201, 204], 10 * 60 * 1000);
    const previousImageConfig = await inspectImageConfig(inspect.Image || inspect.Config?.Image);

    stage = "create";
    oldName = `${currentName}-previous-${Date.now()}`;
    await dockerRequest("POST", `/containers/${encodeURIComponent(inspect.Id)}/rename?name=${encodeURIComponent(oldName)}`, 204);
    const created = await dockerJsonRequest<{ Id?: string }>("POST", `/containers/create?name=${encodeURIComponent(currentName)}`, nodeReplacementContainerConfig(inspect, image, previousImageConfig), 201);
    replacementId = created?.Id || currentName;
    await writeStatus("created", { oldName });

    stage = "start";
    await dockerRequest("POST", `/containers/${encodeURIComponent(currentName)}/start`, 204);

    stage = "verify";
    await verifyUpdatedNodeContainer(currentName);

    stage = "session";
    await verifyUpdatedNodeSession(currentName);

    stage = "cleanup";
    await cleanupPreviousNodeContainers(currentName, oldName);
    await writeStatus("healthy", { oldName, cleanup: "previous-container-removed" });
  } catch (error) {
    // A cleanup failure means the replacement is already healthy and owns the panel session, so the
    // update itself succeeded: rolling it back here would trade a working node for a stale one. This
    // container steps aside instead and leaves the leftover for the next update's cleanup sweep.
    const recovery = stage === "cleanup"
      ? await standDownAfterCleanupFailure(inspect.Id, oldName ?? currentName)
      : await restorePreviousNodeContainer({ previousId: inspect.Id, oldName, currentName, replacementId });
    await writeStatus("failed", { oldName, stage, error: (error as Error).message, recovery }).catch(() => null);
    throw nodeUpdateFailure(error as Error, stage, recovery, image, currentName);
  }
}

type NodeUpdateRecovery = { recovered: boolean; notes: string[] };

/**
 * Undoes a failed update so the host is left exactly as it was: the half-built replacement is
 * removed and the container this agent is running in gets its own name back. Without this the node
 * keeps serving under a `-previous-<timestamp>` name and every later update stacks another one.
 */
async function restorePreviousNodeContainer(input: { previousId: string; oldName?: string; currentName: string; replacementId?: string }): Promise<NodeUpdateRecovery> {
  const notes: string[] = [];
  if (input.replacementId) {
    try {
      await dockerRequest("DELETE", `/containers/${encodeURIComponent(input.replacementId)}?force=1`, [204, 404]);
      notes.push("Removed the replacement container.");
    } catch (error) {
      notes.push(`Could not remove the replacement container: ${(error as Error).message}`);
      return { recovered: false, notes };
    }
  }
  if (!input.oldName) return { recovered: true, notes };
  try {
    await dockerRequest("POST", `/containers/${encodeURIComponent(input.previousId)}/rename?name=${encodeURIComponent(input.currentName)}`, 204);
    notes.push(`Restored the previous container name ${input.currentName}.`);
  } catch (error) {
    notes.push(`Could not rename ${input.oldName} back to ${input.currentName}: ${(error as Error).message}`);
    return { recovered: false, notes };
  }
  try {
    const restored = await inspectNodeContainer(input.currentName);
    if (!restored.State?.Running) {
      await dockerRequest("POST", `/containers/${encodeURIComponent(input.currentName)}/start`, [204, 304]);
      notes.push("Restarted the previous container.");
    }
  } catch (error) {
    notes.push(`Could not confirm the previous container is running: ${(error as Error).message}`);
    return { recovered: false, notes };
  }
  return { recovered: true, notes };
}

async function standDownAfterCleanupFailure(previousId: string, previousName: string): Promise<NodeUpdateRecovery> {
  try {
    await selfStopContainer(previousId, previousName);
    return { recovered: false, notes: [`The updated node is running. The previous container ${previousName} could not be removed and was stopped instead; remove it on the node host.`] };
  } catch (error) {
    return { recovered: false, notes: [`The updated node is running, but the previous container ${previousName} is still running and could not be stopped: ${(error as Error).message}. Remove it on the node host.`] };
  }
}

function nodeUpdateFailure(error: Error, stage: NodeUpdateFailureStage, recovery: NodeUpdateRecovery, image: string, currentName: string) {
  const summary = recovery.recovered
    ? `The node kept running on its previous image and container ${currentName}.`
    : recovery.notes.join(" ") || "The previous container could not be restored; recover the node on its host.";
  const failure = new Error(`${nodeUpdateStageSummary[stage]}: ${error.message} ${summary}`) as Error & { updateFailure?: NodeUpdateFailure };
  failure.updateFailure = {
    at: new Date().toISOString(),
    stage,
    message: failure.message,
    image,
    recovered: recovery.recovered,
    containerName: currentName
  };
  return failure;
}

const nodeUpdateStageSummary: Record<NodeUpdateFailureStage, string> = {
  pull: "The node could not pull the new image",
  create: "The node could not create the replacement container",
  start: "The replacement container could not start",
  verify: "The replacement container did not become healthy",
  session: "The replacement container did not reconnect to the panel",
  cleanup: "The replacement container started but the previous container could not be removed",
  reconnect: "The node did not reconnect with the updated agent"
};

const buildMetadataEnvironmentNames = new Set([
  "SERVERSENTINEL_BUILD_ID",
  "SS_BUILD_ID",
  "GITHUB_SHA",
  "COMMIT_SHA",
  "SOURCE_COMMIT",
  "RAILWAY_GIT_COMMIT_SHA"
]);

function withoutBuildMetadataEnvironment(environment?: string[]) {
  return environment?.filter((entry) => {
    const separator = entry.indexOf("=");
    const name = separator === -1 ? entry : entry.slice(0, separator);
    return !buildMetadataEnvironmentNames.has(name);
  });
}

/**
 * Drops environment entries the outgoing image baked in, so the new image's own defaults apply.
 * `SERVERSENTINEL_NODE_IMAGE` is the reason this matters: carrying it forward pins a node to the
 * image tag of the release it was first created from.
 */
function withoutInheritedEnvironment(environment?: string[], imageEnvironment?: string[]) {
  if (!environment || !imageEnvironment?.length) return environment;
  const inherited = new Set(imageEnvironment);
  return environment.filter((entry) => !inherited.has(entry));
}

async function verifyUpdatedNodeContainer(currentName: string) {
  let lastInspect: NodeContainerInspect | undefined;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    lastInspect = await inspectNodeContainer(currentName);
    const state = lastInspect.State;
    const health = state?.Health?.Status;
    if (state?.Running && (!health || health === "healthy")) return lastInspect;
    if (health === "unhealthy") {
      throw new Error(`Updated node container ${currentName} reported unhealthy${await updatedNodeContainerLogTail(currentName)}`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
  }
  const status = lastInspect?.State?.Status || "unknown";
  const health = lastInspect?.State?.Health?.Status;
  throw new Error(`Updated node container ${currentName} did not become healthy. Current status: ${status}${health ? `, health: ${health}` : ""}${await updatedNodeContainerLogTail(currentName)}`);
}

async function verifyUpdatedNodeSession(currentName: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const logs = await dockerBufferRequest("GET", `/containers/${encodeURIComponent(currentName)}/logs?stdout=1&stderr=1&tail=100`, 200, 10_000, undefined, dockerLogTailMaxBytes);
    const text = logs.toString("utf8");
    if (/Node (?:session|registration) accepted/i.test(text)) return;
    const inspect = await inspectNodeContainer(currentName);
    if (!inspect.State?.Running) throw new Error(`Updated node container ${currentName} stopped before reconnecting to the panel${await updatedNodeContainerLogTail(currentName)}`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
  }
  throw new Error(`Updated node container ${currentName} did not reconnect to the panel${await updatedNodeContainerLogTail(currentName)}`);
}

/**
 * The last log line of the failed replacement, quoted into the failure the panel shows. Docker
 * reports the actual cause there (a missing entrypoint, a bad mount, a port clash) and it is the
 * one thing an operator cannot read for themselves once the container has been removed.
 */
async function updatedNodeContainerLogTail(currentName: string) {
  try {
    const logs = await dockerBufferRequest("GET", `/containers/${encodeURIComponent(currentName)}/logs?stdout=1&stderr=1&tail=20`, 200, 10_000, undefined, dockerLogTailMaxBytes);
    const lastLine = stripDockerLogHeaders(logs).toString("utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop();
    return lastLine ? `. Last container log: ${lastLine.slice(0, 400)}` : ".";
  } catch {
    return ".";
  }
}

async function inspectNodeContainer(nameOrId: string) {
  return dockerRequest<NodeContainerInspect>("GET", `/containers/${encodeURIComponent(nameOrId)}/json`, 200);
}

function isPreviousNodeContainerName(name: string, currentName: string) {
  return name.startsWith(`${currentName}-previous-`);
}

function previousNodeContainerNames(container: DockerContainerListItem) {
  return (container.Names || []).map(cleanContainerName).filter(Boolean);
}

async function cleanupPreviousNodeContainers(currentName: string, requiredPreviousName?: string) {
  const removed: string[] = [];
  const removePreviousContainer = async (name: string) => {
    await dockerRequest("DELETE", `/containers/${encodeURIComponent(name)}?force=1&v=1`, [204, 404]);
    removed.push(name);
  };

  const containers = await dockerRequest<DockerContainerListItem[]>("GET", "/containers/json?all=1", 200);
  for (const container of containers) {
    const names = previousNodeContainerNames(container).filter((name) => isPreviousNodeContainerName(name, currentName));
    if (names.length === 0) continue;
    if (names.includes(currentName)) continue;
    const state = (container.State || "").toLowerCase();
    if (!removablePreviousNodeStates.has(state)) continue;
    const name = names[0];
    if (requiredPreviousName && name === requiredPreviousName) continue;
    await removePreviousContainer(name);
  }
  if (requiredPreviousName) {
    await removePreviousContainer(requiredPreviousName);
  }
  return { removed };
}

async function selfStopContainer(containerId: string, currentName: string) {
  await dockerJsonRequest("POST", `/containers/${encodeURIComponent(containerId)}/update`, {
    RestartPolicy: { Name: "no" }
  }, 200);
  await dockerRequest("POST", `/containers/${encodeURIComponent(containerId)}/stop?t=10`, [204, 304]);
  console.info(`Node container ${currentName} stopped after panel removal.`);
}

async function fileList(server: ManagedServer, path: unknown) {
  const scope = { serverDir: await serverRoot(server) };
  return listServerDirectory(scope, await inside(server, path), { status: () => "managed" });
}

async function fileRead(server: ManagedServer, path: unknown, preview = false) {
  const scope = { serverDir: await serverRoot(server) };
  const target = await inside(server, path);
  return preview
    ? previewServerFile(scope, target, { sizeLimit: editorFileSizeLimit, requireTextLike: false })
    : readServerTextFile(scope, target);
}

async function readRecentServerLogs(server: ManagedServer, lineLimit?: number) {
  try {
    const target = await inside(server, "logs/latest.log");
    if (lineLimit !== undefined) {
      return { text: await readConsoleLogTail(target, lineLimit), source: "logs/latest.log" as const };
    }
    const handle = await open(target, "r");
    try {
      const fileStat = await handle.stat();
      if (!fileStat.isFile()) throw new Error("logs/latest.log is not a file");
      const length = Math.min(fileStat.size, recentLogTailBytes);
      if (length === 0) return { text: "", source: "logs/latest.log" as const };
      const content = Buffer.alloc(length);
      const { bytesRead } = await handle.read(content, 0, length, fileStat.size - length);
      return { text: content.subarray(0, bytesRead).toString("utf8"), source: "logs/latest.log" as const };
    } finally {
      await handle.close();
    }
  } catch {
    const name = encodeURIComponent(containerName(server));
    const tail = lineLimit === undefined ? 300 : consoleLogLineLimit(lineLimit);
    const text = stripDockerLogHeaders(await dockerBufferRequest("GET", `/containers/${name}/logs?stdout=1&stderr=1&tail=${tail}`, 200, 15000, undefined, dockerLogTailMaxBytes)).toString("utf8");
    return { text, source: "docker" as const };
  }
}

async function readServerLogDelta(server: ManagedServer, cursor?: ServerLogCursor) {
  try {
    const target = await inside(server, "logs/latest.log");
    const handle = await open(target, "r");
    try {
      const fileStat = await handle.stat();
      if (!fileStat.isFile()) throw new Error("logs/latest.log is not a file");
      const identity = `${fileStat.dev}:${fileStat.ino}`;
      const canContinue = cursor?.source === "logs/latest.log"
        && cursor.identity === identity
        && typeof cursor.offset === "number"
        && cursor.offset >= 0
        && cursor.offset <= fileStat.size;
      const available = canContinue ? fileStat.size - cursor.offset! : fileStat.size;
      const length = Math.min(available, recentLogTailBytes);
      const offset = canContinue && available <= recentLogTailBytes ? cursor.offset! : Math.max(0, fileStat.size - length);
      const content = Buffer.alloc(length);
      const { bytesRead } = length ? await handle.read(content, 0, length, offset) : { bytesRead: 0 };
      return {
        text: content.subarray(0, bytesRead).toString("utf8"),
        source: "logs/latest.log" as const,
        cursor: { source: "logs/latest.log" as const, identity, offset: fileStat.size },
        reset: !canContinue || available > recentLogTailBytes
      };
    } finally {
      await handle.close();
    }
  } catch {
    const logs = await readRecentServerLogs(server);
    return { ...logs, cursor: { source: "docker" as const }, reset: true };
  }
}

function observationError(error: unknown) {
  return { code: "observation_failed", message: error instanceof Error ? error.message : "Observation failed", details: detailedErrorMessage(error), retryable: true };
}

async function observeServer(item: ServerObservationItem): Promise<ServerObservationResultItem> {
  const server = item.server as unknown as ManagedServer;
  const sections = new Set<ServerObservationSection>(item.sections);
  const result: ServerObservationResultItem = { serverId: server.id };
  const errors: ServerObservationResultItem["errors"] = {};
  const needsInspect = sections.has("status") || sections.has("stats") || sections.has("players");
  const details = needsInspect ? await inspect(server).catch(() => null) as NodeContainerInspect | null : undefined;
  const tasks: Promise<void>[] = [];
  const run = (section: ServerObservationSection, operation: () => Promise<unknown>, assign: (value: any) => void) => {
    tasks.push(operation().then(assign).catch((error) => { errors[section] = observationError(error); }));
  };
  if (sections.has("status")) run("status", () => runtimeStatus(server, details), (value) => { result.status = value; });
  if (sections.has("stats")) run("stats", () => resourceStats(server, details), (value) => { result.stats = value; });
  if (sections.has("players")) run("players", () => playerObservation(server, details), (value) => { result.players = value; });
  if (sections.has("logs")) run("logs", () => readServerLogDelta(server, item.logCursor), (value) => { result.logs = value; });
  if (sections.has("overviewFiles")) run("overviewFiles", async () => ({
    properties: await readFile(await inside(server, "server.properties", false), "utf8").catch(() => ""),
    eula: await readFile(await inside(server, "eula.txt", false), "utf8").catch(() => "")
  }), (value) => { result.overviewFiles = value; });
  await Promise.all(tasks);
  if (Object.keys(errors).length) result.errors = errors;
  return result;
}

async function observeServers(payload: unknown): Promise<ServerObservationResponse> {
  const normalized = normalizeServerObservationRequest(payload).items;
  const results = new Array<ServerObservationResultItem>(normalized.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(4, normalized.length) }, async () => {
    while (nextIndex < normalized.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await observeServer(normalized[index]);
    }
  }));
  return { observedAt: new Date().toISOString(), items: results };
}

function publicExtractionPlan(root: string, plan: ZipExtractionPlan): ZipExtractionPlan {
  return publicZipExtractionPlan({ serverDir: root }, plan);
}

async function archivePlan(server: ManagedServer, path: unknown, destinationPath: unknown) {
  const root = await serverRoot(server);
  const archive = await inside(server, path);
  const destination = await writableInside(server, destinationPath);
  const plan = await planZipExtraction(archive, destination, zipLimits);
  if (plan.outputPaths.some((entry) => isMutableConfigurationPath(publicPath(root, entry.path).replace(/^\//, "")))) {
    await requireStoppedForMutableConfiguration(server);
  }
  return publicExtractionPlan(root, plan);
}

function startArchiveExtractionStream(server: ManagedServer, payload: Record<string, unknown>, streamId: string, socket: WebSocket, onDone: () => void) {
  let closed = false;
  const controller = new AbortController();
  void (async () => {
    const root = await serverRoot(server);
    const archive = await inside(server, payload.path);
    const destination = await writableInside(server, payload.destinationPath);
    const conflictPolicy = payload.conflictPolicy;
    if (conflictPolicy !== "replace" && conflictPolicy !== "skip") throw new Error("conflictPolicy must be replace or skip");
    const plan = await planZipExtraction(archive, destination, zipLimits);
    if (plan.outputPaths.some((entry) => isMutableConfigurationPath(publicPath(root, entry.path).replace(/^\//, "")))) {
      await requireStoppedForMutableConfiguration(server);
    }
    const result = await extractZipArchive({
      archivePath: archive,
      destinationPath: destination,
      conflictPolicy,
      limits: zipLimits,
      signal: controller.signal,
      report: (progress, task) => {
        if (!closed) sendStreamData(socket, streamId, { type: "progress", progress, task });
      }
    });
    if (!closed) {
      sendStreamData(socket, streamId, { type: "result", result: { ...result, destinationPath: publicPath(root, result.destinationPath) } });
      sendStreamEnd(socket, streamId);
    }
  })().catch((error) => {
    if (!closed) sendStreamEnd(socket, streamId, { code: "archive_extraction_failed", message: (error as Error).message, details: detailedErrorMessage(error) });
  }).finally(onDone);
  return () => {
    closed = true;
    controller.abort();
  };
}

async function writeRelativeFile(server: ManagedServer, path: unknown, content: Buffer | string) {
  const root = await serverRoot(server);
  const target = await writableInside(server, path);
  if (existsSync(target)) {
    throw new Error("A file or folder with that name already exists");
  }
  await writeFile(target, content);
  return { ok: true, path: publicPath(root, target), size: Buffer.byteLength(content) };
}

async function writeEditableFile(server: ManagedServer, path: unknown, content: unknown) {
  const scope = { serverDir: await serverRoot(server) };
  return writeServerTextFile(scope, await inside(server, path), content);
}

async function modsList(server: ManagedServer) {
  const runtime = serverRuntimeDefinition(runtimeTarget(server).runtimeType);
  await mkdir(await inside(server, runtime.contentDirectory, false), { recursive: true });
  const listing = await fileList(server, runtime.contentDirectory) as any;
  const mods = await Promise.all(
    listing.entries
      .filter((entry: any) => entry.type === "file" && (entry.name.endsWith(".jar") || entry.name.endsWith(".jar.disabled")))
      .map(async (entry: any) => {
        const filename = entry.name;
        const base = {
          filename,
          displayName: filename.replace(/\.jar\.disabled$/, ".jar"),
          enabled: filename.endsWith(".jar"),
          size: entry.size,
          modifiedAt: entry.modifiedAt,
          preferredChannel: "release" as ReleaseChannel,
          compatibility: { status: "unknown", compatible: false, reason: `Remote ${runtime.contentKind === "plugins" ? "plugin" : "mod"} metadata sync pending` }
        };
        try {
          const target = await inside(server, posix.join(runtime.contentDirectory, filename));
          const sha1 = await modHashCache.sha1(`${server.id}:${filename}`, entry.size, entry.modifiedAt, () => readFile(target));
          return { ...base, sha1 };
        } catch {
          return base;
        }
      })
  );
  return { mods };
}

async function writeManagedContentBuffer(server: ManagedServer, filename: unknown, content: Buffer) {
  const { directory, singular, Singular } = managedContentNaming(runtimeTarget(server).runtimeType);
  const name = safeModFilename(safeInstalledModFilename(filename as string | undefined));
  if (!name.endsWith(".jar")) throw new Error(`${Singular} uploads must be .jar files`);
  if (!content.length || content.length > uploadLimit) throw new Error(`Uploaded ${singular} must be between 1 byte and ${Math.floor(uploadLimit / 1024 / 1024)} MiB`);
  assertJarBuffer(content, singular);
  await mkdir(await inside(server, directory, false), { recursive: true });
  await inside(server, directory);
  return writeRelativeFile(server, posix.join(directory, name), content);
}

type PreparedBinaryUpload = {
  temporaryPath: string;
  targetPath: string;
  publicTargetPath: string;
  maximumBytes: number;
  managedContentName?: string;
};

async function prepareBinaryUpload(message: NodeTransferStartMessage): Promise<PreparedBinaryUpload> {
  const payload = typeof message.payload === "object" && message.payload !== null ? message.payload as Record<string, unknown> : {};
  const server = payload.server as ManagedServer | undefined;
  if (!server) throw new Error("server payload is required");
  if (message.size === undefined) throw new Error("Upload size is required");
  const root = await serverRoot(server);
  let targetPath: string;
  let maximumBytes: number;
  let managedContentName: string | undefined;
  if (message.command === "files.upload") {
    maximumBytes = fileUploadSizeLimit;
    const parent = await inside(server, payload.parent);
    if (!(await stat(parent)).isDirectory()) throw new Error("Upload path is not a directory");
    const relativeTarget = posix.join(safeRelative(payload.parent), safeName(payload.filename));
    if (isMutableConfigurationPath(relativeTarget)) await requireStoppedForMutableConfiguration(server);
    targetPath = await writableResolvedInside(server, join(parent, safeName(payload.filename)));
  } else {
    maximumBytes = uploadLimit;
    const runtimeType = runtimeTarget(server).runtimeType;
    const runtime = serverRuntimeDefinition(runtimeType);
    const expectedPrefix = runtime.contentKind === "mods" ? "mods" : "content";
    if (!runtime.managedContent || !message.command.startsWith(`${expectedPrefix}.`)) throw new Error(`${runtime.displayName} does not support this managed-content upload`);
    const { directory, singular, Singular } = managedContentNaming(runtimeType);
    const name = safeModFilename(safeInstalledModFilename(payload.filename as string | undefined));
    if (!name.endsWith(".jar")) throw new Error(`${Singular} uploads must be .jar files`);
    await mkdir(await inside(server, directory, false), { recursive: true });
    targetPath = await writableInside(server, posix.join(directory, name));
    managedContentName = singular;
  }
  if (message.size < (managedContentName ? 1 : 0) || message.size > maximumBytes) {
    throw new Error(`Upload must be no larger than ${Math.floor(maximumBytes / 1024 / 1024)} MiB`);
  }
  if (existsSync(targetPath)) throw new Error("A file or folder with that name already exists");
  return {
    temporaryPath: `${targetPath}.serversentinel-${message.id}.tmp`,
    targetPath,
    publicTargetPath: publicPath(root, targetPath),
    maximumBytes,
    managedContentName
  };
}

async function prepareBinaryDownload(message: NodeTransferStartMessage) {
  const payload = typeof message.payload === "object" && message.payload !== null ? message.payload as Record<string, unknown> : {};
  const server = payload.server as ManagedServer | undefined;
  if (!server) throw new Error("server payload is required");
  if (message.command === "files.download") {
    const target = await inside(server, payload.path);
    const targetStat = await stat(target);
    if (!targetStat.isFile()) throw new Error("Download path is not a file");
    if (targetStat.size > (message.maxBytes ?? uploadLimit)) throw new Error("File exceeds the configured download limit");
    const handle = await open(target, "r");
    return { filename: basename(target), size: targetStat.size, stream: handle.createReadStream() };
  }
  if (message.command === "exports.download") {
    const manifest = payload.manifest;
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("Export manifest is required");
    const record = manifest as Record<string, unknown>;
    if (record.artifactType !== EXPORT_ARTIFACT_TYPE || record.schemaVersion !== EXPORT_SCHEMA_VERSION) {
      throw new Error("Unsupported export manifest");
    }
    if (!Array.isArray(record.servers) || record.servers.length !== 1) throw new Error("Remote export requires exactly one server");
    const manifestServer = record.servers[0];
    if (!manifestServer || typeof manifestServer !== "object" || Array.isArray(manifestServer)) throw new Error("Export server manifest is invalid");
    const manifestServerRecord = manifestServer as Record<string, unknown>;
    const exportedServer = manifestServerRecord.server as Record<string, unknown> | undefined;
    if (!exportedServer || exportedServer.id !== server.id) throw new Error("Export server does not match the requested server");
    const key = safeRelative(manifestServerRecord.key);
    if (key.includes("/")) throw new Error("Export server key must be one archive segment");
    if (!Array.isArray(manifestServerRecord.files) || manifestServerRecord.files.length > config.importMaxFiles) {
      throw new Error(`Export contains more than ${config.importMaxFiles} files`);
    }
    const entries: FileArchiveEntry[] = [];
    const seen = new Set<string>();
    let totalBytes = 0;
    for (const rawFile of manifestServerRecord.files) {
      if (!rawFile || typeof rawFile !== "object" || Array.isArray(rawFile)) throw new Error("Export file manifest is invalid");
      const file = rawFile as Record<string, unknown>;
      const path = safeRelative(file.path);
      if (path === "." || seen.has(path)) throw new Error("Export file path is invalid or duplicated");
      if (typeof file.size !== "number" || !Number.isSafeInteger(file.size) || file.size < 0) throw new Error("Export file size is invalid");
      seen.add(path);
      totalBytes += file.size;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > config.exportMaxBytes) throw new Error("Export exceeds the configured size limit");
      entries.push({ sourcePath: path, archivePath: `servers/${key}/${path}`, type: "file", size: file.size });
    }
    const manifestBuffer = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    entries.unshift({ sourcePath: EXPORT_MANIFEST_ENTRY, archivePath: EXPORT_MANIFEST_ENTRY, type: "file", size: manifestBuffer.byteLength });
    const stream = createZipArchiveStream(entries, async (entry) => {
      if (entry.archivePath === EXPORT_MANIFEST_ENTRY) return Readable.from([manifestBuffer]);
      return (await openContainedReadStream(await inside(server, entry.sourcePath))).stream;
    }, { compressionLevel: exportArchiveCompressionLevel });
    return { filename: safeArchiveFilename(String(payload.filename ?? "serversentinel-export.zip")), size: undefined, stream };
  }
  throw new Error(`Unsupported download transfer ${message.command}`);
}

function sendWebSocket(socket: WebSocket, payload: string | Buffer, binary = false) {
  return new Promise<void>((resolvePromise, reject) => socket.send(payload, { binary }, (error) => error ? reject(error) : resolvePromise()));
}

async function modInstall(server: ManagedServer, input: unknown, signal?: AbortSignal) {
  const payload = typeof input === "object" && input !== null ? input as Record<string, unknown> : {};
  const projectId = validateModrinthProjectId(payload.projectId);
  const versionId = validateModrinthVersionId(payload.versionId);
  const forceIncompatible = payload.forceIncompatible === true;
  const overrideMinecraftVersion = payload.overrideMinecraftVersion === true;
  const channel: ReleaseChannel = payload.channel === "alpha" || payload.channel === "beta" ? payload.channel : "release";
  const targetRuntime = runtimeTarget(server);
  const naming = managedContentNaming(targetRuntime.runtimeType);
  const { singular, Singular } = naming;
  if (!targetRuntime.minecraftVersion) throw new Error(`A resolved ${naming.displayName} runtime profile is required before installing compatible ${naming.plural}`);

  if (!versionId) {
    const compatibility = await resolveModrinthProjectCompatibility({ projectId, minecraftVersion: targetRuntime.minecraftVersion, loaders: naming.loaders, runtimeName: naming.displayName, contentKind: singular, channel });
    if (!compatibility.compatible && !forceIncompatible) throw new Error(`${compatibility.reason}. Set forceIncompatible to true to install anyway.`);
    const file = compatibility.file;
    if (!file?.url || !file.filename) throw new Error("No installable .jar file was found for that version");
    assertDownloadableModrinthFile(file, { singular, maximumBytes: uploadLimit });
    const response = await modrinthFetch(file.url, { signal });
    if (!response.ok) throw new Error(`${Singular} download failed: ${response.statusText}`);
    const content = Buffer.from(await response.arrayBuffer());
    assertModrinthJarHashes(content, file);
    const written = await writeManagedContentBuffer(server, safeModFilename(file.filename), content);
    return { ...written, filename: file.filename, projectId, version: compatibility.matchedVersionNumber, compatibility };
  }

  const [project, versions] = await Promise.all([fetchProject(projectId), fetchProjectVersions(projectId)]);
  const selectedVersion = await resolveSelectedProjectVersion({
    projectId,
    project,
    versionId,
    versions
  }).catch((error) => {
    if ((error as Error).message === "The selected Modrinth version does not belong to that project") throw error;
    return undefined;
  });
  if (!selectedVersion) throw new Error("The selected Modrinth version could not be found");
  const candidate = assertVersionInstallable({
    version: selectedVersion,
    project,
    naming,
    minecraftVersion: targetRuntime.minecraftVersion,
    channel,
    forceIncompatible,
    overrideMinecraftVersion,
    // The node agent has no way to prompt, so it keeps installing content whose
    // server-side support Modrinth reports as unknown.
    requireKnownServerSide: false
  });
  const { file, matchesMinecraft } = candidate;
  if (!matchesMinecraft && !forceIncompatible) throw new Error("Set forceIncompatible to true when installing a Minecraft version override.");
  assertDownloadableModrinthFile(file, { singular, maximumBytes: uploadLimit });
  const response = await modrinthFetch(file.url, { signal });
  if (!response.ok) throw new Error(`${Singular} download failed: ${response.statusText}`);
  const content = Buffer.from(await response.arrayBuffer());
  assertModrinthJarHashes(content, file);
  const written = await writeManagedContentBuffer(server, safeModFilename(file.filename), content);
  return {
    ...written,
    filename: file.filename,
    projectId,
    version: selectedVersion.version_number,
    channel: versionChannel(selectedVersion.version_type),
    compatibility: compatibilityFromSelectedVersion({
      version: selectedVersion,
      file,
      projectSides: { server_side: project.server_side, client_side: project.client_side },
      compatible: matchesMinecraft,
      reason: matchesMinecraft ? `Compatible server-side ${naming.displayName} ${singular}` : "Installed with Minecraft version override"
    })
  };
}

async function handleCommand(command: string, payload: any, signal?: AbortSignal) {
  if (!isNodeCapability(command)) {
    throw new Error(`Unsupported node command ${command}`);
  }
  const server = payload?.server as ManagedServer | undefined;
  if (command === "node.update") return prepareNodeUpdate(payload);
  if (command === "node.restart") return prepareNodeRestart();
  if (command === "node.remove") return prepareNodeRemoval();
  if (command === "server.create") return createServer(payload?.input as CreateInput, signal);
  if (command === "server.observe") return observeServers(payload);
  if (!server) throw new Error("server payload is required");
  const name = encodeURIComponent(containerName(server));
  if (command === "server.update") {
    await requireStoppedForMutableConfiguration(server);
    return updateServer(server, payload?.input as UpdateInput, signal);
  }
  if (command === "server.delete") {
    const status = await inspect(server).catch(() => null) as any;
    if (status?.State?.Running) throw new Error("Stop the server before deleting it");
    const deletedContainer = await removeManagedContainer(server);
    if (payload?.input?.deleteFiles) await rm(await serverRoot(server), { recursive: true, force: true });
    return { ok: true, deletedContainer, deletedFiles: Boolean(payload?.input?.deleteFiles) };
  }
  if (command === "server.inspect") return runtimeStatus(server);
  if (command === "server.players.read") return playerObservation(server);
  if (command === "server.start") {
    await ensureContainer(server);
    await requestContainerLifecycleAction(server, "start", signal);
    return runtimeStatus(server);
  }
  if (command === "server.stop") { signal?.throwIfAborted(); await dockerRequest("POST", `/containers/${name}/stop${dockerStopQuery()}`, [204, 304], signal, dockerStopRequestTimeoutMs()); return runtimeStatus(server); }
  if (command === "server.restart") {
    await ensureContainer(server);
    await requestContainerLifecycleAction(server, "restart", signal);
    return runtimeStatus(server);
  }
  if (command === "server.stats") return resourceStats(server);
  if (command === "server.storage") return storageSpaceForPath(await serverRoot(server));
  if (command === "server.logs.recent") {
    const lineLimit = payload?.limit === undefined ? undefined : consoleLogLineLimit(payload.limit);
    return readRecentServerLogs(server, lineLimit);
  }
  if (command === "server.console.send") {
    const commandText = typeof payload?.command === "string" ? payload.command.trim() : "";
    if (!commandText) throw new Error("Console command is required");
    if (/\r|\n/.test(commandText)) throw new Error("Only one console command can be sent at a time");
    const status = await runtimeStatus(server);
    if (!(status as any).commandInputAvailable) {
      throw new Error((status as any).commandInputMessage || "Console command input is unavailable");
    }
    await sendDockerContainerStdinLine(name, commandText, { timeoutMs: 5000 });
    return { ok: true };
  }
  if (command === "files.list") return fileList(server, payload?.path);
  if (command === "files.archive.plan") return archivePlan(server, payload?.path, payload?.destinationPath);
  if (command === "files.read") return fileRead(server, payload?.path, Boolean(payload?.preview));
  if (command === "files.write") {
    if (isMutableConfigurationPath(payload?.path)) await requireStoppedForMutableConfiguration(server);
    return writeEditableFile(server, payload?.path, payload?.content);
  }
  if (command === "files.mkdir") {
    if (isMutableConfigurationPath(payload?.parent)) await requireStoppedForMutableConfiguration(server);
    const scope = { serverDir: await serverRoot(server) };
    return createServerFolder(scope, await inside(server, payload?.parent), payload?.name);
  }
  if (command === "files.rename") {
    const scope = { serverDir: await serverRoot(server) };
    const source = await inside(server, payload?.path);
    if (isMutableConfigurationPath(payload?.path) || isMutableConfigurationPath(posix.join(posix.dirname(safeRelative(payload?.path)), safeName(payload?.name)))) {
      await requireStoppedForMutableConfiguration(server);
    }
    return renameServerEntry(scope, source, payload?.name);
  }
  if (command === "files.move") {
    const scope = { serverDir: await serverRoot(server) };
    const source = await inside(server, payload?.path);
    return moveServerEntry(scope, source, await inside(server, payload?.destinationPath), {
      beforeApply: async () => {
        if (isMutableConfigurationPath(payload?.path) || isMutableConfigurationPath(posix.join(safeRelative(payload?.destinationPath), basename(source)))) {
          await requireStoppedForMutableConfiguration(server);
        }
      }
    });
  }
  if (command === "files.copy") {
    const scope = { serverDir: await serverRoot(server) };
    const source = await inside(server, payload?.path);
    if (isMutableConfigurationPath(payload?.path) || isMutableConfigurationPath(posix.join(safeRelative(payload?.parent), safeName(payload?.name)))) {
      await requireStoppedForMutableConfiguration(server);
    }
    return copyServerFile(scope, source, await inside(server, payload?.parent), payload?.name);
  }
  if (command === "files.delete") {
    if (payload?.recursive !== undefined && payload.recursive !== "true" && payload.recursive !== "false") {
      throw new Error("recursive must be true or false");
    }
    const scope = { serverDir: await serverRoot(server) };
    const target = await inside(server, payload?.path);
    if (isMutableConfigurationPath(payload?.path)) await requireStoppedForMutableConfiguration(server);
    return deleteServerEntry(scope, target, payload?.recursive);
  }
  if (command.startsWith("mods.") || command.startsWith("content.")) {
    const runtime = serverRuntimeDefinition(runtimeTarget(server).runtimeType);
    if (!runtime.managedContent || (command.startsWith("mods.") && runtime.contentKind !== "mods")) {
      throw new Error(command.startsWith("mods.")
        ? `${runtime.displayName} servers use ${runtime.contentKind}. This node command requires a runtime with managed mods.`
        : `${runtime.displayName} servers do not support this managed-content command.`);
    }
  }
  if (command === "mods.list" || command === "content.list") return modsList(server);
  if (command === "mods.install" || command === "content.install") {
    return modInstall(server, payload, signal);
  }
  if (command === "mods.enableDisable" || command === "content.enableDisable") {
    const runtime = serverRuntimeDefinition(runtimeTarget(server).runtimeType);
    const filename = safeInstalledModFilename(payload?.filename as string | undefined);
    const enabled = requireStrictBoolean(payload?.enabled, "enabled");
    const sourceName = filename.endsWith(".jar") && !existsSync(ensureInsideServer({ serverDir: await serverRoot(server) }, posix.join(runtime.contentDirectory, filename)))
      ? `${filename}.disabled`
      : filename;
    const source = await inside(server, posix.join(runtime.contentDirectory, sourceName));
    const targetName = enabled ? sourceName.replace(/\.jar\.disabled$/, ".jar") : sourceName.endsWith(".jar.disabled") ? sourceName : `${sourceName}.disabled`;
    const target = await writableInside(server, posix.join(runtime.contentDirectory, safeInstalledModFilename(targetName)));
    if (source !== target) await rename(source, target);
    return { ok: true, filename: basename(target), enabled };
  }
  if (command === "mods.remove" || command === "content.remove") {
    const runtime = serverRuntimeDefinition(runtimeTarget(server).runtimeType);
    const filename = safeInstalledModFilename(payload?.filename as string | undefined);
    await rm(await inside(server, posix.join(runtime.contentDirectory, filename)), { force: true });
    return { ok: true, filename };
  }
  throw new Error(`Unsupported node command ${command}`);
}

export const __nodeAgentTestHooks = {
  cleanupPreviousNodeContainers,
  createdServerRecord,
  handleCommand,
  minecraftContainerNetworkingConfig,
  minecraftContainerEnvironment,
  minecraftContainerCommand,
  runtimeConfigHash,
  nodeReconnectDelayMs,
  prepareBinaryUpload,
  prepareBinaryDownload,
  nodeReplacementContainerConfig,
  selfUpdateContainer
};

export async function startNodeAgent() {
  initializeRuntimeDataRoot(config.paths);
  nodeStorageDatabase = openStorageDatabase();
  const startupId = randomUUID();
  let persisted = await readNodeIdentity();
  let reconnectAttempt = 0;
  let panelSocket: WebSocket | undefined;
  let stopping = false;
  if (!persisted && !config.joinToken) throw new Error("SS_JOIN_TOKEN is required for first node registration");
  console.info(`serverSENTINEL node agent ${appVersion}${appBuildId ? ` build ${appBuildId}` : ""} starting. Panel: ${config.panelUrl}. Data: ${config.nodeDataDir}.`);
  if (await dockerLiveRestoreEnabled() === false) console.warn(dockerLiveRestoreGuidance);

  registerShutdownHandlers(async () => {
    stopping = true;
    // Closing the session lets the panel mark this node offline immediately
    // instead of waiting out its heartbeat timeout, and checkpoints the WAL.
    panelSocket?.close(1001, "Node agent shutting down");
    // Left assigned on purpose: a late reader gets a closed-connection error
    // rather than silently reopening the data root mid-shutdown.
    nodeStorageDatabase?.close();
  }, {
    logger: {
      info: (fields, message) => console.info(`${message} (${JSON.stringify(fields)})`),
      error: (fields, message) => console.error(`${message} (${JSON.stringify(fields)})`)
    }
  });

  let reportedUpdateFailure: NodeUpdateFailure | undefined;

  const connect = async () => {
    if (stopping) return;
    persisted = await readNodeIdentity();
    const target = panelWebSocketUrl();
    console.info(`Connecting node agent to ${target}`);
    const socket = new WebSocket(target, { perMessageDeflate: false, maxPayload: nodeProtocolControlMessageMaxBytes });
    panelSocket = socket;
    const activeStreams = new Map<string, () => void>();
    const activeRequests = new Map<string, AbortController>();
    type ActiveTransfer =
      | { direction: "upload"; prepared: PreparedBinaryUpload; file: Awaited<ReturnType<typeof open>>; expectedSize: number; received: number; hash: ReturnType<typeof createHash>; writes: Promise<void> }
      | { direction: "download"; stream?: NodeJS.ReadableStream; cancelled: boolean };
    const activeTransfers = new Map<string, ActiveTransfer>();
    let accepted = false;
    let lastPanelPingAt = Date.now();
    let heartbeatWatchdog: NodeJS.Timeout | undefined;
    let stableSessionTimer: NodeJS.Timeout | undefined;
    const stopAllStreams = () => {
      for (const cleanup of Array.from(activeStreams.values())) cleanup();
      activeStreams.clear();
      for (const controller of activeRequests.values()) controller.abort();
      activeRequests.clear();
      for (const transfer of activeTransfers.values()) {
        if (transfer.direction === "upload") {
          void transfer.file.close().catch(() => undefined);
          void rm(transfer.prepared.temporaryPath, { force: true }).catch(() => undefined);
        } else {
          transfer.cancelled = true;
          if (transfer.stream && "destroy" in transfer.stream) (transfer.stream as { destroy: () => void }).destroy();
        }
      }
      activeTransfers.clear();
    };
    let reconnectScheduled = false;
    const reconnect = (reason: string) => {
      if (reconnectScheduled) return;
      reconnectScheduled = true;
      stopAllStreams();
      if (heartbeatWatchdog) clearInterval(heartbeatWatchdog);
      if (stableSessionTimer) clearTimeout(stableSessionTimer);
      if (stopping) return;
      const reconnectDelayMs = nodeReconnectDelayMs(reconnectAttempt);
      reconnectAttempt += 1;
      console.warn(`Node agent disconnected: ${reason}. Reconnecting in ${Math.max(1, Math.round(reconnectDelayMs / 1000))}s.`);
      const timer = setTimeout(() => void connect(), reconnectDelayMs);
      timer.unref?.();
    };
    // Closing the session is what makes the panel take a fresh handshake, which is how a stored
    // update failure reaches it. Terminating rather than closing keeps the panel from waiting.
    reconnectToPanel = (reason: string) => {
      if (socket.readyState === WebSocket.OPEN) socket.close(4001, "Node update failed");
      reconnect(reason);
    };
    socket.on("open", async () => {
      const dockerStatus = await dockerReachable() ? "available" : "unavailable";
      const dataPathStatus = existsSync(config.nodeDataDir) ? "ready" : "missing";
      reportedUpdateFailure = readStoredNodeUpdateFailure();
      const hello: NodeHello = {
        type: "hello",
        nodeId: persisted?.nodeId ?? null,
        nodeSecret: persisted?.nodeSecret,
        joinToken: persisted ? undefined : config.joinToken,
        nodeName: config.nodeName || "Remote Node",
        agentVersion: appVersion,
        buildId: appBuildId,
        startupId,
        protocolVersion: nodeProtocolVersion,
        capabilities: [...nodeCapabilities],
        features: [...nodeFeatures],
        dockerStatus,
        dataPathStatus,
        totalMemory: await detectedTotalMemory(),
        updateFailure: reportedUpdateFailure
      };
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify(hello));
      heartbeatWatchdog = setInterval(() => {
        if (Date.now() - lastPanelPingAt >= panelHeartbeatTimeoutMs) socket.terminate();
      }, 5_000);
      heartbeatWatchdog.unref?.();
    });
    socket.on("ping", () => { lastPanelPingAt = Date.now(); });
    socket.on("message", async (raw, isBinary) => {
      const rawBuffer = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      if (isBinary) {
        try {
          const { id, payload } = decodeTransferChunk(rawBuffer);
          const transfer = activeTransfers.get(id);
          if (!transfer || transfer.direction !== "upload") return;
          transfer.received += payload.byteLength;
          if (transfer.received > transfer.expectedSize || transfer.received > transfer.prepared.maximumBytes) throw new Error("Upload exceeded its declared limit");
          transfer.hash.update(payload);
          transfer.writes = transfer.writes.then(async () => { await transfer.file.write(payload); });
        } catch {
          socket.close(1002, "Invalid binary transfer frame");
        }
        return;
      }
      if (rawBuffer.byteLength > nodeProtocolControlMessageMaxBytes) {
        socket.close(1009, "Node protocol control message is too large");
        return;
      }
      let message: PanelWelcome | NodeRequestMessage | NodeCancelMessage | NodeStreamStartMessage | NodeStreamStopMessage | NodeTransferStartMessage | NodeTransferFinishMessage | NodeTransferResultMessage | NodeTransferCancelMessage;
      try {
        message = normalizePanelToNodeMessage(JSON.parse(rawBuffer.toString())) as typeof message;
      } catch {
        socket.close(1002, "Invalid panel protocol message");
        return;
      }
      if (message.type === "welcome") {
        if (!message.accepted) {
          console.error(`Node registration rejected: ${message.error ?? "unknown error"}`);
          socket.close();
          return;
        }
        if (message.protocolVersion !== nodeProtocolVersion) {
          socket.close(1002, `Panel negotiated unsupported protocol ${message.protocolVersion ?? "unknown"}`);
          return;
        }
        if ((message.features ?? []).some((feature) => !nodeFeatures.includes(feature))) {
          socket.close(1002, "Panel negotiated an unsupported transport feature");
          return;
        }
        accepted = true;
        stableSessionTimer = setTimeout(() => { reconnectAttempt = 0; }, 15_000);
        stableSessionTimer.unref?.();
        if (reportedUpdateFailure) {
          clearStoredNodeUpdateFailure(reportedUpdateFailure.at);
          console.warn(`Reported the failed node update to the panel: ${reportedUpdateFailure.message}`);
          reportedUpdateFailure = undefined;
        }
        if (message.timeZone) {
          try {
            new Intl.DateTimeFormat("en-US", { timeZone: message.timeZone }).format(new Date());
            config.timeZone = message.timeZone;
            process.env.TZ = message.timeZone;
          } catch {
            console.warn(`Panel supplied an invalid time zone (${message.timeZone}); continuing with ${config.timeZone}.`);
          }
        }
        if (message.nodeSecret) {
          await writeNodeIdentity({ nodeId: message.nodeId, nodeSecret: message.nodeSecret });
          console.info(`Node registration accepted. Persisted node id ${message.nodeId}.`);
        } else {
          console.info(`Node session accepted for ${message.nodeId}.`);
        }
        return;
      }
      if (!accepted) {
        socket.close(1008, "Node session has not been accepted");
        return;
      }
      if (message.type === "cancel") {
        activeRequests.get(message.id)?.abort();
        activeRequests.delete(message.id);
        return;
      }
      if (message.type === "transferStart") {
        if (activeTransfers.size >= nodeProtocolMaxActiveTransfers) {
          socket.send(JSON.stringify({ type: "transferResult", id: message.id, ok: false, error: { code: "node_overloaded", message: "Node transfer limit reached", retryable: true } } satisfies NodeTransferResultMessage));
          return;
        }
        if (message.direction === "upload") {
          try {
            const prepared = await prepareBinaryUpload(message);
            const file = await open(prepared.temporaryPath, "wx");
            activeTransfers.set(message.id, { direction: "upload", prepared, file, expectedSize: message.size!, received: 0, hash: createHash("sha256"), writes: Promise.resolve() });
            socket.send(JSON.stringify({ type: "transferReady", id: message.id }));
          } catch (error) {
            socket.send(JSON.stringify({ type: "transferResult", id: message.id, ok: false, error: { code: "transfer_rejected", message: (error as Error).message } } satisfies NodeTransferResultMessage));
          }
          return;
        }
        const transfer: ActiveTransfer = { direction: "download", cancelled: false };
        activeTransfers.set(message.id, transfer);
        void (async () => {
          try {
            const prepared = await prepareBinaryDownload(message);
            transfer.stream = prepared.stream;
            await sendWebSocket(socket, JSON.stringify({ type: "transferReady", id: message.id, filename: prepared.filename, size: prepared.size }));
            const hash = createHash("sha256");
            let sent = 0;
            for await (const rawChunk of prepared.stream) {
              if (transfer.cancelled) throw new Error("Transfer was cancelled");
              const buffer = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
              for (let offset = 0; offset < buffer.byteLength; offset += nodeProtocolTransferChunkBytes) {
                const chunk = buffer.subarray(offset, offset + nodeProtocolTransferChunkBytes);
                hash.update(chunk);
                sent += chunk.byteLength;
                if (sent > (message.maxBytes ?? Number.MAX_SAFE_INTEGER)) throw new Error("Download exceeded its declared limit");
                await sendWebSocket(socket, encodeTransferChunk(message.id, chunk), true);
              }
            }
            if (prepared.size !== undefined && sent !== prepared.size) throw new Error(`Download declared ${prepared.size} bytes but streamed ${sent}`);
            await sendWebSocket(socket, JSON.stringify({ type: "transferFinish", id: message.id, size: sent, sha256: hash.digest("hex") } satisfies NodeTransferFinishMessage));
          } catch (error) {
            activeTransfers.delete(message.id);
            if (!transfer.cancelled && socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: "transferResult", id: message.id, ok: false, error: { code: "transfer_failed", message: (error as Error).message } } satisfies NodeTransferResultMessage));
            }
          }
        })();
        return;
      }
      if (message.type === "transferFinish") {
        const transfer = activeTransfers.get(message.id);
        if (!transfer || transfer.direction !== "upload") return;
        try {
          await transfer.writes;
          if (transfer.received !== transfer.expectedSize || transfer.received !== message.size || transfer.hash.digest("hex") !== message.sha256) {
            throw new Error("Transfer size or SHA-256 did not match");
          }
          await transfer.file.close();
          if (transfer.prepared.managedContentName) {
            const headerHandle = await open(transfer.prepared.temporaryPath, "r");
            try {
              const header = Buffer.alloc(4);
              const { bytesRead } = await headerHandle.read(header, 0, 4, 0);
              assertJarBuffer(header.subarray(0, bytesRead), transfer.prepared.managedContentName);
            } finally {
              await headerHandle.close();
            }
          }
          await rename(transfer.prepared.temporaryPath, transfer.prepared.targetPath);
          activeTransfers.delete(message.id);
          socket.send(JSON.stringify({ type: "transferResult", id: message.id, ok: true, result: { ok: true, path: transfer.prepared.publicTargetPath, size: transfer.received } } satisfies NodeTransferResultMessage));
        } catch (error) {
          await transfer.file.close().catch(() => undefined);
          await rm(transfer.prepared.temporaryPath, { force: true }).catch(() => undefined);
          activeTransfers.delete(message.id);
          socket.send(JSON.stringify({ type: "transferResult", id: message.id, ok: false, error: { code: "transfer_failed", message: (error as Error).message } } satisfies NodeTransferResultMessage));
        }
        return;
      }
      if (message.type === "transferResult") {
        const transfer = activeTransfers.get(message.id);
        if (transfer?.direction === "download") {
          transfer.cancelled = !message.ok;
          activeTransfers.delete(message.id);
        }
        return;
      }
      if (message.type === "transferCancel") {
        const transfer = activeTransfers.get(message.id);
        activeTransfers.delete(message.id);
        if (transfer?.direction === "upload") {
          await transfer.file.close().catch(() => undefined);
          await rm(transfer.prepared.temporaryPath, { force: true }).catch(() => undefined);
        } else if (transfer) {
          transfer.cancelled = true;
          if (transfer.stream && "destroy" in transfer.stream) (transfer.stream as { destroy: () => void }).destroy();
        }
        return;
      }
      if (message.type === "streamStart") {
        if (activeStreams.size >= nodeProtocolMaxActiveStreams && !activeStreams.has(message.id)) {
          sendStreamEnd(socket, message.id, { code: "node_overloaded", message: "Node stream limit reached", retryable: true });
          return;
        }
        activeStreams.get(message.id)?.();
        activeStreams.delete(message.id);
        if (message.command !== "server.console.stream" && message.command !== "files.archive.extract") {
          sendStreamData(socket, message.id, { type: "unavailable", message: `Unsupported node stream ${message.command}` });
          sendStreamEnd(socket, message.id, { code: "unsupported_stream", message: `Unsupported node stream ${message.command}` });
          return;
        }
        const server = (message.payload as { server?: ManagedServer } | undefined)?.server;
        if (!server) {
          sendStreamData(socket, message.id, { type: "unavailable", message: "server payload is required" });
          sendStreamEnd(socket, message.id, { code: "invalid_payload", message: "server payload is required" });
          return;
        }
        if (message.command === "files.archive.extract") {
          let completed = false;
          const cleanup = startArchiveExtractionStream(server, message.payload as Record<string, unknown>, message.id, socket, () => {
            completed = true;
            activeStreams.delete(message.id);
          });
          if (!completed) activeStreams.set(message.id, cleanup);
          return;
        }
        let completed = false;
        const cleanup = startConsoleStream(server, message.id, socket, () => {
          completed = true;
          activeStreams.delete(message.id);
        });
        if (!completed) activeStreams.set(message.id, cleanup);
        return;
      }
      if (message.type === "streamStop") {
        activeStreams.get(message.id)?.();
        activeStreams.delete(message.id);
        return;
      }
      if (message.type !== "request") return;
      if (activeRequests.size >= nodeProtocolMaxActiveRequests) {
        socket.send(JSON.stringify({ type: "response", id: message.id, ok: false, error: { code: "node_overloaded", message: "Node command limit reached", retryable: true } } satisfies NodeResponseMessage));
        return;
      }
      const controller = new AbortController();
      activeRequests.set(message.id, controller);
      const deadline = message.deadlineMs === undefined ? undefined : setTimeout(() => controller.abort(), message.deadlineMs);
      deadline?.unref?.();
      const response = async (): Promise<NodeResponseMessage> => {
        try {
          const result = await handleCommand(message.command, message.payload, controller.signal);
          if (controller.signal.aborted) return { type: "response", id: message.id, ok: false, error: { code: "command_cancelled", message: "Node command was cancelled", retryable: true } };
          return { type: "response", id: message.id, ok: true, result };
        } catch (error) {
          return { type: "response", id: message.id, ok: false, error: { code: controller.signal.aborted ? "command_cancelled" : "command_failed", message: controller.signal.aborted ? "Node command was cancelled" : (error as Error).message, details: detailedErrorMessage(error), retryable: controller.signal.aborted || undefined } };
        }
      };
      const result = await response();
      if (deadline) clearTimeout(deadline);
      activeRequests.delete(message.id);
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(result));
    });
    socket.on("close", (code, reason) => reconnect(`closed with code ${code}${reason.length ? ` (${reason.toString()})` : ""}`));
    socket.on("error", (error) => {
      console.error(`Node agent websocket error: ${(error as Error).message}`);
      socket.close();
    });
  };

  await connect();
  await new Promise(() => undefined);
}

export function newNodeSecret() {
  return randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
}
