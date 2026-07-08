import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, posix, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { totalmem } from "node:os";
import http from "node:http";
import WebSocket from "ws";
import { fetch } from "undici";
import { config, maxServerPort, minServerPort } from "../config.js";
import { appBuildId, appUserAgentFor, appVersion } from "../buildInfo.js";
import { ensureInsideServer, ensureWritableInsideServer, ensureWritableResolvedInsideServer, parseDockerPorts, safeInstalledModFilename, safeModFilename, validateExistingInsideServer } from "../core.js";
import { dockerAvailable, dockerBufferRequest, dockerErrorMessage, dockerJsonRequest, dockerRequest, sendDockerContainerStdinLine } from "../docker/dockerClient.js";
import { DockerLogDecoder, stripDockerLogHeaders } from "../docker/dockerLogs.js";
import { javaArgsToArgv, requireStrictBoolean, validateDockerContainerName, validateDockerImageName, validateJavaArgs, validateModrinthProjectId, validateModrinthVersionId, validateRuntimeJarFilename } from "../http/validation.js";
import { allowedForChannel, fetchProject, fetchProjectVersions, latestCompatibleProjectVersion, minecraftVersionsInclude, modrinthJarFile, modrinthServerSideSupported, modrinthVersionIsNewer, resolveModrinthProjectCompatibility, resolveSelectedProjectVersion, versionChannel } from "../modrinth/compatibility.js";
import { modrinthFetch } from "../modrinth/modrinthClient.js";
import { defaultServerJarProvider } from "../runtime/mcjarsProvider.js";
import { runtimeProfileForServer, runtimeTarget } from "../runtime/profile.js";
import type { ManagedServer, ManagedServerPort, ModCompatibility, ModrinthVersion, ReleaseChannel, ServerRuntimeProfile } from "../types.js";
import { queryMinecraftServer } from "../minecraftQuery.js";
import { configuredQueryExternalPort, minecraftQueryDisabled, resolveMinecraftQueryEndpoint } from "../queryEndpoint.js";
import { isNodeCapability, nodeCapabilities, nodeOperationContract, nodeProtocolVersion } from "./protocol.js";
import type { NodeHello, NodeRequestMessage, NodeResponseMessage, NodeStreamDataMessage, NodeStreamEndMessage, NodeStreamStartMessage, NodeStreamStopMessage, PanelWelcome } from "./protocol.js";
import { openStorageDatabase, type StorageDatabase } from "../storage/database.js";
import { initializeRuntimeDataRoot } from "../storage/runtimePaths.js";
import { defaultServerContainerName, newServerId, serverDirectory, serverStorageName } from "../storage/serverIdentity.js";

type NodeIdentity = { nodeId: string; nodeSecret: string };
type NodeUpdateRequest = {
  image?: string;
};
type NodeContainerInspect = {
  Id: string;
  Name?: string;
  State?: { Status?: string; Running?: boolean; StartedAt?: string; FinishedAt?: string; Health?: { Status?: string } };
  Config?: Record<string, unknown> & {
    Image?: string;
    Labels?: Record<string, string>;
    OpenStdin?: boolean;
    AttachStdin?: boolean;
  };
  HostConfig?: Record<string, unknown>;
  NetworkSettings?: {
    Networks?: Record<string, { IPAMConfig?: unknown; Aliases?: string[]; NetworkID?: string; EndpointID?: string; Gateway?: string; IPAddress?: string; IPPrefixLen?: number; IPv6Gateway?: string; GlobalIPv6Address?: string; GlobalIPv6PrefixLen?: number; MacAddress?: string; DriverOpts?: Record<string, string> }>;
  };
};
type DockerContainerListItem = {
  Id: string;
  Names?: string[];
  State?: string;
  Status?: string;
};
type DockerInfo = {
  MemTotal?: number;
};
type CreateInput = {
  nodeId?: string;
  displayName?: string;
  runtime?: {
    loader?: string;
    minecraftVersion?: string;
    loaderVersion?: string;
    serverJar?: string;
  };
  dockerContainer?: string;
  dockerImage?: string;
  dockerPorts?: string;
  queryPort?: string;
  javaArgs?: string;
  acceptEula?: boolean;
  serverPort?: string;
};
type UpdateInput = Omit<CreateInput, "nodeId" | "acceptEula">;

const nodeIdentityMetadataKey = "node.identity";
const nodeUpdateDir = config.paths.nodeUpdatesDir;
const serversRoot = resolve(config.nodeDataDir, "servers");
const editorFileSizeLimit = 2 * 1024 * 1024;
const fileUploadSizeLimit = 32 * 1024 * 1024;
const uploadLimit = 128 * 1024 * 1024;
const reconnectDelayMs = 5000;
const stoppedServerMutationMessage = "Stop the server before changing mods or server properties.";
const stoppedLikeDockerStates = new Set(["created", "dead", "exited"]);
const removablePreviousNodeStates = new Set(["created", "dead", "exited", "removing"]);

function detailedError(error: Error, details: string) {
  (error as Error & { details?: string }).details = details;
  return error;
}

function detailedErrorMessage(error: unknown) {
  if (error instanceof Error && "details" in error && typeof error.details === "string" && error.details.trim()) {
    return error.details.trim();
  }
  if (error instanceof Error) return `${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ""}`;
  return String(error);
}

let nodeStorageDatabase: StorageDatabase | undefined;

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
  const raw = typeof value === "string" ? value : "";
  const name = basename(raw).trim();
  if (!name || name !== raw || name === "." || name === "..") throw new Error("A valid file or folder name is required");
  if (name.length > 160 || /[<>:"/\\|?*\u0000-\u001f]/.test(name)) throw new Error("File or folder name contains unsafe characters");
  return name;
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
  const rel = relative(root, target).replaceAll("\\", "/");
  return rel ? `/${rel}` : "/";
}

function validateBase64Content(value: unknown, allowEmpty = false) {
  if (typeof value !== "string" || (!allowEmpty && !value) || !/^[a-zA-Z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error("Uploaded content must be valid base64");
  }
  return value;
}

function assertJarBuffer(buffer: Buffer) {
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b || ![0x03, 0x05, 0x07].includes(buffer[2])) {
    throw new Error("Uploaded mod must be a valid .jar file");
  }
}

function containerName(server: ManagedServer) {
  return validateDockerContainerName(server.dockerContainer?.trim() || defaultServerContainerName(server.id));
}

function runtimeConfigHash(server: ManagedServer) {
  const targetRuntime = runtimeTarget(server);
  return createHash("sha256").update(JSON.stringify({
    image: validateDockerImageName(server.dockerImage || dockerImage(targetRuntime.minecraftVersion)),
    ports: server.dockerPorts || "25565:25565/tcp",
    serverJar: validateRuntimeJarFilename(targetRuntime.serverJar || "fabric-server-launch.jar"),
    javaArgs: validateJavaArgs(server.javaArgs || "-Xms2G -Xmx4G"),
    tty: true
  })).digest("hex");
}

async function dockerServerRoot(server: ManagedServer) {
  const root = await serverRoot(server);
  const rel = relative(config.nodeDataDir, root);
  if (rel.startsWith("..") || rel === ".." || resolve(config.nodeDataDir, rel) !== root) {
    return root;
  }
  return join(config.nodeDockerDataDir, rel);
}

function dockerImage(version?: string) {
  const [major, minor, patch] = (version ?? "").split(".").map(Number);
  if (Number.isFinite(major) && major >= 26) return "eclipse-temurin:25-jre";
  if (major === 1 && Number.isFinite(minor) && minor >= 20 && (minor > 20 || (patch ?? 0) >= 5)) return "eclipse-temurin:21-jre";
  return "eclipse-temurin:17-jre";
}

function isValidServerPort(port: string) {
  if (!/^\d+$/.test(port)) return false;
  const value = Number(port);
  return value >= minServerPort && value <= maxServerPort;
}

function queryPortEntry(port: number, internalPort = port): ManagedServerPort {
  return {
    id: "minecraft-query",
    name: "Minecraft Query",
    type: "query",
    protocol: "udp",
    internalPort,
    externalPort: port,
    required: true,
    removable: false,
    advanced: true
  };
}

function queryPortFromInput(input: { queryPort?: string; dockerPorts?: string }) {
  if (input.queryPort?.trim() && isValidServerPort(input.queryPort.trim())) return Number(input.queryPort.trim());
  const udpBinding = (input.dockerPorts || "").split(",").map((part) => part.trim()).find((part) => part.endsWith("/udp"));
  const port = udpBinding?.split(":", 1)[0]?.trim();
  return port && isValidServerPort(port) ? Number(port) : 25566;
}

function queryPortForServer(server: ManagedServer, props: Record<string, string> = {}) {
  const stored = configuredQueryExternalPort(server, props);
  if (stored) return stored;
  if (props["query.port"] && isValidServerPort(props["query.port"])) return Number(props["query.port"]);
  return queryPortFromInput({ dockerPorts: server.dockerPorts });
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

function parseProperties(text: string) {
  const values: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator === -1) continue;
    values[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return values;
}

function serializeProperties(values: Record<string, string>) {
  return Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n") + "\n";
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
    fabricLoaderVersion: targetRuntime.loaderVersion,
    createdAt,
    updatedAt: now
  }, null, 2)}\n`, "utf8");
}

async function pullImage(image: string) {
  validateDockerImageName(image);
  const [fromImage, tag] = image.includes(":") ? image.split(/:(.*)/, 2) : [image, "latest"];
  await dockerBufferRequest("POST", `/images/create?fromImage=${encodeURIComponent(fromImage)}&tag=${encodeURIComponent(tag || "latest")}`, [200, 201]);
}

async function createContainer(server: ManagedServer) {
  const targetRuntime = runtimeTarget(server);
  const image = validateDockerImageName(server.dockerImage || dockerImage(targetRuntime.minecraftVersion));
  await pullImage(image);
  const root = await dockerServerRoot(server);
  const binds = [`${root}:/data`];
  const { exposedPorts, portBindings } = parseDockerPorts(server.dockerPorts ?? "25565:25565/tcp");
  const command = minecraftContainerCommand(server);
  await dockerJsonRequest("POST", `/containers/create?name=${encodeURIComponent(validateDockerContainerName(containerName(server)))}`, {
    Image: image,
    WorkingDir: "/data",
    Cmd: command,
    OpenStdin: true,
    AttachStdin: true,
    Tty: true,
    ExposedPorts: exposedPorts,
    HostConfig: { Binds: binds, PortBindings: portBindings, RestartPolicy: { Name: "unless-stopped" } },
    NetworkingConfig: createNetworkingConfig(await inspectCurrentContainer()),
    Labels: { "serversentinel.managed": "true", "serversentinel.serverId": server.id, "serversentinel.config-hash": runtimeConfigHash(server) }
  }, [201, 409]);
}

function minecraftContainerCommand(server: ManagedServer) {
  const targetRuntime = runtimeTarget(server);
  const serverJar = validateRuntimeJarFilename(targetRuntime.serverJar ?? "fabric-server-launch.jar");
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
  if (details.Config?.Labels?.["serversentinel.managed"] !== "true" || details.Config?.Labels?.["serversentinel.serverId"] !== server.id) {
    throw new Error(`Container ${containerName(server)} exists but is not managed by serverSENTINEL; refusing to delete it`);
  }
  await dockerRequest("DELETE", `/containers/${encodeURIComponent(containerName(server))}?force=1`, [204, 404]);
  return true;
}

async function ensureContainer(server: ManagedServer) {
  const details = await inspect(server).catch(() => null) as NodeContainerInspect | null;
  if (!details) {
    await createContainer(server);
    return;
  }
  if (details.Config?.Labels?.["serversentinel.managed"] !== "true" || details.Config?.Labels?.["serversentinel.serverId"] !== server.id) {
    throw new Error(`Container ${containerName(server)} exists but is not managed by serverSENTINEL; refusing to control it`);
  }
  if (details.Config?.Labels?.["serversentinel.config-hash"] !== runtimeConfigHash(server) || !details.Config?.OpenStdin || !details.Config?.AttachStdin) {
    await removeManagedContainer(server);
    await createContainer(server);
  }
}

async function downloadFabricJar(server: ManagedServer) {
  const profile = runtimeProfileForServer(server);
  const artifact = profile?.jarArtifact;
  if (!artifact?.downloadUrl) throw new Error("A resolved Fabric runtime profile is required before downloading the server jar");
  if (!artifact.downloadUrl.startsWith("https://")) throw new Error("Refusing to download a non-HTTPS Fabric server jar");
  const res = await fetch(artifact.downloadUrl, {
    headers: { "User-Agent": appUserAgentFor("node Fabric runtime downloader") }
  });
  if (!res.ok || !res.body) {
    const body = !res.ok ? await res.text().catch(() => "") : "";
    const details = `Fabric server launcher download failed\nurl=${artifact.downloadUrl}\nstatus=${res.status} ${res.statusText}\nbody=${body || "(empty)"}`;
    console.error(details);
    throw detailedError(new Error(`Fabric server download failed: ${res.status} ${res.statusText}`), details);
  }
  const target = await writableInside(server, artifact.filename);
  await writeFile(target, Buffer.from(await res.arrayBuffer()));
}

function createdServerRecord(input: CreateInput, resolvedRuntime: ServerRuntimeProfile, now = new Date().toISOString()) {
  const displayName = input.displayName?.trim();
  const selectedRuntime = runtimeSelection(input.runtime);
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
  const dockerImageName = validateDockerImageName(input.dockerImage?.trim() || dockerImage(runtimeProfile.minecraftVersion));
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

async function createServer(input: CreateInput) {
  const displayName = input.displayName?.trim();
  const selectedRuntime = runtimeSelection(input.runtime);
  if (!displayName || displayName.length > 80 || !selectedRuntime.minecraftVersion) throw new Error("Display name and Minecraft version are required");
  if (input.acceptEula !== true) throw new Error("Minecraft EULA acceptance is required");
  validateJavaArgs(input.javaArgs?.trim() || "-Xms2G -Xmx4G");
  const resolvedRuntime = await defaultServerJarProvider.resolveFabricServerJar({
    minecraftVersion: selectedRuntime.minecraftVersion,
    loaderVersion: selectedRuntime.loaderVersion || "latest",
    preferStable: true
  });
  const { server, serverPort, queryPort } = createdServerRecord(input, resolvedRuntime);
  await mkdir(await serverRoot(server), { recursive: true });
  await mkdir(await inside(server, "logs", false), { recursive: true });
  await writeFile(await writableInside(server, "server.properties"), serializeProperties({
    "server-port": serverPort,
    "enable-query": "true",
    "query.port": String(queryPort)
  }), { flag: "wx" }).catch((e: any) => { if (e.code !== "EEXIST") throw e; });
  await writeFile(await writableInside(server, "eula.txt"), `eula=${input.acceptEula ? "true" : "false"}\n`, "utf8");
  await writeFile(await writableInside(server, "logs/latest.log"), "", { flag: "a" });
  await downloadFabricJar(server);
  if (dockerAvailable()) await ensureContainer(server);
  return server;
}

async function updateServer(server: ManagedServer, input: UpdateInput) {
  const status = await runtimeStatus(server);
  await requireStoppedForMutableConfiguration(server);
  const running = (status as { docker?: { running?: boolean } }).docker?.running === true;

  const currentRuntime = runtimeProfileForServer(server);
  const selectedRuntime = input.runtime === undefined ? undefined : runtimeSelection(input.runtime);
  const minecraftVersion = selectedRuntime?.minecraftVersion || currentRuntime.minecraftVersion;
  if (!minecraftVersion) throw new Error("Minecraft version is required");
  const requestedLoaderVersion = selectedRuntime?.loaderVersion || currentRuntime.loaderVersion || "latest";
  const serverJar = selectedRuntime?.serverJar || currentRuntime.jarArtifact.filename || "fabric-server-launch.jar";
  const resolvedRuntime = selectedRuntime?.minecraftVersion !== undefined || selectedRuntime?.loaderVersion !== undefined
    ? await defaultServerJarProvider.resolveFabricServerJar({ minecraftVersion, loaderVersion: requestedLoaderVersion, preferStable: true })
    : currentRuntime;
  const runtimeProfile: ServerRuntimeProfile = {
    ...resolvedRuntime,
    jarArtifact: {
      ...resolvedRuntime.jarArtifact,
      filename: serverJar
    }
  };
  const serverPort = input.serverPort?.trim();
  if (serverPort && !isValidServerPort(serverPort)) {
    throw new Error(`Server port must be between ${minServerPort} and ${maxServerPort}`);
  }
  const dockerContainer = validateDockerContainerName(input.dockerContainer?.trim() || server.dockerContainer || defaultServerContainerName(server.id));
  const dockerImageName = validateDockerImageName(input.dockerImage?.trim() || server.dockerImage || dockerImage(runtimeProfile.minecraftVersion));
  const requestedDockerPorts = input.dockerPorts?.trim() || (serverPort ? `${serverPort}:${serverPort}/tcp` : server.dockerPorts);
  const queryPort = queryPortFromInput({ queryPort: input.queryPort, dockerPorts: requestedDockerPorts });
  const dockerPorts = requestedDockerPorts ? ensureQueryDockerPort(requestedDockerPorts, queryPort) : requestedDockerPorts;
  if (dockerPorts) parseDockerPorts(dockerPorts);
  const javaArgs = validateJavaArgs(input.javaArgs?.trim() || server.javaArgs || "-Xms2G -Xmx4G");

  const jarChanged = currentRuntime.minecraftVersion !== minecraftVersion
    || currentRuntime.loaderVersion !== runtimeProfile.loaderVersion
    || currentRuntime.jarArtifact.filename !== serverJar
    || server.runtimeProfile.jarArtifact.downloadUrl !== runtimeProfile.jarArtifact.downloadUrl;
  const containerConfigChanged = server.dockerContainer !== dockerContainer
    || server.dockerImage !== dockerImageName
    || server.dockerPorts !== dockerPorts
    || server.javaArgs !== javaArgs
    || currentRuntime.jarArtifact.filename !== serverJar;
  const updated: ManagedServer = {
    ...server,
    displayName: input.displayName?.trim() || server.displayName,
    runtimeProfile,
    dockerContainer,
    dockerImage: dockerImageName,
    dockerPorts,
    managedPorts: [queryPortEntry(queryPort)],
    javaArgs,
    updatedAt: new Date().toISOString()
  };

  if (jarChanged) {
    await downloadFabricJar(updated);
  }
  await writeVersionMetadata(updated);
  if (serverPort || queryPort !== server.managedPorts?.find((port) => port.type === "query")?.externalPort) {
    const propertiesPath = await writableInside(updated, "server.properties");
    let props: Record<string, string> = {};
    try {
      props = parseProperties(await readFile(propertiesPath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await writeFile(propertiesPath, serializeProperties({
      ...props,
      ...(serverPort ? { "server-port": serverPort } : {}),
      "enable-query": "true",
      "query.port": String(queryPort)
    }), "utf8");
  }
  if (containerConfigChanged && dockerAvailable() && !running) {
    await removeManagedContainer(server);
    await ensureContainer(updated);
  }
  return updated;
}

async function inspect(server: ManagedServer) {
  return dockerRequest("GET", `/containers/${encodeURIComponent(containerName(server))}/json`);
}

async function runtimeStatus(server: ManagedServer) {
  const details = await inspect(server).catch(() => null) as NodeContainerInspect | null;
  const running = Boolean(details?.State?.Running);
  const managed = details?.Config?.Labels?.["serversentinel.managed"] === "true";
  const stdinReady = Boolean(details?.Config?.OpenStdin && details?.Config?.AttachStdin);
  return {
    server,
    docker: {
      configured: Boolean(server.dockerContainer),
      available: dockerAvailable(),
      controllable: Boolean(details),
      state: details?.State?.Status ?? "unknown",
      running,
      container: containerName(server),
      startedAt: details?.State?.StartedAt,
      finishedAt: details?.State?.FinishedAt,
      message: details ? "" : "Container not found on remote node"
    },
    fileLogsAvailable: existsSync(await inside(server, "logs/latest.log", false)),
    controlAvailable: Boolean(details),
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

async function requireStoppedForMutableConfiguration(server: ManagedServer) {
  const status = await runtimeStatus(server) as { docker?: { configured?: boolean; available?: boolean; running?: boolean; state?: string; message?: string } };
  if (status.docker?.running) throw new Error(stoppedServerMutationMessage);
  const state = status.docker?.state || "";
  if (state === "unknown") {
    if (status.docker?.configured === false) return;
    throw new Error(stoppedServerMutationMessage);
  }
  if (state && !stoppedLikeDockerStates.has(state)) throw new Error(stoppedServerMutationMessage);
}

function isMutableConfigurationPath(path: unknown) {
  const normalized = safeRelative(path);
  return normalized === "server.properties" || normalized === "mods" || normalized.startsWith("mods/");
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

async function detectedTotalMemory() {
  if (dockerAvailable()) {
    try {
      const info = await dockerRequest<DockerInfo>("GET", "/info");
      if (typeof info.MemTotal === "number" && info.MemTotal > 0) {
        return info.MemTotal;
      }
    } catch {
      // Fall through to Node's view when Docker host info cannot be read.
    }
  }
  return totalmem();
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

async function dockerInfo() {
  return { available: dockerAvailable(), info: dockerAvailable() ? await dockerRequest("GET", "/info").catch((error) => ({ error: (error as Error).message })) : undefined };
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

function validateNodeDockerImageName(image: string) {
  const value = image.trim();
  if (!value || value.length > 255 || /\s/.test(value) || !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(value)) {
    throw new Error("Docker image name contains invalid characters");
  }
  return value;
}

function createNetworkingConfig(inspect?: NodeContainerInspect | null) {
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

async function prepareNodeUpdate(payload: unknown) {
  const input = (typeof payload === "object" && payload !== null ? payload : {}) as NodeUpdateRequest;
  const image = validateNodeDockerImageName(typeof input.image === "string" && input.image.trim() ? input.image.trim() : config.nodeImage || `nl2109/serversentinel:${appVersion}`);
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

  setTimeout(() => {
    void selfUpdateContainer(inspect, image, currentName, planPath).catch((error) => {
      void writeFile(join(nodeUpdateDir, `node-update-error-${Date.now()}.json`), `${JSON.stringify({
        at: new Date().toISOString(),
        image,
        containerName: currentName,
        planPath,
        error: (error as Error).message
      }, null, 2)}\n`, "utf8").catch(() => null);
      console.error(`Node self-update failed: ${(error as Error).message}`);
    });
  }, 500);

  return {
    ok: true,
    mode: "self",
    message: "Node update started. The node will reconnect shortly. After the replacement is running and healthy, the previous node container will be removed; if startup fails, it will be retained for recovery.",
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

async function selfUpdateContainer(inspect: NodeContainerInspect, image: string, currentName: string, planPath: string) {
  await mkdir(nodeUpdateDir, { recursive: true });
  await dockerBufferRequest("POST", `/images/create?fromImage=${encodeURIComponent(image)}`, [200, 201, 204], 10 * 60 * 1000);
  const oldName = `${currentName}-previous-${Date.now()}`;
  await dockerRequest("POST", `/containers/${encodeURIComponent(inspect.Id)}/rename?name=${encodeURIComponent(oldName)}`, 204);

  const configBody = {
    ...inspect.Config,
    Image: image,
    Hostname: undefined,
    Domainname: undefined,
    MacAddress: undefined,
    NetworkDisabled: undefined,
    HostConfig: inspect.HostConfig,
    NetworkingConfig: createNetworkingConfig(inspect)
  };
  await dockerJsonRequest("POST", `/containers/create?name=${encodeURIComponent(currentName)}`, configBody, 201);
  await writeFile(join(nodeUpdateDir, `node-update-status-${Date.now()}.json`), `${JSON.stringify({ updatedAt: new Date().toISOString(), image, currentName, oldName, planPath, status: "created" }, null, 2)}\n`, "utf8");
  await dockerRequest("POST", `/containers/${encodeURIComponent(currentName)}/start`, 204);
  await verifyUpdatedNodeContainer(currentName);
  await cleanupPreviousNodeContainers(currentName, oldName);
  await writeFile(join(nodeUpdateDir, `node-update-status-${Date.now()}.json`), `${JSON.stringify({ updatedAt: new Date().toISOString(), image, currentName, oldName, planPath, status: "healthy", cleanup: "previous-container-removed" }, null, 2)}\n`, "utf8");
}

async function verifyUpdatedNodeContainer(currentName: string) {
  let lastInspect: NodeContainerInspect | undefined;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    lastInspect = await inspectNodeContainer(currentName);
    const state = lastInspect.State;
    const health = state?.Health?.Status;
    if (state?.Running && (!health || health === "healthy")) return lastInspect;
    if (health === "unhealthy") {
      throw new Error(`Updated node container ${currentName} reported unhealthy. Previous container was retained for recovery.`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
  }
  const status = lastInspect?.State?.Status || "unknown";
  const health = lastInspect?.State?.Health?.Status;
  throw new Error(`Updated node container ${currentName} did not become healthy enough to remove the previous container. Current status: ${status}${health ? `, health: ${health}` : ""}. Previous container was retained for recovery.`);
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
  const root = await serverRoot(server);
  const target = await inside(server, path);
  const st = await stat(target);
  if (!st.isDirectory()) throw new Error("Path is not a directory");
  const entries = await readdir(target, { withFileTypes: true });
  return {
    path: publicPath(root, target),
    entries: await Promise.all(entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name)).map(async (entry) => {
      const entryPath = join(target, entry.name);
      const entryStat = await lstat(entryPath);
      return { name: entry.name, path: publicPath(root, entryPath), type: entry.isDirectory() ? "directory" : "file", size: entryStat.size, modifiedAt: entryStat.mtime.toISOString(), status: "managed" };
    }))
  };
}

async function fileRead(server: ManagedServer, path: unknown, preview = false) {
  const root = await serverRoot(server);
  const target = await inside(server, path);
  const st = await stat(target);
  if (!st.isFile()) throw new Error("Path is not a file");
  if (st.size > editorFileSizeLimit) return preview ? { path: publicPath(root, target), preview: "too_large", message: "File too large to preview" } : (() => { throw new Error("File is larger than the editor limit"); })();
  const content = await readFile(target);
  if (content.includes(0)) return preview ? { path: publicPath(root, target), preview: "binary", message: "Preview unavailable" } : (() => { throw new Error("Binary files cannot be edited"); })();
  return preview ? { path: publicPath(root, target), preview: "text", content: content.toString("utf8"), modifiedAt: st.mtime.toISOString() } : { path: publicPath(root, target), content: content.toString("utf8"), modifiedAt: st.mtime.toISOString() };
}

async function fileDownload(server: ManagedServer, path: unknown) {
  const target = await inside(server, path);
  const st = await stat(target);
  if (!st.isFile() || st.size > uploadLimit) throw new Error("Only files up to the transfer limit can be downloaded");
  return { filename: basename(target), size: st.size, contentBase64: (await readFile(target)).toString("base64") };
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
  if (typeof content !== "string") throw new Error("Content is required");
  if (Buffer.byteLength(content, "utf8") > editorFileSizeLimit) throw new Error("File content is larger than the editor limit");
  if (content.includes("\0")) throw new Error("Binary files cannot be edited");
  const root = await serverRoot(server);
  const target = await inside(server, path);
  const targetStat = await stat(target);
  if (!targetStat.isFile()) throw new Error("Path is not a file");
  await writeFile(target, content, "utf8");
  return { ok: true, path: publicPath(root, target) };
}

async function uploadFile(server: ManagedServer, parentInput: unknown, filenameInput: unknown, contentBase64Input: unknown) {
  const parent = await inside(server, parentInput);
  const parentStat = await stat(parent);
  if (!parentStat.isDirectory()) throw new Error("Upload path is not a directory");
  const contentBase64 = validateBase64Content(contentBase64Input, true);
  const content = Buffer.from(contentBase64, "base64");
  if (content.length > fileUploadSizeLimit) throw new Error(`Upload is larger than ${Math.floor(fileUploadSizeLimit / 1024 / 1024)} MiB`);
  const root = await serverRoot(server);
  const target = await writableResolvedInside(server, join(parent, safeName(filenameInput)));
  if (existsSync(target)) throw new Error("A file or folder with that name already exists");
  await writeFile(target, content);
  return { ok: true, path: publicPath(root, target), size: content.length };
}

function remoteInstalledModCompatibility(server: ManagedServer, version: ModrinthVersion, project: { server_side?: string; client_side?: string }): ModCompatibility {
  const target = runtimeTarget(server);
  const serverSide = project.server_side;
  const clientSide = project.client_side;

  if (!target.minecraftVersion || target.loader !== "fabric") {
    return { status: "unknown", compatible: false, reason: "A resolved Fabric runtime profile is required to verify compatibility.", serverSide, clientSide };
  }
  if (serverSide === "unsupported") {
    return { status: "incompatible", compatible: false, reason: "Client-only mod; server-side support is unsupported", serverSide, clientSide };
  }
  if (serverSide === "unknown") {
    return { status: "unknown", compatible: false, reason: "Server-side support could not be verified", serverSide, clientSide };
  }
  if (!version.loaders.includes(target.loader)) {
    return { status: "no_fabric", compatible: false, reason: "This mod does not advertise Fabric support.", serverSide, clientSide };
  }
  if (!minecraftVersionsInclude(version.game_versions, target.minecraftVersion)) {
    return {
      status: "no_minecraft_version",
      compatible: false,
      reason: `This mod was installed for Minecraft ${version.game_versions.join(", ") || "unknown"}, but this server is ${target.minecraftVersion}.`,
      serverSide,
      clientSide
    };
  }
  if (!modrinthServerSideSupported(serverSide)) {
    return { status: "incompatible", compatible: false, reason: "Server-side support could not be verified.", serverSide, clientSide };
  }
  const file = modrinthJarFile(version);
  return {
    status: "compatible",
    compatible: true,
    reason: "Compatibility verified for this server.",
    matchedVersionId: version.id,
    matchedVersionNumber: version.version_number,
    matchedVersionType: versionChannel(version.version_type),
    matchedLoaders: version.loaders,
    matchedGameVersions: version.game_versions,
    file,
    serverSide,
    clientSide
  };
}

async function remoteLookupModrinthUpdate(server: ManagedServer, version: ModrinthVersion, preferredChannel: ReleaseChannel, options: { forceRefresh?: boolean } = {}) {
  const target = runtimeTarget(server);
  if (!target.minecraftVersion || target.loader !== "fabric" || !version.project_id) return null;

  const versionFilter = {
    loader: target.loader,
    minecraftVersion: target.minecraftVersion
  };
  const versions = await fetchProjectVersions(version.project_id, versionFilter, options);
  let latest = latestCompatibleProjectVersion(versions, { ...versionFilter, channel: preferredChannel });
  if (!latest) {
    latest = latestCompatibleProjectVersion(await fetchProjectVersions(version.project_id, undefined, options), { ...versionFilter, channel: preferredChannel });
  }
  if (allowedForChannel(version, preferredChannel)
    && version.loaders.includes(versionFilter.loader)
    && minecraftVersionsInclude(version.game_versions, versionFilter.minecraftVersion)
    && modrinthJarFile(version)
    && modrinthVersionIsNewer(version, latest)
  ) {
    latest = version;
  }
  return {
    projectId: version.project_id,
    currentVersion: version.version_number,
    currentChannel: versionChannel(version.version_type),
    latestVersion: latest?.version_number,
    latestVersionId: latest?.id,
    latestFilename: modrinthJarFile(latest)?.filename,
    latestChannel: latest ? versionChannel(latest.version_type) : undefined,
    upToDate: Boolean(latest && version.version_number === latest.version_number)
  };
}

async function modsList(server: ManagedServer, options: { forceRefresh?: boolean } = {}) {
  await mkdir(await inside(server, "mods", false), { recursive: true });
  const listing = await fileList(server, "mods") as any;
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
          compatibility: { status: "unknown", compatible: false, reason: "Remote mod metadata sync pending" }
        };
        try {
          const target = await inside(server, posix.join("mods", filename));
          const hash = createHash("sha1").update(await readFile(target)).digest("hex");
          const versionResponse = await modrinthFetch(`https://api.modrinth.com/v2/version_file/${hash}?algorithm=sha1`);
          const version = await versionResponse.json() as ModrinthVersion;
          if (!version?.project_id) return base;
          const project = await fetchProject(version.project_id);
          const primaryFile = version.files?.find((file: any) => file.hashes?.sha1 === hash || file.primary);
          return {
            ...base,
            iconUrl: project.icon_url,
            compatibility: remoteInstalledModCompatibility(server, version, project),
            versionInfo: await remoteLookupModrinthUpdate(server, version, base.preferredChannel, options),
            modrinth: {
              projectId: version.project_id,
              versionId: version.id,
              filename,
              versionNumber: version.version_number,
              versionType: version.version_type,
              gameVersions: version.game_versions ?? [],
              loaders: version.loaders ?? [],
              hashes: primaryFile?.hashes ?? { sha1: hash },
              installedAt: new Date().toISOString(),
              installedWithForceIncompatible: false,
              clientSide: project.client_side,
              serverSide: project.server_side
            }
          };
        } catch {
          return base;
        }
      })
  );
  return { mods };
}

async function modUpload(server: ManagedServer, filename: unknown, contentBase64: unknown) {
  const name = safeModFilename(safeInstalledModFilename(filename as string | undefined));
  if (!name.endsWith(".jar")) throw new Error("Mod uploads must be .jar files");
  const content = Buffer.from(validateBase64Content(contentBase64), "base64");
  if (!content.length || content.length > uploadLimit) throw new Error(`Uploaded mod must be between 1 byte and ${Math.floor(uploadLimit / 1024 / 1024)} MiB`);
  assertJarBuffer(content);
  await mkdir(await inside(server, "mods", false), { recursive: true });
  await inside(server, "mods");
  return writeRelativeFile(server, posix.join("mods", name), content);
}

async function modInstall(server: ManagedServer, input: unknown) {
  const payload = typeof input === "object" && input !== null ? input as Record<string, unknown> : {};
  const projectId = validateModrinthProjectId(payload.projectId);
  const versionId = validateModrinthVersionId(payload.versionId);
  const forceIncompatible = payload.forceIncompatible === true;
  const overrideMinecraftVersion = payload.overrideMinecraftVersion === true;
  const channel: ReleaseChannel = payload.channel === "alpha" || payload.channel === "beta" ? payload.channel : "release";
  const targetRuntime = runtimeTarget(server);
  if (!targetRuntime.minecraftVersion || targetRuntime.loader !== "fabric") throw new Error("A resolved Fabric runtime profile is required before installing compatible mods");

  if (!versionId) {
    const compatibility = await resolveModrinthProjectCompatibility({ projectId, minecraftVersion: targetRuntime.minecraftVersion, loader: targetRuntime.loader, channel });
    if (!compatibility.compatible && !forceIncompatible) throw new Error(`${compatibility.reason}. Set forceIncompatible to true to install anyway.`);
    const file = compatibility.file;
    if (!file?.url || !file.filename) throw new Error("No installable jar found");
    if (!file.url.startsWith("https://")) throw new Error("Refusing to download a non-HTTPS mod file");
    if (file.size && file.size > uploadLimit) throw new Error(`Mod download is larger than ${Math.floor(uploadLimit / 1024 / 1024)} MiB`);
    const response = await modrinthFetch(file.url);
    if (!response.ok) throw new Error(`Mod download failed: ${response.statusText}`);
    const content = Buffer.from(await response.arrayBuffer());
    const written = await modUpload(server, safeModFilename(file.filename), content.toString("base64"));
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
  if (!allowedForChannel(selectedVersion, channel)) throw new Error("The selected version is outside the requested release channel");
  const file = modrinthJarFile(selectedVersion);
  if (!file?.url || !file.filename) throw new Error("No installable jar found");
  if (!selectedVersion.loaders.includes("fabric")) throw new Error("The selected version is not a Fabric version");
  if (project.server_side === "unsupported") throw new Error("Client-only mods cannot be installed on the server");
  const matchesMinecraft = minecraftVersionsInclude(selectedVersion.game_versions, targetRuntime.minecraftVersion);
  if (!matchesMinecraft && !overrideMinecraftVersion) throw new Error(`This version is not marked for Minecraft ${targetRuntime.minecraftVersion}. Confirm the Minecraft version override before installing.`);
  if (!matchesMinecraft && !forceIncompatible) throw new Error("Set forceIncompatible to true when installing a Minecraft version override.");
  if (!file.url.startsWith("https://")) throw new Error("Refusing to download a non-HTTPS mod file");
  if (file.size && file.size > uploadLimit) throw new Error(`Mod download is larger than ${Math.floor(uploadLimit / 1024 / 1024)} MiB`);
  const response = await modrinthFetch(file.url);
  if (!response.ok) throw new Error(`Mod download failed: ${response.statusText}`);
  const content = Buffer.from(await response.arrayBuffer());
  const written = await modUpload(server, safeModFilename(file.filename), content.toString("base64"));
  return {
    ...written,
    filename: file.filename,
    projectId,
    version: selectedVersion.version_number,
    channel: versionChannel(selectedVersion.version_type),
    compatibility: {
      status: matchesMinecraft ? "compatible" : "incompatible",
      compatible: matchesMinecraft,
      reason: matchesMinecraft ? "Compatible server-side Fabric mod" : "Installed with Minecraft version override",
      matchedVersionId: selectedVersion.id,
      matchedVersionNumber: selectedVersion.version_number,
      matchedVersionType: versionChannel(selectedVersion.version_type),
      matchedLoaders: selectedVersion.loaders,
      matchedGameVersions: selectedVersion.game_versions,
      file,
      serverSide: project.server_side,
      clientSide: project.client_side
    }
  };
}

async function handleCommand(command: string, payload: any) {
  if (!isNodeCapability(command)) {
    throw new Error(`Unsupported node command ${command}`);
  }
  const server = payload?.server as ManagedServer | undefined;
  if (command === "node.health") return { ok: true, dockerAvailable: dockerAvailable(), dataPath: config.nodeDataDir, totalMemory: await detectedTotalMemory() };
  if (command === "node.update") return prepareNodeUpdate(payload);
  if (command === "node.restart") return prepareNodeRestart();
  if (command === "node.remove") return prepareNodeRemoval();
  if (command === "docker.info") return dockerInfo();
  if (command === "server.create") return createServer(payload?.input as CreateInput);
  if (!server) throw new Error("server payload is required");
  const name = encodeURIComponent(containerName(server));
  if (command === "server.update") {
    await requireStoppedForMutableConfiguration(server);
    return updateServer(server, payload?.input as UpdateInput);
  }
  if (command === "server.delete") {
    const status = await inspect(server).catch(() => null) as any;
    if (status?.State?.Running) throw new Error("Stop the server before deleting it");
    const deletedContainer = await removeManagedContainer(server);
    if (payload?.input?.deleteFiles) await rm(await serverRoot(server), { recursive: true, force: true });
    return { ok: true, deletedContainer, deletedFiles: Boolean(payload?.input?.deleteFiles) };
  }
  if (command === "server.inspect") return runtimeStatus(server);
  if (command === "server.queryMetrics") {
    const propsPath = await inside(server, "server.properties", false);
    const props = parseProperties(await readFile(propsPath, "utf8").catch(() => ""));
    if (minecraftQueryDisabled(props)) return { responding: false, playersOnline: null, maxPlayers: null, diagnostics: ["Minecraft Query is disabled in server.properties."] };
    const minecraftInspect = await inspect(server).catch(() => null) as NodeContainerInspect | null;
    const callerInspect = await inspectCurrentContainer().catch(() => null);
    const endpoint = resolveMinecraftQueryEndpoint(server, props, minecraftInspect, callerInspect);
    if (!endpoint) return { responding: false, playersOnline: null, maxPlayers: null, diagnostics: ["Minecraft Query endpoint could not be resolved."] };
    return queryMinecraftServer(endpoint.host, endpoint.port).catch((error) => ({ responding: false, playersOnline: null, maxPlayers: null, diagnostics: [...endpoint.diagnostics, error instanceof Error ? error.message : String(error)] }));
  }
  if (command === "server.start") { await ensureContainer(server); await dockerRequest("POST", `/containers/${name}/start`, [204, 304]); return runtimeStatus(server); }
  if (command === "server.stop") { await dockerRequest("POST", `/containers/${name}/stop?t=10`, [204, 304]); return runtimeStatus(server); }
  if (command === "server.restart") { await ensureContainer(server); await dockerRequest("POST", `/containers/${name}/restart?t=10`, 204); return runtimeStatus(server); }
  if (command === "server.stats") {
    const status = await runtimeStatus(server) as any;
    if (!status.docker.running) return { available: true, running: false, cpuPercent: 0, memoryUsageBytes: 0, memoryLimitBytes: 0, networkRxBytes: 0, networkTxBytes: 0, sampledAt: new Date().toISOString() };
    const stats = await dockerRequest<any>("GET", `/containers/${name}/stats?stream=false`);
    const cpuDelta = (stats.cpu_stats?.cpu_usage?.total_usage ?? 0) - (stats.precpu_stats?.cpu_usage?.total_usage ?? 0);
    const systemDelta = (stats.cpu_stats?.system_cpu_usage ?? 0) - (stats.precpu_stats?.system_cpu_usage ?? 0);
    const cpuPercent = systemDelta > 0 ? (cpuDelta / systemDelta) * (stats.cpu_stats?.online_cpus ?? 1) * 100 : 0;
    const networks = Object.values(stats.networks ?? {}) as Array<{ rx_bytes?: number; tx_bytes?: number }>;
    return { available: true, running: true, cpuPercent, memoryUsageBytes: stats.memory_stats?.usage ?? 0, memoryLimitBytes: stats.memory_stats?.limit ?? 0, networkRxBytes: networks.reduce((sum, n) => sum + (n.rx_bytes ?? 0), 0), networkTxBytes: networks.reduce((sum, n) => sum + (n.tx_bytes ?? 0), 0), sampledAt: new Date().toISOString() };
  }
  if (command === "server.logs.recent") return { text: stripDockerLogHeaders(await dockerBufferRequest("GET", `/containers/${name}/logs?stdout=1&stderr=1&tail=300`)).toString("utf8"), source: "docker" };
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
  if (command === "files.read") return fileRead(server, payload?.path, Boolean(payload?.preview));
  if (command === "files.download") return fileDownload(server, payload?.path);
  if (command === "files.write") {
    if (isMutableConfigurationPath(payload?.path)) await requireStoppedForMutableConfiguration(server);
    return writeEditableFile(server, payload?.path, payload?.content);
  }
  if (command === "files.upload") {
    if (isMutableConfigurationPath(posix.join(safeRelative(payload?.parent), safeName(payload?.filename)))) await requireStoppedForMutableConfiguration(server);
    return uploadFile(server, payload?.parent, payload?.filename, payload?.contentBase64);
  }
  if (command === "files.mkdir") {
    if (isMutableConfigurationPath(payload?.parent)) await requireStoppedForMutableConfiguration(server);
    const root = await serverRoot(server);
    const parent = await inside(server, payload?.parent);
    const parentStat = await stat(parent);
    if (!parentStat.isDirectory()) throw new Error("Parent path is not a directory");
    const target = await writableResolvedInside(server, join(parent, safeName(payload?.name)));
    if (existsSync(target)) throw new Error("A file or folder with that name already exists");
    await mkdir(target, { recursive: false });
    return { ok: true, path: publicPath(root, target) };
  }
  if (command === "files.rename") {
    const root = await serverRoot(server);
    const source = await inside(server, payload?.path);
    if (isMutableConfigurationPath(payload?.path) || isMutableConfigurationPath(posix.join(posix.dirname(safeRelative(payload?.path)), safeName(payload?.name)))) {
      await requireStoppedForMutableConfiguration(server);
    }
    if (resolve(source) === resolve(root)) throw new Error("Refusing to rename the server root directory");
    const target = await writableResolvedInside(server, join(dirname(source), safeName(payload?.name)));
    if (existsSync(target)) throw new Error("A file or folder with that name already exists");
    await rename(source, target);
    return { ok: true, path: publicPath(root, target) };
  }
  if (command === "files.copy") {
    const root = await serverRoot(server);
    const source = await inside(server, payload?.path);
    if (isMutableConfigurationPath(payload?.path) || isMutableConfigurationPath(posix.join(safeRelative(payload?.parent), safeName(payload?.name)))) {
      await requireStoppedForMutableConfiguration(server);
    }
    const sourceStat = await stat(source);
    if (!sourceStat.isFile()) throw new Error("Only files can be duplicated from the browser file manager");
    const parent = await inside(server, payload?.parent);
    const parentStat = await stat(parent);
    if (!parentStat.isDirectory()) throw new Error("Parent path is not a directory");
    const target = await writableResolvedInside(server, join(parent, safeName(payload?.name)));
    if (existsSync(target)) throw new Error("A file or folder with that name already exists");
    await copyFile(source, target);
    return { ok: true, path: publicPath(root, target) };
  }
  if (command === "files.delete") {
    if (payload?.recursive !== undefined && payload.recursive !== "true" && payload.recursive !== "false") {
      throw new Error("recursive must be true or false");
    }
    const root = await serverRoot(server);
    const target = await inside(server, payload?.path);
    if (isMutableConfigurationPath(payload?.path)) await requireStoppedForMutableConfiguration(server);
    if (resolve(target) === resolve(root)) throw new Error("Refusing to delete the server root directory");
    const st = await stat(target);
    if (st.isDirectory()) {
      if (payload?.recursive === "true") {
        await rm(target, { recursive: true, force: false });
      } else {
        try {
          await rmdir(target);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOTEMPTY" || code === "EEXIST") throw new Error("Directory is not empty. Recursive deletion requires recursive=true and explicit confirmation.");
          throw error;
        }
      }
    }
    else await rm(target, { force: false });
    return { ok: true };
  }
  if (command === "mods.list") return modsList(server, { forceRefresh: payload?.forceRefresh === true });
  if (command === "mods.upload") {
    await requireStoppedForMutableConfiguration(server);
    return modUpload(server, payload?.filename, payload?.contentBase64);
  }
  if (command === "mods.install") {
    await requireStoppedForMutableConfiguration(server);
    return modInstall(server, payload);
  }
  if (command === "mods.enableDisable") {
    await requireStoppedForMutableConfiguration(server);
    const filename = safeInstalledModFilename(payload?.filename as string | undefined);
    const enabled = requireStrictBoolean(payload?.enabled, "enabled");
    const sourceName = filename.endsWith(".jar") && !existsSync(ensureInsideServer({ serverDir: await serverRoot(server) }, posix.join("mods", filename)))
      ? `${filename}.disabled`
      : filename;
    const source = await inside(server, posix.join("mods", sourceName));
    const targetName = enabled ? sourceName.replace(/\.jar\.disabled$/, ".jar") : sourceName.endsWith(".jar.disabled") ? sourceName : `${sourceName}.disabled`;
    const target = await writableInside(server, posix.join("mods", safeInstalledModFilename(targetName)));
    if (source !== target) await rename(source, target);
    return { ok: true, filename: basename(target), enabled };
  }
  if (command === "mods.remove") {
    await requireStoppedForMutableConfiguration(server);
    const filename = safeInstalledModFilename(payload?.filename as string | undefined);
    await rm(await inside(server, posix.join("mods", filename)), { force: true });
    return { ok: true, filename };
  }
  throw new Error(`Unsupported node command ${command}`);
}

function runtimeSelection(input: unknown) {
  const runtime = typeof input === "object" && input !== null ? input as Record<string, unknown> : {};
  const loader = typeof runtime.loader === "string" && runtime.loader.trim() ? runtime.loader.trim() : "fabric";
  if (loader !== "fabric") throw new Error("Only Fabric runtime profiles are supported");
  const optional = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : undefined;
  return {
    minecraftVersion: optional(runtime.minecraftVersion),
    loaderVersion: optional(runtime.loaderVersion),
    serverJar: runtime.serverJar === undefined ? undefined : validateRuntimeJarFilename(runtime.serverJar)
  };
}

export const __nodeAgentTestHooks = {
  cleanupPreviousNodeContainers,
  createdServerRecord,
  handleCommand,
  minecraftContainerCommand,
  selfUpdateContainer
};

export async function startNodeAgent() {
  initializeRuntimeDataRoot(config.paths);
  nodeStorageDatabase = openStorageDatabase();
  let persisted = await readNodeIdentity();
  if (!persisted && !config.joinToken) throw new Error("SS_JOIN_TOKEN is required for first node registration");
  console.info(`serverSENTINEL node agent starting. Panel: ${config.panelUrl}. Data: ${config.nodeDataDir}.`);

  const connect = async () => {
    persisted = await readNodeIdentity();
    const target = panelWebSocketUrl();
    console.info(`Connecting node agent to ${target}`);
    const socket = new WebSocket(target);
    const activeStreams = new Map<string, () => void>();
    const stopAllStreams = () => {
      for (const cleanup of Array.from(activeStreams.values())) cleanup();
      activeStreams.clear();
    };
    let reconnectScheduled = false;
    const reconnect = (reason: string) => {
      if (reconnectScheduled) return;
      reconnectScheduled = true;
      stopAllStreams();
      console.warn(`Node agent disconnected: ${reason}. Reconnecting in ${Math.round(reconnectDelayMs / 1000)}s.`);
      setTimeout(() => void connect(), reconnectDelayMs);
    };
    socket.on("open", async () => {
      const dockerStatus = dockerAvailable() ? "available" : "unavailable";
      const dataPathStatus = existsSync(config.nodeDataDir) ? "ready" : "missing";
      const hello: NodeHello = {
        type: "hello",
        nodeId: persisted?.nodeId ?? null,
        nodeSecret: persisted?.nodeSecret,
        joinToken: persisted ? undefined : config.joinToken,
        nodeName: config.nodeName || "Remote Node",
        agentVersion: appVersion,
        buildId: appBuildId,
        protocolVersion: nodeProtocolVersion,
        capabilities: [...nodeCapabilities],
        runtimeMode: "node",
        dataRoot: {
          root: config.nodeDataDir,
          dockerRoot: config.nodeDockerDataDir,
          status: dataPathStatus
        },
        docker: {
          available: dockerStatus === "available",
          status: dockerStatus
        },
        dockerStatus,
        dataPathStatus,
        totalMemory: await detectedTotalMemory(),
        operations: nodeOperationContract
      };
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify(hello));
    });
    socket.on("message", async (raw) => {
      let message: PanelWelcome | NodeRequestMessage | NodeStreamStartMessage | NodeStreamStopMessage;
      try {
        message = JSON.parse(raw.toString()) as PanelWelcome | NodeRequestMessage | NodeStreamStartMessage | NodeStreamStopMessage;
      } catch {
        return;
      }
      if (message.type === "welcome") {
        if (!message.accepted) {
          console.error(`Node registration rejected: ${message.error ?? "unknown error"}`);
          socket.close();
          return;
        }
        if (message.nodeSecret) {
          await writeNodeIdentity({ nodeId: message.nodeId, nodeSecret: message.nodeSecret });
          console.info(`Node registration accepted. Persisted node id ${message.nodeId}.`);
        } else {
          console.info(`Node session accepted for ${message.nodeId}.`);
        }
        return;
      }
      if (message.type === "streamStart") {
        activeStreams.get(message.id)?.();
        activeStreams.delete(message.id);
        if (message.command !== "server.console.stream") {
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
      const response = async (): Promise<NodeResponseMessage> => {
        try { return { type: "response", id: message.id, ok: true, result: await handleCommand(message.command, message.payload) }; }
        catch (error) { return { type: "response", id: message.id, ok: false, error: { code: "command_failed", message: (error as Error).message, details: detailedErrorMessage(error) } }; }
      };
      socket.send(JSON.stringify(await response()));
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
