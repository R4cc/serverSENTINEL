import Fastify from "fastify";
import type { FastifyBaseLogger, FastifyRequest } from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { inflateRawSync } from "node:zlib";
import { fetch } from "undici";
import { totalmem } from "node:os";
import { config, maxServerPort, minServerPort } from "./config.js";
import { dockerAvailable, dockerBufferRequest, dockerJsonBufferRequest, dockerJsonRequest, dockerRequest } from "./docker/dockerClient.js";
import { fabricMeta, latestFabricVersion } from "./fabric/fabricClient.js";
import {
  allowedForChannel,
  normalizeReleaseChannel,
  resolveModrinthProjectCompatibility,
  unknownCompatibility,
  versionChannel,
  fetchProject
} from "./modrinth/compatibility.js";
import { modrinthFetch } from "./modrinth/modrinthClient.js";
import { LocalNodeRuntime } from "./nodes/localNodeRuntime.js";
import type { CreateNodeResponse, NodeInstallInstructions } from "./nodes/apiTypes.js";
import { PanelNodeConnections } from "./nodes/panelConnections.js";
import { nodeCapabilities, nodeProtocolVersion, protocolCompatible } from "./nodes/protocol.js";
import type { NodeHello, PanelWelcome } from "./nodes/protocol.js";
import { NodeRuntimeRegistry } from "./nodes/registry.js";
import { RemoteNodeRuntime } from "./nodes/remoteNodeRuntime.js";
import { newNodeSecret } from "./nodes/nodeAgent.js";
import type { NodeRuntime, RuntimeAction } from "./nodes/types.js";
import {
  ROLE_PRESETS,
  inferRolePreset,
  isFullAccessUser,
  normalizePermissions,
  permissionsForRolePreset,
  requirePermission as requireUserPermission,
  rolePresetFromUnknown
} from "./permissions.js";
import { registerStaticFrontend } from "./staticFrontend.js";
import { modrinthApiKey, updateSettings, queuedReadSettings } from "./storage/settingsStore.js";
import { asArray, asObject, optionalString, readJsonFile, requiredString, writeJsonFile } from "./storage/jsonFile.js";
import type {
  DockerExecCreate,
  DockerExecInspect,
  DockerState,
  InstalledModMetadata,
  ManagedNode,
  ManagedServer,
  ModCompatibility,
  ModPreference,
  ModrinthProject,
  ModrinthVersion,
  Permission,
  PublicNode,
  PublicServer,
  PublicUser,
  ReleaseChannel,
  RolePreset,
  ResolvedServerVersions,
  ServerActivity,
  ServerEvent,
  ScheduledExecution,
  Session,
  StoredUser
} from "./types.js";
import {
  cronMatches,
  ensureInsideServer,
  ensureWritableInsideServer,
  ensureWritableResolvedInsideServer,
  parseDockerPorts,
  safeInstalledModFilename,
  safeModFilename,
  validateExistingInsideServer,
  validateExistingResolvedInsideServer,
  validateCron,
  AsyncQueue
} from "./core.js";

const localNodeId = "local";
const serversFile = join(config.configDir, "servers.json");
const nodesFile = join(config.configDir, "nodes.json");
const usersFile = join(config.configDir, "users.json");
const versionMetadataFilename = ".serversentinel-version.json";

const serversQueue = new AsyncQueue();
const nodesQueue = new AsyncQueue();
const usersQueue = new AsyncQueue();


type DockerContainerInspect = {
  Id?: string;
  State?: { Status?: DockerState; Running?: boolean; StartedAt?: string; FinishedAt?: string };
  Name?: string;
  Config?: { Labels?: Record<string, string>; OpenStdin?: boolean; AttachStdin?: boolean; Tty?: boolean };
  Mounts?: Array<{ Type?: string; Name?: string; Source?: string; Destination?: string }>;
};

type DockerStats = {
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

type CreateServerInput = {
  nodeId?: string;
  displayName?: string;
  minecraftVersion?: string;
  loaderVersion?: string;
  installerVersion?: string;
  serverJar?: string;
  dockerContainer?: string;
  dockerImage?: string;
  dockerPorts?: string;
  javaArgs?: string;
  acceptEula?: boolean;
  serverPort?: string;
};

type VersionMetadata = {
  minecraftVersion?: string;
  fabricLoaderVersion?: string;
  createdAt?: string;
  updatedAt?: string;
};

type ProvisionJob = {
  id: string;
  status: "running" | "succeeded" | "failed";
  progress: number;
  task: string;
  server?: PublicServer;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

type Client = {
  send: (payload: string) => void;
  readyState: number;
};

const provisionJobs = new Map<string, ProvisionJob>();
const sessions = new Map<string, Session>();
const panelNodeConnections = new PanelNodeConnections();
const sessionCookieName = "serversentinel_session";
let appLogger: FastifyBaseLogger | undefined;
const passwordHashKeyLength = 64;
const editorFileSizeLimit = 2 * 1024 * 1024;
const filePreviewSizeLimit = 96 * 1024;
const fileUploadSizeLimit = 32 * 1024 * 1024;
const modFileSizeLimit = 128 * 1024 * 1024;
const authRateLimit = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };
const provisionRateLimit = { config: { rateLimit: { max: 5, timeWindow: "5 minutes" } } };
const runtimeActionRateLimit = { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } };
const destructiveRateLimit = { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } };
const modChangeRateLimit = { config: { rateLimit: { max: 15, timeWindow: "1 minute" } } };
const commandRateLimit = { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } };

type LogFields = Record<string, unknown>;

function logDebug(fields: LogFields, message: string) {
  appLogger?.debug(fields, message);
}

function logInfo(fields: LogFields, message: string) {
  appLogger?.info(fields, message);
}

function logWarn(fields: LogFields, message: string) {
  appLogger?.warn(fields, message);
}

function logError(fields: LogFields, message: string) {
  appLogger?.error(fields, message);
}

function errorLogFields(error: unknown, fallbackStatusCode?: number): LogFields {
  if (!(error instanceof Error)) {
    return { errorMessage: String(error) };
  }
  const statusCode = "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : fallbackStatusCode;
  return {
    errorName: error.name,
    errorMessage: error.message,
    statusCode,
    stack: statusCode && statusCode < 500 ? undefined : error.stack
  };
}

function errorCategory(error: unknown, statusCode?: number) {
  const message = error instanceof Error ? error.message : String(error);
  if (statusCode && statusCode < 500) return "validation";
  if (/docker|container|socket|exec/i.test(message)) return "docker_api";
  if (/modrinth|fabric|download|fetch|api/i.test(message)) return "external_api";
  return "internal";
}

function isExpectedUserError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /required|not found|invalid|refusing|stop the server|must be|cannot be|larger than|binary files|not configured|unavailable|incompatible|already exists|duplicate/i.test(message);
}

function logOperationFailure(fields: LogFields, message: string, error: unknown) {
  const expected = isExpectedUserError(error);
  const payload = { ...fields, ...errorLogFields(error, expected ? 400 : undefined) };
  if (expected) {
    logWarn(payload, message);
    return;
  }
  logError(payload, message);
}

function routeLogFields(request: FastifyRequest, statusCode?: number): LogFields {
  return {
    method: request.method,
    route: request.routeOptions.url ?? request.raw.url?.split("?")[0] ?? request.url.split("?")[0],
    statusCode
  };
}

function assertSameOriginRequest(request: FastifyRequest) {
  const origin = request.headers.origin;
  if (!origin) return;
  const host = request.headers["x-forwarded-host"] ?? request.headers.host;
  if (!host || Array.isArray(host)) {
    forbidden("CSRF protection: invalid request host");
  }
  const protocol = request.headers["x-forwarded-proto"] === "https" || request.protocol === "https" ? "https" : "http";
  const expected = `${protocol}://${host}`;
  if (origin !== expected) {
    forbidden("CSRF protection: cross-origin request rejected");
  }
}

function serverLogFields(server: ManagedServer): LogFields {
  return {
    serverId: server.id,
    serverName: server.displayName,
    containerName: dockerContainerName(server)
  };
}

function durationSince(startedAt: number) {
  return Date.now() - startedAt;
}

function publicUser(user: StoredUser): PublicUser {
  const normalized = normalizeStoredUser(user);
  return {
    id: normalized.id,
    username: normalized.username,
    displayName: normalized.displayName,
    rolePreset: normalized.rolePreset,
    permissions: normalized.permissions,
    serverAccess: normalized.serverAccess,
    createdAt: normalized.createdAt
  };
}

function normalizeRolePreset(rolePreset?: unknown): RolePreset | undefined {
  return rolePreset === undefined ? undefined : rolePresetFromUnknown(rolePreset);
}

function normalizeDisplayName(displayName?: unknown) {
  if (displayName === undefined) return undefined;
  if (typeof displayName !== "string") {
    badRequest("Display name must be a string");
  }
  const value = displayName.trim();
  if (!value) return undefined;
  if (value.length > 64) {
    badRequest("Display name must be 64 characters or fewer");
  }
  return value;
}

function normalizeStoredUser(value: unknown): StoredUser {
  const user = asObject(value, "stored user");
  const permissions = normalizePermissions(asArray(user.permissions, "user.permissions"));
  const inferredPreset = inferRolePreset(permissions);
  const rolePreset = user.rolePreset === undefined ? inferredPreset : rolePresetFromUnknown(user.rolePreset);
  const effectivePreset = rolePreset === "custom" || inferRolePreset(permissions) === rolePreset ? rolePreset : "custom";
  const rawServerAccess = user.serverAccess === undefined ? undefined : asObject(user.serverAccess, "user.serverAccess");
  const serverAccess = rawServerAccess?.mode === "selected"
    ? { mode: "selected" as const, serverIds: asArray(rawServerAccess.serverIds, "user.serverAccess.serverIds").map((id) => requiredString(id, "user.serverAccess.serverIds[]")) }
    : rawServerAccess?.mode === "all"
      ? { mode: "all" as const, serverIds: [] }
      : undefined;
  return {
    id: requiredString(user.id, "user.id"),
    username: validateUsername(optionalString(user.username, "user.username")),
    displayName: normalizeDisplayName(user.displayName),
    passwordHash: requiredString(user.passwordHash, "user.passwordHash"),
    salt: requiredString(user.salt, "user.salt"),
    rolePreset: effectivePreset,
    permissions,
    serverAccess,
    createdAt: requiredString(user.createdAt, "user.createdAt"),
    updatedAt: requiredString(user.updatedAt, "user.updatedAt")
  };
}

function buildUserPermissions(input: { rolePreset?: RolePreset; permissions?: unknown[] }, fallback?: StoredUser) {
  if (input.permissions !== undefined) {
    const permissions = normalizePermissions(input.permissions);
    return {
      permissions,
      rolePreset: inferRolePreset(permissions)
    };
  }

  if (input.rolePreset !== undefined) {
    const permissions = permissionsForRolePreset(input.rolePreset, fallback?.permissions ?? []);
    return {
      permissions,
      rolePreset: inferRolePreset(permissions)
    };
  }

  if (fallback) {
    const normalized = normalizeStoredUser(fallback);
    return {
      permissions: normalized.permissions,
      rolePreset: normalized.rolePreset
    };
  }

  const permissions = normalizePermissions(ROLE_PRESETS.viewer);
  return {
    permissions,
    rolePreset: inferRolePreset(permissions)
  };
}

function validateUsername(username?: string) {
  const value = username?.trim();
  if (!value || value.length < 3 || value.length > 32 || !/^[a-zA-Z0-9_.-]+$/.test(value)) {
    const error = new Error("Username must be 3-32 characters and use letters, numbers, dots, dashes, or underscores") as Error & { statusCode?: number };
    error.statusCode = 400;
    throw error;
  }
  return value;
}

function validatePassword(password?: string) {
  if (!password || password.length < 8) {
    const error = new Error("Password must be at least 8 characters") as Error & { statusCode?: number };
    error.statusCode = 400;
    throw error;
  }
  return password;
}

function badRequest(message: string): never {
  const error = new Error(message) as Error & { statusCode?: number };
  error.statusCode = 400;
  throw error;
}

function forbidden(message: string): never {
  const error = new Error(message) as Error & { statusCode?: number };
  error.statusCode = 403;
  throw error;
}

export function requireStrictBoolean(value: unknown, fieldName: string) {
  if (typeof value !== "boolean") {
    badRequest(`${fieldName} must be a boolean`);
  }
  return value;
}

function optionalStrictBoolean(value: unknown, fieldName: string, fallback: boolean) {
  return value === undefined ? fallback : requireStrictBoolean(value, fieldName);
}

function optionalReleaseChannel(channel: unknown): ReleaseChannel {
  if (channel === undefined) return "release";
  if (channel === "release" || channel === "beta" || channel === "alpha") return channel;
  badRequest("Release channel must be one of release, beta, or alpha");
}

function optionalCompatibilityFilter(value: unknown) {
  if (value === undefined) return undefined;
  if (value === "all" || value === "compatible") return value;
  badRequest("Compatibility filter must be all or compatible");
}

function validateServerId(id: unknown) {
  if (typeof id !== "string" || !/^[0-9a-fA-F-]{36}$/.test(id)) {
    badRequest("A valid server id is required");
  }
  return id;
}

function validateScheduleId(id: unknown) {
  if (typeof id !== "string" || !/^[0-9a-fA-F-]{36}$/.test(id)) {
    badRequest("A valid schedule id is required");
  }
  return id;
}

function validateProvisionJobId(id: unknown) {
  if (typeof id !== "string" || !/^[0-9a-fA-F-]{36}$/.test(id)) {
    badRequest("A valid provisioning job id is required");
  }
  return id;
}

export function validateModrinthProjectId(projectId: unknown) {
  if (typeof projectId !== "string" || !/^[a-zA-Z0-9_-]{3,64}$/.test(projectId.trim())) {
    badRequest("A valid Modrinth project id is required");
  }
  return projectId.trim();
}

export function validateRuntimeJarFilename(filename: unknown) {
  const value = typeof filename === "string" ? filename.trim() : "";
  if (!value || basename(value) !== value || !value.endsWith(".jar")) {
    badRequest("Server jar filename must be a local .jar filename");
  }
  return value;
}

export function validateDockerContainerName(name: unknown) {
  const value = typeof name === "string" ? name.trim() : "";
  if (!value || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value)) {
    badRequest("Docker container name contains invalid characters");
  }
  return value;
}

export function validateDockerImageName(image: unknown) {
  const value = typeof image === "string" ? image.trim() : "";
  if (!value || value.length > 255 || /\s/.test(value) || !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(value)) {
    badRequest("Docker image name contains invalid characters");
  }
  return value;
}

export function validateJavaArgs(args: unknown) {
  const value = typeof args === "string" ? args.trim() : "";
  if (!value) return "-Xms2G -Xmx4G";
  if (value.length > 512 || /[\r\n;&|`$<>\\]/.test(value)) {
    badRequest("Java arguments contain unsafe shell characters");
  }
  return value;
}

function validateBase64Content(value: unknown) {
  if (typeof value !== "string" || !value || !/^[a-zA-Z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    badRequest("Uploaded mod content must be valid base64");
  }
  return value;
}

function assertJarBuffer(buffer: Buffer) {
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b || ![0x03, 0x05, 0x07].includes(buffer[2])) {
    badRequest("Uploaded mod must be a valid .jar file");
  }
}

async function verifyDownloadedJar(destination: string, file: { size?: number; hashes?: Record<string, string> }) {
  const downloaded = await stat(destination);
  if (!downloaded.isFile() || downloaded.size === 0 || downloaded.size > modFileSizeLimit) {
    await rm(destination, { force: true }).catch(() => {});
    throw new Error(`Downloaded mod must be between 1 byte and ${Math.floor(modFileSizeLimit / 1024 / 1024)} MiB`);
  }
  const buffer = await readFile(destination);
  assertJarBuffer(buffer);
  const expectedSha1 = file.hashes?.sha1;
  if (expectedSha1) {
    const actualSha1 = createHash("sha1").update(buffer).digest("hex");
    if (actualSha1 !== expectedSha1) {
      await rm(destination, { force: true }).catch(() => {});
      throw new Error("Downloaded mod hash did not match Modrinth metadata");
    }
  }
}

function sizeLimitTransform(maxBytes: number) {
  let bytes = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        callback(new Error(`Downloaded mod is larger than ${Math.floor(maxBytes / 1024 / 1024)} MiB`));
        return;
      }
      callback(null, chunk);
    }
  });
}

function hashPassword(password: string, salt = randomBytes(16).toString("hex")) {
  const hash = scryptSync(password, salt, passwordHashKeyLength).toString("hex");
  return { salt, passwordHash: hash };
}

function verifyPassword(password: string, user: StoredUser) {
  const attempted = Buffer.from(hashPassword(password, user.salt).passwordHash, "hex");
  const stored = Buffer.from(user.passwordHash, "hex");
  return attempted.length === stored.length && timingSafeEqual(attempted, stored);
}

function hashNodeSecret(secret: string) {
  return createHash("sha256").update(secret).digest("hex");
}

function verifyNodeSecret(secret: string | undefined, expectedHash?: string) {
  if (!secret || !expectedHash) return false;
  const attempted = Buffer.from(hashNodeSecret(secret), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return attempted.length === expected.length && timingSafeEqual(attempted, expected);
}

function nodeNotFound(nodeId: string): never {
  const error = new Error(`Node ${nodeId} not found`) as Error & { statusCode?: number; code?: string };
  error.statusCode = 404;
  error.code = "node_not_found";
  throw error;
}

async function readUsers() {
  return readJsonFile(usersFile, [], (value) => asArray(value, "users.json").map(normalizeStoredUser));
}

async function writeUsers(users: StoredUser[]) {
  const normalized = users.map(normalizeStoredUser);
  if (normalized.length > 0 && !normalized.some(isFullAccessUser)) {
    badRequest("At least one full-access admin user is required");
  }
  await writeJsonFile(usersFile, normalized);
}

function queuedReadUsers() {
  return usersQueue.enqueue(() => readUsers());
}

async function updateUsers(updater: (users: StoredUser[]) => Promise<void> | void) {
  return usersQueue.enqueue(async () => {
    const users = await readUsers();
    await updater(users);
    await writeUsers(users);
  });
}

function parseCookies(cookieHeader?: string) {
  const cookies = new Map<string, string>();
  for (const part of (cookieHeader ?? "").split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (!rawName || rawValue.length === 0) continue;
    cookies.set(rawName, decodeURIComponent(rawValue.join("=")));
  }
  return cookies;
}

function sessionCookie(sessionId: string, maxAgeSeconds: number, secure = false) {
  return `${sessionCookieName}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}

async function currentUserFromCookie(cookieHeader?: string) {
  const sessionId = parseCookies(cookieHeader).get(sessionCookieName);
  if (!sessionId) return null;
  const session = sessions.get(sessionId);
  if (!session) return null;
  const users = await queuedReadUsers();
  return users.find((user) => user.id === session.userId) ?? null;
}

async function requireAuthenticated(cookieHeader?: string) {
  const user = await currentUserFromCookie(cookieHeader);
  if (!user) {
    const error = new Error("Authentication required") as Error & { statusCode?: number };
    error.statusCode = 401;
    throw error;
  }
  return user;
}

async function requireRequestPermission(request: { headers: { cookie?: string } }, permission?: Permission) {
  const user = await requireAuthenticated(request.headers.cookie);
  if (permission) {
    requireUserPermission(permission)(user);
  }
  return user;
}

function versionResolution(version: string | undefined, source: ResolvedServerVersions["minecraftVersion"]["source"], lastCheckedAt: string) {
  return { version: version || undefined, source: version ? source : "unknown", lastCheckedAt };
}

function defaultInternalNode(now = new Date().toISOString()): ManagedNode {
  return {
    id: localNodeId,
    name: "Internal Node",
    type: "local",
    status: "online",
    isInternal: true,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now
  };
}

function normalizeNode(value: unknown): ManagedNode {
  const node = asObject(value, "managed node");
  const type = node.type ?? "local";
  if (type !== "local" && type !== "remote") {
    throw new Error("managed node type must be local or remote");
  }
  const status = node.status ?? "unknown";
  if (status !== "online" && status !== "offline" && status !== "unknown") {
    throw new Error("managed node status must be online, offline, or unknown");
  }
  return {
    id: requiredString(node.id, "node.id"),
    name: requiredString(node.name, "node.name"),
    type,
    status,
    isInternal: requireStrictBoolean(node.isInternal, "node.isInternal"),
    createdAt: requiredString(node.createdAt, "node.createdAt"),
    updatedAt: requiredString(node.updatedAt, "node.updatedAt"),
    lastSeenAt: optionalString(node.lastSeenAt, "node.lastSeenAt"),
    connectedAt: optionalString(node.connectedAt, "node.connectedAt"),
    agentVersion: optionalString(node.agentVersion, "node.agentVersion"),
    protocolVersion: optionalString(node.protocolVersion, "node.protocolVersion"),
    capabilities: node.capabilities === undefined ? undefined : asArray(node.capabilities, "node.capabilities").map((capability) => requiredString(capability, "node.capabilities[]")),
    dockerStatus: optionalString(node.dockerStatus, "node.dockerStatus"),
    dataPathStatus: optionalString(node.dataPathStatus, "node.dataPathStatus"),
    compatibility: node.compatibility === "compatible" || node.compatibility === "incompatible" || node.compatibility === "unknown" ? node.compatibility : undefined,
    secretHash: optionalString(node.secretHash, "node.secretHash"),
    joinTokenHash: optionalString(node.joinTokenHash, "node.joinTokenHash"),
    joinTokenExpiresAt: optionalString(node.joinTokenExpiresAt, "node.joinTokenExpiresAt")
  };
}

function ensureDefaultInternalNode(nodes: ManagedNode[]) {
  const now = new Date().toISOString();
  const localIndex = nodes.findIndex((node) => node.id === localNodeId);
  if (localIndex === -1) {
    nodes.unshift(defaultInternalNode(now));
    return true;
  }

  const current = nodes[localIndex];
  const normalized: ManagedNode = {
    ...current,
    name: current.name || "Internal Node",
    type: "local",
    status: "online",
    isInternal: true,
    updatedAt: current.status === "online" && current.type === "local" && current.isInternal ? current.updatedAt : now,
    lastSeenAt: current.lastSeenAt ?? now
  };
  const changed = JSON.stringify(current) !== JSON.stringify(normalized);
  nodes[localIndex] = normalized;
  return changed;
}

function publicNode(node: ManagedNode): PublicNode {
  const normalized = normalizeNode(node);
  const { secretHash: _secretHash, joinTokenHash: _joinTokenHash, ...publicFields } = normalized;
  return {
    ...publicFields,
    hasPendingJoinToken: Boolean(normalized.joinTokenHash && normalized.joinTokenExpiresAt && new Date(normalized.joinTokenExpiresAt).getTime() > Date.now())
  };
}

function nodeDataMount(hostPath?: string) {
  const value = hostPath?.trim() || "/var/lib/serversentinel";
  return value.includes(":") ? value : `${value}:/data`;
}

function nodeInstallInstructions(input: { panelUrl?: string; joinToken?: string; dataMount?: string; nodeName?: string }): NodeInstallInstructions {
  const image = "nl2109/serversentinel:latest";
  const panelUrl = input.panelUrl?.trim() || `http://<panel-host>:${config.port}`;
  const dataMount = nodeDataMount(input.dataMount);
  const nodeName = input.nodeName?.trim();
  const dockerSocketMount = "/var/run/docker.sock:/var/run/docker.sock";
  const environment: NodeInstallInstructions["dockerCompose"]["environment"] = {
    SS_MODE: "node",
    SS_PANEL_URL: panelUrl
  };
  if (nodeName) {
    environment.SS_NODE_NAME = nodeName;
  }
  if (input.joinToken) {
    environment.SS_JOIN_TOKEN = input.joinToken;
  }
  return {
    image,
    panelUrl,
    joinToken: input.joinToken,
    tokenRequired: !input.joinToken,
    dataMount,
    dockerSocketMount,
    dockerCompose: {
      image,
      environment,
      volumes: [dockerSocketMount, dataMount]
    },
    dockerRun: `docker run -d --name serversentinel-node -e SS_MODE=node -e SS_PANEL_URL=${shellQuote(panelUrl)}${nodeName ? ` -e SS_NODE_NAME=${shellQuote(nodeName)}` : ""}${input.joinToken ? ` -e SS_JOIN_TOKEN=${shellQuote(input.joinToken)}` : ""} -v ${shellQuote(dockerSocketMount)} -v ${shellQuote(dataMount)} ${image}`
  };
}

function createJoinToken(ttlMinutesInput?: number) {
  const now = new Date();
  const joinToken = randomBytes(32).toString("base64url");
  const ttlMinutes = Number.isFinite(ttlMinutesInput) ? Math.max(5, Math.min(1440, Number(ttlMinutesInput))) : 60;
  return {
    joinToken,
    expiresAt: new Date(now.getTime() + ttlMinutes * 60_000).toISOString()
  };
}

async function readNodes() {
  const nodes = await readJsonFile(nodesFile, config.runtimeMode === "all-in-one" ? [defaultInternalNode()] : [], (value) => asArray(value, "nodes.json").map(normalizeNode));
  const normalized = nodes.map(normalizeNode);
  if (config.runtimeMode === "all-in-one" && ensureDefaultInternalNode(normalized)) {
    await writeJsonFile(nodesFile, normalized);
  }
  return normalized;
}

async function writeNodes(nodes: ManagedNode[]) {
  const normalized = nodes.map(normalizeNode);
  if (config.runtimeMode === "all-in-one") ensureDefaultInternalNode(normalized);
  await writeJsonFile(nodesFile, normalized);
}

function queuedReadNodes() {
  return nodesQueue.enqueue(() => readNodes());
}

async function updateNodes(updater: (nodes: ManagedNode[]) => Promise<void> | void) {
  return nodesQueue.enqueue(async () => {
    const nodes = await readNodes();
    await updater(nodes);
    await writeNodes(nodes);
  });
}

let runtimeRegistry: NodeRuntimeRegistry | undefined;

function runtimeForServer(server: ManagedServer): NodeRuntime {
  if (!runtimeRegistry) {
    throw new Error("Node runtime registry is not initialized");
  }
  return runtimeRegistry.forServer(server);
}

function runtimeForNodeId(nodeId: string): NodeRuntime {
  if (!runtimeRegistry) {
    throw new Error("Node runtime registry is not initialized");
  }
  return runtimeRegistry.forNodeId(nodeId);
}

function findServerNode(server: ManagedServer, nodes: ManagedNode[]) {
  return nodes.find((node) => node.id === server.nodeId);
}

function parseVersionMetadataText(text: string): VersionMetadata {
  try {
    const parsed = JSON.parse(text) as VersionMetadata;
    return {
      minecraftVersion: typeof parsed.minecraftVersion === "string" ? parsed.minecraftVersion : undefined,
      fabricLoaderVersion: typeof parsed.fabricLoaderVersion === "string" ? parsed.fabricLoaderVersion : undefined,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : undefined,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined
    };
  } catch {
    const values = parseProperties(text);
    return {
      minecraftVersion: values.minecraftVersion || values["minecraft-version"] || values["game-version"],
      fabricLoaderVersion: values.fabricLoaderVersion || values["fabric-loader-version"] || values.loaderVersion
    };
  }
}

async function readVersionMetadataFile(server: ManagedServer) {
  try {
    const metadataPath = await validateExistingInsideServer(server, versionMetadataFilename);
    return parseVersionMetadataText(await readFile(metadataPath, "utf8"));
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    return {};
  }
}

async function writeVersionMetadataFile(server: ManagedServer) {
  const now = new Date().toISOString();
  let existing: VersionMetadata = {};
  try {
    existing = await readVersionMetadataFile(server);
  } catch {
    existing = {};
  }
  const metadata: VersionMetadata = {
    minecraftVersion: server.minecraftVersion,
    fabricLoaderVersion: server.loaderVersion,
    createdAt: existing.createdAt ?? now,
    updatedAt: now
  };
  const target = await ensureWritableInsideServer(server, versionMetadataFilename);
  await writeFile(target, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

function readZipEntry(buffer: Buffer, entryName: string) {
  let offset = 0;
  while (offset + 30 <= buffer.length) {
    const signature = buffer.readUInt32LE(offset);
    if (signature !== 0x04034b50) {
      offset += 1;
      continue;
    }
    const compressionMethod = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const fileNameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + fileNameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) return undefined;
    const name = buffer.subarray(nameStart, nameStart + fileNameLength).toString("utf8");
    if (name === entryName) {
      const data = buffer.subarray(dataStart, dataEnd);
      if (compressionMethod === 0) return data;
      if (compressionMethod === 8) return inflateRawSync(data);
      return undefined;
    }
    offset = dataEnd;
  }
  return undefined;
}

async function detectVersionsFromLauncherJar(server: ManagedServer): Promise<VersionMetadata> {
  if (!server.serverJar) return {};
  try {
    const jarPath = await validateExistingInsideServer(server, server.serverJar);
    const jarStat = await stat(jarPath);
    if (!jarStat.isFile() || jarStat.size > 16 * 1024 * 1024) return {};
    const installProperties = readZipEntry(await readFile(jarPath), "install.properties");
    if (!installProperties) return {};
    const values = parseProperties(installProperties.toString("utf8"));
    return {
      minecraftVersion: values["game-version"],
      fabricLoaderVersion: values["fabric-loader-version"]
    };
  } catch {
    return {};
  }
}

function detectVersionsFromLogText(logText: string): VersionMetadata {
  const minecraftMatches = [...logText.matchAll(/Starting minecraft server version\s+([^\s]+)/gi)];
  const loaderMatches = [
    ...logText.matchAll(/Loading Fabric Loader\s+([^\s]+)/gi),
    ...logText.matchAll(/Fabric Loader[^0-9]*(\d+(?:\.\d+)+(?:[-+][\w.-]+)?)/gi)
  ];
  return {
    minecraftVersion: minecraftMatches.at(-1)?.[1],
    fabricLoaderVersion: loaderMatches.at(-1)?.[1]
  };
}

async function detectVersionsFromLogs(server: ManagedServer) {
  const logs = await Promise.allSettled([
    readLatestServerLog(server),
    dockerControlConfigured(server) ? dockerRecentLogs(server) : Promise.resolve("")
  ]);
  const text = logs
    .filter((result): result is PromiseFulfilledResult<string> => result.status === "fulfilled")
    .map((result) => result.value)
    .join("\n");
  return detectVersionsFromLogText(text);
}

async function resolveServerVersions(server: ManagedServer): Promise<ResolvedServerVersions> {
  const lastCheckedAt = new Date().toISOString();
  const detected = await detectVersionsFromLauncherJar(server);
  const metadata = detected.minecraftVersion && detected.fabricLoaderVersion
    ? {}
    : await readVersionMetadataFile(server);
  const logs = detected.minecraftVersion && detected.fabricLoaderVersion
    ? {}
    : await detectVersionsFromLogs(server);

  const minecraftSource = detected.minecraftVersion ? "detected" : logs.minecraftVersion ? "log" : server.minecraftVersion || metadata.minecraftVersion ? "stored" : "unknown";
  const fabricSource = detected.fabricLoaderVersion ? "detected" : logs.fabricLoaderVersion ? "log" : server.loaderVersion || metadata.fabricLoaderVersion ? "stored" : "unknown";
  return {
    minecraftVersion: versionResolution(detected.minecraftVersion || logs.minecraftVersion || server.minecraftVersion || metadata.minecraftVersion, minecraftSource, lastCheckedAt),
    fabricLoaderVersion: versionResolution(detected.fabricLoaderVersion || logs.fabricLoaderVersion || server.loaderVersion || metadata.fabricLoaderVersion, fabricSource, lastCheckedAt)
  };
}

async function publicServer(server: ManagedServer, nodes?: ManagedNode[]): Promise<PublicServer> {
  const availableNodes = nodes ?? await queuedReadNodes();
  const node = findServerNode(server, availableNodes);
  return {
    id: server.id,
    nodeId: server.nodeId,
    displayName: server.displayName,
    storageName: server.storageName,
    minecraftVersion: server.minecraftVersion,
    loaderVersion: server.loaderVersion,
    installerVersion: server.installerVersion,
    serverJar: server.serverJar,
    dockerContainer: server.dockerContainer,
    dockerImage: server.dockerImage,
    dockerPorts: server.dockerPorts,
    javaArgs: server.javaArgs,
    schedules: server.schedules ?? [],
    serverType: server.serverType,
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
    directoryLabel: server.storageName || server.displayName,
    hasDockerContainer: Boolean(server.dockerContainer),
    nodeName: node?.name,
    resolvedVersions: server.nodeId === localNodeId ? await resolveServerVersions(server) : {
      minecraftVersion: versionResolution(server.minecraftVersion, server.minecraftVersion ? "stored" : "unknown", new Date().toISOString()),
      fabricLoaderVersion: versionResolution(server.loaderVersion, server.loaderVersion ? "stored" : "unknown", new Date().toISOString())
    }
  };
}

function normalizeSchedule(value: unknown): ScheduledExecution {
  const schedule = asObject(value, "schedule");
  return {
    id: validateScheduleId(schedule.id),
    name: requiredString(schedule.name, "schedule.name"),
    cron: requiredString(schedule.cron, "schedule.cron"),
    commands: sanitizeCommands(asArray(schedule.commands, "schedule.commands")),
    onlyWhenNoPlayers: requireStrictBoolean(schedule.onlyWhenNoPlayers, "schedule.onlyWhenNoPlayers"),
    enabled: requireStrictBoolean(schedule.enabled, "schedule.enabled"),
    createdAt: requiredString(schedule.createdAt, "schedule.createdAt"),
    updatedAt: requiredString(schedule.updatedAt, "schedule.updatedAt"),
    lastRunAt: optionalString(schedule.lastRunAt, "schedule.lastRunAt"),
    lastStatus: optionalString(schedule.lastStatus, "schedule.lastStatus"),
    lastMessage: optionalString(schedule.lastMessage, "schedule.lastMessage")
  };
}

function normalizeManagedServer(value: unknown): ManagedServer {
  const server = asObject(value, "managed server");
  const serverType = server.serverType ?? "fabric";
  if (serverType !== "fabric") {
    throw new Error("managed server serverType must be fabric");
  }
  const dockerPorts = optionalString(server.dockerPorts, "server.dockerPorts");
  if (dockerPorts) parseDockerPorts(dockerPorts);
  const id = validateServerId(server.id);
  const nodeId = optionalString(server.nodeId, "server.nodeId") ?? localNodeId;
  const serversDir = resolve(config.serversDir);
  const serverDir = nodeId === localNodeId
    ? resolve(requiredString(server.serverDir, "server.serverDir"))
    : resolve(optionalString(server.serverDir, "server.serverDir") ?? join("/remote", id));
  if (nodeId === localNodeId && serverDir !== serversDir && !serverDir.startsWith(serversDir + sep)) {
    throw new Error("managed server serverDir must be inside SERVERSENTINEL_SERVERS_DIR");
  }
  return {
    id,
    nodeId,
    displayName: requiredString(server.displayName, "server.displayName"),
    serverDir,
    storageName: optionalString(server.storageName, "server.storageName"),
    minecraftVersion: optionalString(server.minecraftVersion, "server.minecraftVersion"),
    loaderVersion: optionalString(server.loaderVersion, "server.loaderVersion"),
    installerVersion: optionalString(server.installerVersion, "server.installerVersion"),
    serverJar: server.serverJar === undefined ? undefined : validateRuntimeJarFilename(server.serverJar),
    dockerContainer: server.dockerContainer === undefined ? undefined : validateDockerContainerName(server.dockerContainer),
    dockerImage: server.dockerImage === undefined ? undefined : validateDockerImageName(server.dockerImage),
    dockerMountSource: optionalString(server.dockerMountSource, "server.dockerMountSource"),
    dockerWorkingDir: optionalString(server.dockerWorkingDir, "server.dockerWorkingDir"),
    dockerPorts,
    javaArgs: server.javaArgs === undefined ? undefined : validateJavaArgs(server.javaArgs),
    schedules: server.schedules === undefined ? undefined : asArray(server.schedules, "server.schedules").map(normalizeSchedule),
    serverType,
    createdAt: requiredString(server.createdAt, "server.createdAt"),
    updatedAt: requiredString(server.updatedAt, "server.updatedAt")
  };
}

async function readServers() {
  const [servers, nodes] = await Promise.all([
    readJsonFile(serversFile, [], (value) => asArray(value, "servers.json").map(normalizeManagedServer)),
    readNodes()
  ]);
  const nodeIds = new Set(nodes.map((node) => node.id));
  return servers.map((server) => {
    if (!nodeIds.has(server.nodeId)) {
      throw new Error(`Managed server ${server.displayName} references unknown node ${server.nodeId}`);
    }
    return server;
  });
}

async function writeServers(servers: ManagedServer[]) {
  const nodes = await readNodes();
  const nodeIds = new Set(nodes.map((node) => node.id));
  const normalized = servers.map(normalizeManagedServer);
  for (const server of normalized) {
    if (!nodeIds.has(server.nodeId)) {
      throw new Error(`Managed server ${server.displayName} references unknown node ${server.nodeId}`);
    }
  }
  await writeJsonFile(serversFile, normalized);
}

function queuedReadServers() {
  return serversQueue.enqueue(() => readServers());
}

async function updateServers(updater: (servers: ManagedServer[]) => Promise<void> | void) {
  return serversQueue.enqueue(async () => {
    const servers = await readServers();
    await updater(servers);
    await writeServers(servers);
  });
}

function slugify(input: string) {
  const slug = input.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || randomUUID();
}

function defaultContainerName(displayName: string) {
  return `serversentinel-${slugify(displayName)}`;
}

function defaultDockerImageForMinecraftVersion(version?: string) {
  const [major, minor, patch] = (version ?? "").split(".").map((part) => Number(part));
  if (Number.isFinite(major) && major >= 26) {
    return "eclipse-temurin:25-jre";
  }
  if (major === 1 && Number.isFinite(minor) && minor >= 20 && (minor > 20 || (patch ?? 0) >= 5)) {
    return "eclipse-temurin:21-jre";
  }
  return "eclipse-temurin:17-jre";
}

async function getServer(serverId?: string) {
  if (serverId !== undefined) {
    validateServerId(serverId);
  }
  const servers = await queuedReadServers();
  const server = serverId ? servers.find((candidate) => candidate.id === serverId) : servers[0];
  if (!server) {
    throw new Error("No managed server instance is registered");
  }
  return server;
}

function ensureManagedServerDirectory(server: ManagedServer) {
  const serversDir = resolve(config.serversDir);
  const serverDir = resolve(server.serverDir);
  if (serverDir !== serversDir && !serverDir.startsWith(serversDir + sep)) {
    throw new Error("Server files can only be deleted when the directory is inside the managed servers directory");
  }
  return serverDir;
}

function toPublicPath(server: ManagedServer, absolutePath: string) {
  const rel = relative(resolve(server.serverDir), absolutePath).replaceAll("\\", "/");
  return rel ? `/${rel}` : "/";
}

function isModsPath(server: ManagedServer, absolutePath: string) {
  const publicPath = toPublicPath(server, absolutePath);
  return publicPath === "/mods" || publicPath.startsWith("/mods/");
}

function isServerSettingsFile(server: ManagedServer, absolutePath: string) {
  const publicPath = toPublicPath(server, absolutePath);
  return publicPath === "/server.properties";
}

function fileRenamePermission(server: ManagedServer, source: string, target: string): Permission {
  if (isServerSettingsFile(server, source) || isServerSettingsFile(server, target)) return "servers.editSettings";
  if (isModsPath(server, source) || isModsPath(server, target)) return "mods.enableDisable";
  return "files.edit";
}

async function requireFilePathPermission(request: { headers: { cookie?: string } }, server: ManagedServer, absolutePath: string, permission: Permission) {
  if (!isModsPath(server, absolutePath)) {
    return requireRequestPermission(request, permission);
  }
  if (permission === "files.view" || permission === "files.download") {
    return requireRequestPermission(request, "mods.view");
  }
  if (permission === "files.edit") {
    return requireRequestPermission(request, "mods.enableDisable");
  }
  if (permission === "files.upload") {
    return requireRequestPermission(request, "mods.upload");
  }
  if (permission === "files.delete") {
    return requireRequestPermission(request, "mods.remove");
  }
  return requireRequestPermission(request, permission);
}

function safeFileManagerName(name?: string) {
  const filename = basename(name ?? "").trim();
  if (!filename || filename !== name || filename === "." || filename === "..") {
    throw new Error("A valid file or folder name is required");
  }
  if (filename.length > 160 || /[<>:"/\\|?*\u0000-\u001f]/.test(filename)) {
    throw new Error("File or folder name contains unsafe characters");
  }
  return filename;
}

function isTextLikeServerFile(name: string) {
  return /\.(txt|json5?|properties|toml|ya?ml|cfg|conf|log|md|csv|env)$/i.test(name) || !name.includes(".");
}

function fileManagerStatus(entryStat: Awaited<ReturnType<typeof lstat>>, name: string) {
  if (entryStat.isDirectory()) return "ok";
  if (!entryStat.isFile()) return "unknown";
  if (entryStat.size > editorFileSizeLimit) return "too_large";
  if (!isTextLikeServerFile(name)) return "binary";
  return "ok";
}

function modIconKey(filename: string) {
  return Buffer.from(filename.replace(/\.jar\.disabled$/, ".jar"), "utf8").toString("base64url");
}

function isMissingPathError(error: unknown) {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function modIconUrl(server: ManagedServer, filename: string) {
  let iconsDir: string;
  try {
    iconsDir = await validateExistingInsideServer(server, "mods/.serversentinel-icons");
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    return undefined;
  }
  const key = modIconKey(filename);
  const icon = (await readdir(iconsDir)).find((entry) => entry.startsWith(`${key}.`));
  return icon ? `/api/servers/${encodeURIComponent(server.id)}/mods/icon?filename=${encodeURIComponent(filename)}` : undefined;
}

async function deleteModIcon(server: ManagedServer, filename: string) {
  let iconsDir: string;
  try {
    iconsDir = await validateExistingInsideServer(server, "mods/.serversentinel-icons");
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    return;
  }
  const key = modIconKey(filename);
  const icons = await readdir(iconsDir);
  await Promise.all(icons.filter((entry) => entry.startsWith(`${key}.`)).map(async (entry) => {
    const iconPath = await validateExistingResolvedInsideServer(server, join(iconsDir, entry));
    await rm(iconPath, { force: true });
  }));
}

function iconExtension(iconUrl: string, contentType: string | null) {
  if (contentType?.includes("webp")) return ".webp";
  if (contentType?.includes("jpeg")) return ".jpg";
  if (contentType?.includes("png")) return ".png";
  const extension = extname(new URL(iconUrl).pathname).toLowerCase();
  return [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(extension) ? extension : ".png";
}

async function saveModIcon(server: ManagedServer, filename: string, iconUrl?: string | null) {
  if (!iconUrl || !iconUrl.startsWith("https://")) return;
  const response = await fetch(iconUrl, {
    headers: { "User-Agent": "ServerSentinel/0.3.0 (Fabric mod manager)" }
  });
  if (!response.ok || !response.body) return;
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 1024 * 1024) return;
  await validateExistingInsideServer(server, "mods");
  const iconsDir = ensureInsideServer(server, "mods/.serversentinel-icons");
  await mkdir(iconsDir, { recursive: true });
  await validateExistingInsideServer(server, "mods/.serversentinel-icons");
  await deleteModIcon(server, filename);
  const iconPath = await ensureWritableResolvedInsideServer(server, join(iconsDir, `${modIconKey(filename)}${iconExtension(iconUrl, response.headers.get("content-type"))}`));
  await writeFile(iconPath, bytes);
}

async function ensureModrinthIconForFile(server: ManagedServer, filename: string, filePath: string) {
  if (await modIconUrl(server, filename)) return;
  try {
    const safeFilePath = await validateExistingResolvedInsideServer(server, filePath);
    const hash = createHash("sha1").update(await readFile(safeFilePath)).digest("hex");
    const versionResponse = await modrinthFetch(`https://api.modrinth.com/v2/version_file/${hash}?algorithm=sha1`);
    const version = await versionResponse.json() as { project_id?: string };
    if (!version.project_id) return;
    const projectResponse = await modrinthFetch(`https://api.modrinth.com/v2/project/${encodeURIComponent(version.project_id)}`);
    const project = await projectResponse.json() as { icon_url?: string | null };
    await saveModIcon(server, filename, project.icon_url);
  } catch {
    // Non-Modrinth/manual mods simply keep the generic JAR icon.
  }
}

function isValidServerPort(port: string) {
  if (!/^\d+$/.test(port)) return false;
  const value = Number(port);
  return value >= minServerPort && value <= maxServerPort;
}

function sanitizeCommands(commands: unknown) {
  if (!Array.isArray(commands)) {
    throw new Error("At least one command is required");
  }
  const clean = commands
    .map((command) => typeof command === "string" ? command.trim().replace(/^\//, "") : "")
    .filter(Boolean);
  if (!clean.length) {
    throw new Error("At least one command is required");
  }
  if (clean.some((command) => /[\r\n]/.test(command))) {
    throw new Error("Scheduled commands must be one line each");
  }
  return clean;
}

function dockerContainerName(server: ManagedServer) {
  if (server.dockerContainer?.trim()) {
    return validateDockerContainerName(server.dockerContainer);
  }
  return defaultContainerName(server.displayName);
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function dockerControlConfigured(server: ManagedServer) {
  return Boolean(server.dockerContainer || (server.dockerMountSource && server.serverJar));
}

function serverDockerMountSource(server: ManagedServer) {
  if (server.dockerMountSource && server.dockerMountSource !== server.serverDir) {
    return server.dockerMountSource;
  }
  return config.serversDockerVolume || server.dockerMountSource || server.serverDir;
}

function serverDockerWorkingDir(server: ManagedServer) {
  if (server.dockerWorkingDir) {
    return server.dockerWorkingDir;
  }
  if (config.serversDockerVolume && server.storageName) {
    return `/data/servers/${server.storageName}`;
  }
  return "/data/server";
}

function serverDockerBindTarget(server: ManagedServer) {
  return serverDockerWorkingDir(server).startsWith("/data/servers/") ? "/data/servers" : "/data/server";
}

function dockerContainerMountValid(server: ManagedServer, details: DockerContainerInspect) {
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

async function removeDockerContainer(server: ManagedServer) {
  logInfo({ ...serverLogFields(server), action: "remove_container" }, "Removing Minecraft runtime container");
  await dockerRequest("DELETE", `/containers/${encodeURIComponent(dockerContainerName(server))}?force=1`, 204);
}

async function removeManagedDockerContainer(server: ManagedServer) {
  const existing = await inspectDockerContainer(server);
  if (!existing) {
    return false;
  }
  if (existing.Config?.Labels?.["serversentinel.managed"] !== "true") {
    throw new Error(`Container ${dockerContainerName(server)} exists but is not managed by ServerSentinel; refusing to delete it`);
  }
  await removeDockerContainer(server);
  return true;
}

function splitImage(image: string) {
  const slashIndex = image.lastIndexOf("/");
  const colonIndex = image.lastIndexOf(":");
  if (colonIndex > slashIndex) {
    return { fromImage: image.slice(0, colonIndex), tag: image.slice(colonIndex + 1) };
  }
  return { fromImage: image, tag: "latest" };
}

async function ensureDockerImage(image: string) {
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

async function inspectDockerContainer(server: ManagedServer) {
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

async function ensureDockerContainer(server: ManagedServer) {
  const existing = await inspectDockerContainer(server);
  if (existing) {
    if (existing.Config?.Labels?.["serversentinel.managed"] !== "true") {
      logWarn(serverLogFields(server), "Refusing to control unmanaged Docker container");
      throw new Error(`Container ${dockerContainerName(server)} exists but is not managed by ServerSentinel; refusing to control it`);
    }
    if (dockerContainerMountValid(server, existing)) {
      return;
    }
    logWarn(serverLogFields(server), "Removing managed Docker container with stale mount");
    await removeDockerContainer(server);
  }
  if (!serverDockerMountSource(server) || !server.serverJar) {
    throw new Error("Docker managed control requires Docker mount source and server jar filename");
  }

  const startedAt = Date.now();
  const image = validateDockerImageName(server.dockerImage || defaultDockerImageForMinecraftVersion(server.minecraftVersion));
  await ensureDockerImage(image);
  const { exposedPorts, portBindings } = parseDockerPorts(server.dockerPorts || "25565:25565/tcp");
  const javaArgs = validateJavaArgs(server.javaArgs || "-Xms2G -Xmx4G");
  const quotedServerJar = shellQuote(server.serverJar);
  const command = `test -f ${quotedServerJar} || { echo "ServerSentinel could not find ${server.serverJar} in $(pwd)" >&2; ls -la >&2; exit 66; }; exec java ${javaArgs} -jar ${quotedServerJar} nogui`;
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
        Tty: false,
        ExposedPorts: exposedPorts,
        HostConfig: {
          Privileged: false,
          NetworkMode: "bridge",
          PortBindings: portBindings,
          Mounts: [
            {
              Type: serverDockerMountSource(server) === config.serversDockerVolume ? "volume" : "bind",
              Source: serverDockerMountSource(server),
              Target: bindTarget
            }
          ]
        },
        Labels: {
          "serversentinel.server-id": server.id,
          "serversentinel.managed": "true"
        }
      },
      [201]
    );
    logInfo({ ...serverLogFields(server), action: "create_container", durationMs: durationSince(startedAt), status: "succeeded" }, "Minecraft runtime container created");
  } catch (error) {
    logError({ ...serverLogFields(server), action: "create_container", durationMs: durationSince(startedAt), status: "failed", ...errorLogFields(error) }, "Docker container creation failed");
    throw error;
  }
}

async function dockerStatus(server: ManagedServer) {
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
      controllable: Boolean(server.dockerMountSource && server.serverJar),
      state: "unknown" as DockerState,
      container: dockerContainerName(server),
      message: server.dockerMountSource && server.serverJar
        ? "Managed container will be created on start"
        : "Configured container does not exist"
    };
  }
  const managed = details.Config?.Labels?.["serversentinel.managed"] === "true";
  const mountValid = dockerContainerMountValid(server, details);
  return {
    configured: true,
    available: true,
    controllable: managed && mountValid,
    state: details.State?.Status ?? "unknown",
    running: Boolean(details.State?.Running),
    container: dockerContainerName(server),
    name: details.Name?.replace(/^\//, ""),
    message: !managed
      ? "A same-named Docker container exists but is not managed by ServerSentinel"
      : !mountValid
        ? "Managed container has an incompatible server volume mount"
        : undefined
  };
}

async function dockerAction(server: ManagedServer, action: "start" | "stop" | "restart") {
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
      if (existing?.Config?.Labels?.["serversentinel.managed"] !== "true") {
        throw new Error(`Container ${dockerContainerName(server)} is not managed by ServerSentinel; refusing to control it`);
      }
    }
    await dockerRequest("POST", `/containers/${encodeURIComponent(dockerContainerName(server))}/${action}`, [200, 204, 304]);
    if (action === "start" || action === "restart") {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const status = await dockerStatus(server);
      if (!status.running) {
        logWarn({ ...serverLogFields(server), action, durationMs: durationSince(startedAt), status: status.state }, "Runtime container exited unexpectedly after action");
        const logs = await dockerRecentLogs(server).catch(() => "");
        throw new Error(`Minecraft runtime container exited after ${action}${logs.trim() ? `: ${logs.trim().slice(-800)}` : ""}`);
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

async function dockerCommandInputCapability(server: ManagedServer, currentStatus?: Awaited<ReturnType<typeof dockerStatus>>) {
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

  if (details.Config?.Labels?.["serversentinel.managed"] !== "true") {
    return {
      available: false,
      message: "Console command input is best-effort only for non-managed containers and is disabled"
    };
  }

  if (!details.Config?.OpenStdin || !details.Config.AttachStdin || details.Config.Tty) {
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

async function sendDockerStdinCommand(server: ManagedServer, command: string) {
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
  if (/[\r\n]/.test(line)) {
    throw new Error("Only one console command can be sent at a time");
  }

  const payload = Buffer.from(`${line}\n`, "utf8").toString("base64");
  const shellCommand = `printf %s ${payload} | base64 -d > /proc/1/fd/0`;
  const exec = await dockerJsonRequest<DockerExecCreate>(
    "POST",
    `/containers/${encodeURIComponent(dockerContainerName(server))}/exec`,
    {
      AttachStdin: false,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      Cmd: ["sh", "-lc", shellCommand]
    },
    201
  );
  const output = await dockerJsonBufferRequest("POST", `/exec/${encodeURIComponent(exec.Id)}/start`, { Detach: false, Tty: false }, 200);
  const inspect = await dockerRequest<DockerExecInspect>("GET", `/exec/${encodeURIComponent(exec.Id)}/json`, 200);
  if (inspect.ExitCode) {
    const detail = stripDockerLogHeaders(output).toString("utf8").trim();
    throw new Error(`Docker could not write to the Minecraft console stdin${detail ? `: ${detail}` : ""}`);
  }
  return { ok: true };
}

async function dockerRecentLogs(server: ManagedServer) {
  if (!dockerControlConfigured(server)) {
    throw new Error("Console logs are not configured for this managed server instance");
  }
  const response = await dockerBufferRequest(
    "GET",
    `/containers/${encodeURIComponent(dockerContainerName(server))}/logs?stdout=1&stderr=1&tail=200`,
    200
  );
  return stripDockerLogHeaders(response).toString("utf8");
}

async function dockerResourceStats(server: ManagedServer) {
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
  const cpuDelta = (stats.cpu_stats?.cpu_usage?.total_usage ?? 0) - (stats.precpu_stats?.cpu_usage?.total_usage ?? 0);
  const systemDelta = (stats.cpu_stats?.system_cpu_usage ?? 0) - (stats.precpu_stats?.system_cpu_usage ?? 0);
  const onlineCpus = stats.cpu_stats?.online_cpus || 1;
  const rawCpuPercent = systemDelta > 0 && cpuDelta > 0 ? (cpuDelta / systemDelta) * onlineCpus * 100 : 0;
  const memoryUsage = stats.memory_stats?.usage ?? 0;
  const reclaimableCache = stats.memory_stats?.stats?.cache ?? stats.memory_stats?.stats?.inactive_file ?? 0;
  const networkTotals = Object.values(stats.networks ?? {}).reduce(
    (totals, network) => ({
      rx: totals.rx + (network.rx_bytes ?? 0),
      tx: totals.tx + (network.tx_bytes ?? 0)
    }),
    { rx: 0, tx: 0 }
  );

  return {
    available: true,
    running: true,
    cpuPercent: Number.isFinite(rawCpuPercent) ? Math.max(0, rawCpuPercent) : 0,
    memoryUsageBytes: Math.max(0, memoryUsage - reclaimableCache),
    memoryLimitBytes: stats.memory_stats?.limit ?? 0,
    networkRxBytes: networkTotals.rx,
    networkTxBytes: networkTotals.tx,
    readAt: stats.read ?? new Date().toISOString(),
    container: dockerContainerName(server)
  };
}

function readFileRange(filePath: string, start: number, end: number) {
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

async function readLatestServerLog(server: ManagedServer) {
  const logPath = await validateExistingInsideServer(server, "logs/latest.log");
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

function parseOnlinePlayerCount(logText: string) {
  const matches = [...logText.matchAll(/There are\s+(\d+)\s+of a max(?:imum)? of\s+\d+\s+players online/gi)];
  const latest = matches.at(-1);
  return latest ? Number(latest[1]) : null;
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

function normalizeJavaRuntime(server: ManagedServer) {
  const image = server.dockerImage || "";
  if (/temurin/i.test(image)) {
    const version = image.match(/temurin:([^,\s]+)/i)?.[1];
    return version ? `Temurin ${version.replace(/-jre$/i, "")}` : "Temurin";
  }
  if (/java/i.test(image) || /jdk|jre/i.test(image)) return image;
  return undefined;
}

type ParsedEventInput = {
  eventType: ServerEvent["eventType"];
  severity: ServerEvent["severity"];
  message: string;
  timestamp?: string;
  source: ServerEvent["source"];
  index: number;
  signature: string;
};

function eventFromParsedLine(input: ParsedEventInput): ServerEvent {
  const id = `${input.source}-${input.index}-${input.timestamp ?? ""}-${createHash("sha1").update(input.signature).digest("hex").slice(0, 8)}`;
  return {
    id,
    eventType: input.eventType,
    type: input.severity,
    severity: input.severity,
    text: input.message,
    message: input.message,
    timestamp: input.timestamp,
    signature: input.signature,
    source: input.source
  };
}

function eventSignature(eventType: ServerEvent["eventType"], subject?: string) {
  const normalized = subject?.trim().toLowerCase().replace(/\s+/g, " ");
  return normalized ? `${eventType}:${normalized}` : eventType;
}

function cleanPlayerName(value: string) {
  return value.trim().replace(/^"|"$/g, "");
}

function cleanModName(value: string) {
  return value.trim().replace(/^["']|["']$/g, "").replace(/\s+/g, " ");
}

export function parseLogEvent(line: string, source: ServerEvent["source"], index: number): ServerEvent | null {
  const ansiStripped = line.replace(/\u001b\[[0-9;]*m/g, "").trim();
  if (!ansiStripped) return null;

  const tsMatch = ansiStripped.match(/^\[(?<time>\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?|\d{2}:\d{2}:\d{2})\]/);
  let timestamp: string | undefined;
  let rest = ansiStripped;

  if (tsMatch) {
    const rawTime = tsMatch.groups!.time;
    if (/^\d{2}:\d{2}:\d{2}$/.test(rawTime)) {
      timestamp = rawTime;
    } else {
      const normalized = rawTime.replace(" ", "T");
      const date = new Date(normalized);
      if (!Number.isNaN(date.getTime())) {
        timestamp = date.toISOString();
      }
    }
    rest = ansiStripped.slice(tsMatch[0].length).trim();
  }

  let level = "";
  let message = rest;

  const matchModern = rest.match(/^\[(?<thread>[^\]/]+)\/(?<level>[A-Z]+)\]:\s*(?<message>.*)$/);
  if (matchModern) {
    level = matchModern.groups!.level;
    message = matchModern.groups!.message;
  } else {
    const matchLegacy = rest.match(/^\[(?<thread>[^\]]+)\]\s+\[(?<level>[A-Z]+)\]:\s*(?<message>.*)$/);
    if (matchLegacy) {
      level = matchLegacy.groups!.level;
      message = matchLegacy.groups!.message;
    } else {
      const matchBrackets = rest.match(/^\[(?<level>[A-Z]+)\]:\s*(?<message>.*)$/);
      if (matchBrackets) {
        level = matchBrackets.groups!.level;
        message = matchBrackets.groups!.message;
      } else {
        const matchPlain = rest.match(/^(?<level>[A-Z]+):\s*(?<message>.*)$/);
        if (matchPlain) {
          level = matchPlain.groups!.level;
          message = matchPlain.groups!.message;
        }
      }
    }
  }

  const playerJoin = message.match(/^(.+?) joined the game$/i);
  if (playerJoin) {
    const player = cleanPlayerName(playerJoin[1]);
    return eventFromParsedLine({
      eventType: "player_joined",
      severity: "success",
      message: `Player joined: ${player}`,
      timestamp,
      source,
      index,
      signature: eventSignature("player_joined", player)
    });
  }

  const playerLeft = message.match(/^(.+?) left the game$/i);
  if (playerLeft) {
    const player = cleanPlayerName(playerLeft[1]);
    return eventFromParsedLine({
      eventType: "player_left",
      severity: "info",
      message: `Player left: ${player}`,
      timestamp,
      source,
      index,
      signature: eventSignature("player_left", player)
    });
  }

  const playerDisconnected = message.match(/^(.+?) lost connection:/i);
  if (playerDisconnected) {
    const player = cleanPlayerName(playerDisconnected[1]);
    return eventFromParsedLine({
      eventType: "player_left",
      severity: "warning",
      message: `Player disconnected: ${player}`,
      timestamp,
      source,
      index,
      signature: eventSignature("player_left", player)
    });
  }

  const disconnectingPlayer = message.match(/^Disconnecting\s+(.+?)(?:\s*\(|:|$)/i);
  if (disconnectingPlayer) {
    const player = cleanPlayerName(disconnectingPlayer[1]);
    return eventFromParsedLine({
      eventType: "player_left",
      severity: "warning",
      message: `Player disconnected: ${player}`,
      timestamp,
      source,
      index,
      signature: eventSignature("player_left", player)
    });
  }

  if (/Done \([^)]+\)! For help, type "help"/i.test(message) || /Starting minecraft server/i.test(message)) {
    return eventFromParsedLine({
      eventType: "server_started",
      severity: "success",
      message: "Server started",
      timestamp,
      source,
      index,
      signature: eventSignature("server_started")
    });
  }
  if (/Stopping server|Stopping the server|ThreadedAnvilChunkStorage: All chunks are saved/i.test(message)) {
    return eventFromParsedLine({
      eventType: "server_stopped",
      severity: "info",
      message: "Server stopped",
      timestamp,
      source,
      index,
      signature: eventSignature("server_stopped")
    });
  }

  const disabledJar = message.match(/\b([\w .+@()[\]-]+?\.jar(?:\.disabled)?)\b.*\b(?:disabled|disabling)\b/i)
    ?? message.match(/\b(?:disabled|disabling)\b.*\b([\w .+@()[\]-]+?\.jar(?:\.disabled)?)\b/i);
  const disabledMod = disabledJar
    ?? message.match(/\bmod\s+["']?([^"',:]+?)["']?\s+(?:was\s+)?disabled\b/i)
    ?? message.match(/\b(?:disabled|disabling)\s+mod\s+["']?([^"',:]+?)["']?\b/i);
  if (disabledMod) {
    const modName = cleanModName(disabledMod[1]);
    return eventFromParsedLine({
      eventType: "mod_disabled",
      severity: "warning",
      message: `Mod disabled: ${modName}`,
      timestamp,
      source,
      index,
      signature: eventSignature("mod_disabled", modName)
    });
  }

  if (
    /Encountered an unexpected exception|This crash report has been saved to:|Minecraft Crash Report|A crash report has been generated|The game crashed|server crashed/i.test(message)
    || (level === "FATAL" && /\b(exception|crash|crashed)\b/i.test(message))
  ) {
    return eventFromParsedLine({
      eventType: "server_crashed",
      severity: "error",
      message: "Server crashed",
      timestamp,
      source,
      index,
      signature: eventSignature("server_crashed")
    });
  }
  return null;
}

async function serverOverviewData(server: ManagedServer) {
  const dockerConfigured = dockerControlConfigured(server);
  const [fileLog, dockerLog, properties, eula, dockerInspect] = await Promise.allSettled([
    readLatestServerLog(server),
    dockerConfigured ? dockerRecentLogs(server) : Promise.resolve(""),
    validateExistingInsideServer(server, "server.properties").then((path) => readFile(path, "utf8")),
    validateExistingInsideServer(server, "eula.txt").then((path) => readFile(path, "utf8")),
    dockerConfigured ? dockerRequest<DockerContainerInspect>("GET", `/containers/${encodeURIComponent(dockerContainerName(server))}/json`, 200) : Promise.resolve(null)
  ]);
  const logSources: Array<{ source: ServerEvent["source"]; text: string }> = [];
  if (fileLog.status === "fulfilled") logSources.push({ source: "logs/latest.log", text: fileLog.value });
  if (dockerLog.status === "fulfilled" && dockerConfigured) logSources.push({ source: "docker", text: dockerLog.value });
  const eventsStatus = fileLog.status === "fulfilled" || (dockerConfigured && dockerLog.status === "fulfilled") ? "ok" : "unavailable";
  const parsedEvents = logSources
    .flatMap(({ source, text }) => text.split(/\r?\n/).map((line, index) => parseLogEvent(line, source, index)).filter((event): event is ServerEvent => Boolean(event)));
  const reversedEvents = [...parsedEvents].reverse();
  const events = parsedEvents
    .slice(-10)
    .reverse();
  const props = properties.status === "fulfilled" ? parseProperties(properties.value) : {};
  const eulaAccepted = eula.status === "fulfilled"
    ? /^eula\s*=\s*true\s*$/im.test(eula.value)
    : undefined;
  const logText = logSources.map((source) => source.text).join("\n");
  const activity: ServerActivity = {
    lastStartedAt: dockerInspect.status === "fulfilled" && dockerInspect.value?.State?.StartedAt && !dockerInspect.value.State.StartedAt.startsWith("0001-")
      ? dockerInspect.value.State.StartedAt
      : reversedEvents.find((event) => event.eventType === "server_started")?.timestamp,
    lastStoppedAt: dockerInspect.status === "fulfilled" && dockerInspect.value?.State?.FinishedAt && !dockerInspect.value.State.FinishedAt.startsWith("0001-")
      ? dockerInspect.value.State.FinishedAt
      : reversedEvents.find((event) => event.eventType === "server_stopped")?.timestamp,
    lastRestartAt: reversedEvents.find((event) => /restart/i.test(event.text))?.timestamp,
    currentWorld: props["level-name"],
    serverPort: props["server-port"],
    eulaAccepted,
    javaRuntime: normalizeJavaRuntime(server),
    autosaveStatus: /Saved the game|Saved the world|Automatic saving is now enabled/i.test(logText) ? "Recently saved" : undefined,
    playersOnline: parseOnlinePlayerCount(logText),
    maxPlayers: props["max-players"] ? Number(props["max-players"]) : null
  };
  return { events, eventsStatus, activity };
}

async function onlinePlayerCount(server: ManagedServer) {
  await sendDockerStdinCommand(server, "list");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const logs = await Promise.allSettled([
    readLatestServerLog(server),
    dockerRecentLogs(server)
  ]);
  const text = logs
    .filter((result): result is PromiseFulfilledResult<string> => result.status === "fulfilled")
    .map((result) => result.value)
    .join("\n");
  return parseOnlinePlayerCount(text);
}

function streamLatestServerLog(server: ManagedServer, client: Client) {
  let offset = 0;
  let closed = false;
  let announcedEmpty = false;
  let lastLoggedError = "";

  const send = (text: string) => {
    if (text && client.readyState === 1) {
      client.send(JSON.stringify({ type: "log", source: "latest.log", text, at: new Date().toISOString() }));
    }
  };

  const poll = async () => {
    if (closed) return;
    try {
      const logPath = await validateExistingInsideServer(server, "logs/latest.log");
      const logStat = await stat(logPath);
      if (!logStat.isFile()) {
        client.send(JSON.stringify({ type: "unavailable", message: "logs/latest.log is not a file" }));
        return;
      }

      if (logStat.size < offset) {
        offset = 0;
      }

      if (logStat.size > offset) {
        const start = offset === 0 ? Math.max(0, logStat.size - 128 * 1024) : offset;
        const chunk = await readFileRange(logPath, start, logStat.size - 1);
        offset = logStat.size;
        send(chunk.toString("utf8"));
      } else if (offset === 0 && !announcedEmpty) {
        offset = logStat.size;
        announcedEmpty = true;
        client.send(JSON.stringify({
          type: "empty",
          source: "latest.log",
          text: "logs/latest.log is empty.",
          at: new Date().toISOString()
        }));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to read logs/latest.log";
      if (message !== lastLoggedError) {
        lastLoggedError = message;
        logWarn({ ...serverLogFields(server), source: "logs/latest.log", ...errorLogFields(error) }, "Console file log stream unavailable");
      }
      if (client.readyState === 1) {
        client.send(JSON.stringify({ type: "unavailable", message }));
      }
    }
  };

  void poll();
  const interval = setInterval(() => void poll(), 1_000);
  return () => {
    closed = true;
    clearInterval(interval);
  };
}

function stripDockerLogHeaders(buffer: Buffer) {
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > buffer.length) break;
    chunks.push(buffer.subarray(start, end));
    offset = end;
  }
  return chunks.length ? Buffer.concat(chunks) : buffer;
}

function streamDockerLogs(server: ManagedServer, client: Client) {
  if (!dockerControlConfigured(server) || !dockerAvailable()) {
    logWarn({ ...serverLogFields(server), source: "docker" }, "Docker log stream unavailable");
    client.send(JSON.stringify({ type: "unavailable", message: "Docker logs are not configured for this server" }));
    return undefined;
  }

  const request = http.request(
    {
      socketPath: config.dockerSocket,
      path: `/containers/${encodeURIComponent(dockerContainerName(server))}/logs?stdout=1&stderr=1&tail=200&follow=1`,
      method: "GET"
    },
    (response) => {
      if (response.statusCode !== 200) {
        logWarn({ ...serverLogFields(server), source: "docker", statusCode: response.statusCode }, "Docker log stream returned non-OK status");
        client.send(JSON.stringify({ type: "unavailable", message: `Docker logs returned ${response.statusCode}` }));
        return;
      }
      response.on("data", (chunk: Buffer) => {
        const text = stripDockerLogHeaders(chunk).toString("utf8");
        if (text && client.readyState === 1) {
          client.send(JSON.stringify({ type: "log", source: "docker", text, at: new Date().toISOString() }));
        }
      });
    }
  );
  request.on("error", (error) => {
    logWarn({ ...serverLogFields(server), source: "docker", ...errorLogFields(error) }, "Docker log stream failed");
    if (client.readyState === 1) {
      client.send(JSON.stringify({ type: "unavailable", message: error.message }));
    }
  });
  request.end();
  return request;
}

async function downloadFabricServerJar(server: ManagedServer) {
  if (!server.minecraftVersion || !server.loaderVersion || !server.installerVersion || !server.serverJar) {
    throw new Error("Minecraft, loader, installer, and server jar versions are required");
  }

  const target = ensureInsideServer(server, server.serverJar);
  const url = `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(server.minecraftVersion)}/${encodeURIComponent(server.loaderVersion)}/${encodeURIComponent(server.installerVersion)}/server/jar`;
  const startedAt = Date.now();
  logInfo({ ...serverLogFields(server), minecraftVersion: server.minecraftVersion, loaderVersion: server.loaderVersion, installerVersion: server.installerVersion, filename: server.serverJar }, "Downloading Fabric server launcher");
  const response = await fetch(url, {
    headers: {
      "User-Agent": "ServerSentinel/0.3.0 (Fabric server creator)"
    }
  });
  if (!response.ok || !response.body) {
    logError({ ...serverLogFields(server), statusCode: response.status, durationMs: durationSince(startedAt) }, "Fabric server launcher download failed");
    throw new Error(`Fabric server jar download failed: ${response.status} ${response.statusText}`);
  }
  await pipeline(
    Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>),
    createWriteStream(target)
  );
  const downloaded = await stat(target);
  if (!downloaded.isFile() || downloaded.size === 0) {
    throw new Error("Fabric server launcher download did not produce a runnable jar");
  }
  logInfo({ ...serverLogFields(server), filename: server.serverJar, size: downloaded.size, durationMs: durationSince(startedAt) }, "Fabric server launcher downloaded");
}

async function ensureServerStoppedForModChanges(server: ManagedServer) {
  const status = await dockerStatus(server);
  if (status.running) {
    throw new Error("Stop the server before enabling, disabling, or removing mods");
  }
}

async function createServerFiles(
  server: ManagedServer,
  acceptEula: boolean,
  serverPort: string,
  report?: (progress: number, task: string) => void
) {
  report?.(35, "Creating server folders");
  await mkdir(server.serverDir, { recursive: true });
  await mkdir(ensureInsideServer(server, "mods"), { recursive: true });
  await mkdir(ensureInsideServer(server, "logs"), { recursive: true });
  logInfo(serverLogFields(server), "Managed server files created");
  report?.(45, "Downloading Fabric server launcher");
  await downloadFabricServerJar(server);
  report?.(65, "Writing Minecraft configuration");
  await writeFile(ensureInsideServer(server, "server.properties"), `server-port=${serverPort}\n`, { flag: "wx" }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
  await writeFile(ensureInsideServer(server, "eula.txt"), `# Managed by ServerSentinel\n# Only set true if you accept the Minecraft EULA.\neula=${acceptEula ? "true" : "false"}\n`, "utf8");
  await writeVersionMetadataFile(server);
  await writeFile(ensureInsideServer(server, "logs/latest.log"), "", { flag: "a" });
}

async function createManagedServer(input: CreateServerInput, report?: (progress: number, task: string) => void, jobId?: string) {
  if ((input.nodeId ?? localNodeId) !== localNodeId) {
    throw new Error("Remote server provisioning is not implemented yet");
  }
  const startedAt = Date.now();
  report?.(5, "Validating server settings");
  const displayName = input.displayName?.trim();
  const minecraftVersion = input.minecraftVersion?.trim();
  if (!displayName || displayName.length > 80 || !minecraftVersion) {
    throw new Error("Display name and Minecraft version are required");
  }
  if (input.acceptEula !== true) {
    throw new Error("You must confirm Minecraft EULA acceptance to create a runnable server");
  }
  if ((await queuedReadServers()).some((server) => server.displayName.toLowerCase() === displayName.toLowerCase())) {
    throw new Error("A managed server with this display name already exists");
  }

  report?.(15, "Reserving server storage");
  await mkdir(config.serversDir, { recursive: true });
  const storageBase = slugify(displayName);
  let storageName = storageBase;
  let counter = 2;
  while (existsSync(resolve(config.serversDir, storageName))) {
    storageName = `${storageBase}-${counter}`;
    counter += 1;
  }

  report?.(25, "Resolving Fabric versions");
  const resolvedServerDir = resolve(config.serversDir, storageName);
  const loaderVersion = input.loaderVersion?.trim() || await latestFabricVersion("loader");
  const installerVersion = input.installerVersion?.trim() || await latestFabricVersion("installer");
  const serverJar = validateRuntimeJarFilename(input.serverJar?.trim() || "fabric-server-launch.jar");
  const serverPort = input.serverPort?.trim() || "25565";
  if (!isValidServerPort(serverPort)) {
    throw new Error(`Server port must be between ${minServerPort} and ${maxServerPort}`);
  }
  const dockerContainer = validateDockerContainerName(input.dockerContainer?.trim() || defaultContainerName(displayName));
  const dockerImage = validateDockerImageName(input.dockerImage?.trim() || defaultDockerImageForMinecraftVersion(minecraftVersion));
  const dockerPorts = input.dockerPorts?.trim() || `${serverPort}:${serverPort}/tcp`;
  parseDockerPorts(dockerPorts);
  const javaArgs = validateJavaArgs(input.javaArgs?.trim() || "-Xms2G -Xmx4G");

  const now = new Date().toISOString();
  const server: ManagedServer = {
    id: randomUUID(),
    nodeId: localNodeId,
    displayName,
    serverDir: resolvedServerDir,
    storageName,
    minecraftVersion,
    loaderVersion,
    installerVersion,
    serverJar,
    dockerContainer,
    dockerImage,
    dockerMountSource: config.serversDockerVolume || resolvedServerDir,
    dockerWorkingDir: config.serversDockerVolume ? `/data/servers/${storageName}` : undefined,
    dockerPorts,
    javaArgs,
    serverType: "fabric",
    createdAt: now,
    updatedAt: now
  };

  logInfo({ ...serverLogFields(server), jobId, minecraftVersion, loaderVersion, installerVersion }, "Fabric metadata resolved for provisioning");
  try {
    await createServerFiles(server, input.acceptEula, serverPort, report);
    if (dockerAvailable()) {
      report?.(78, "Pulling runtime image and creating Docker container");
      await ensureDockerContainer(server);
    } else {
      report?.(78, "Runtime management unavailable; Docker socket is not mounted");
      logWarn({ ...serverLogFields(server), jobId }, "Docker socket is not mounted during provisioning");
    }

    report?.(92, "Saving server registration");
    await updateServers((servers) => {
      servers.push(server);
    });
    report?.(100, "Server setup complete");
    logInfo({ ...serverLogFields(server), jobId, durationMs: durationSince(startedAt), status: "succeeded" }, "Provisioning succeeded");
    return server;
  } catch (error) {
    logError({ ...serverLogFields(server), jobId, durationMs: durationSince(startedAt), status: "failed", ...errorLogFields(error) }, "Provisioning failed");
    throw error;
  }
}

function updateProvisionJob(id: string, patch: Partial<ProvisionJob>) {
  const current = provisionJobs.get(id);
  if (!current) return;
  provisionJobs.set(id, {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString()
  });
}

function startProvisionJob(input: CreateServerInput) {
  const nodeId = input.nodeId?.trim() || (config.runtimeMode === "all-in-one" ? localNodeId : "");
  if (!nodeId) {
    throw new Error("nodeId is required when ServerSentinel runs in panel mode");
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  provisionJobs.set(id, {
    id,
    status: "running",
    progress: 0,
    task: "Queued server setup",
    createdAt: now,
    updatedAt: now
  });
  logInfo({ jobId: id, serverName: input.displayName?.trim() }, "Provisioning job started");

  void runtimeForNodeId(nodeId).createServer({ ...input, nodeId }, (progress, task) => {
    updateProvisionJob(id, { progress, task });
  }, id).then(async (server) => {
    updateProvisionJob(id, {
      status: "succeeded",
      progress: 100,
      task: "Server setup complete",
      server: await runtimeForServer(server).publicServer(server)
    });
    setTimeout(() => provisionJobs.delete(id), 10 * 60 * 1000).unref();
  }).catch((error: unknown) => {
    updateProvisionJob(id, {
      status: "failed",
      error: error instanceof Error ? error.message : "Server setup failed",
      task: "Server setup failed"
    });
    setTimeout(() => provisionJobs.delete(id), 10 * 60 * 1000).unref();
  });

  return provisionJobs.get(id)!;
}

function scheduleFromBody(body: {
  name?: string;
  cron?: string;
  commands?: unknown;
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
  const now = new Date().toISOString();
  return {
    id: existing?.id ?? randomUUID(),
    name,
    cron,
    commands: sanitizeCommands(body.commands),
    onlyWhenNoPlayers: optionalStrictBoolean(body.onlyWhenNoPlayers, "onlyWhenNoPlayers", false),
    enabled: optionalStrictBoolean(body.enabled, "enabled", existing?.enabled ?? true),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastRunAt: existing?.lastRunAt,
    lastStatus: existing?.lastStatus,
    lastMessage: existing?.lastMessage
  };
}

async function runScheduledExecution(server: ManagedServer, schedule: ScheduledExecution) {
  const startedAt = Date.now();
  try {
    const runtime = runtimeForServer(server);
    const status = await runtime.serverStatus(server) as { docker?: { running?: boolean } };
    if (!status.docker?.running) {
      logInfo({ ...serverLogFields(server), scheduleId: schedule.id, reason: "server_offline" }, "Schedule skipped");
      return { status: "skipped", message: "Skipped because Minecraft server is stopped" };
    }
    if (schedule.onlyWhenNoPlayers) {
      const count = await onlinePlayerCount(server);
      if (count === null) {
        logWarn({ ...serverLogFields(server), scheduleId: schedule.id, commandsCount: schedule.commands.length, reason: "player_count_unknown" }, "Schedule skipped");
        return { status: "skipped", message: "Skipped because online player count could not be determined" };
      }
      if (count > 0) {
        logInfo({ ...serverLogFields(server), scheduleId: schedule.id, commandsCount: schedule.commands.length, playersOnline: count, reason: "players_online" }, "Schedule skipped");
        return { status: "skipped", message: `Skipped because ${count} player${count === 1 ? "" : "s"} are online` };
      }
    }

    for (const command of schedule.commands) {
      await runtime.sendConsoleCommand(server, command);
    }
    logInfo({ ...serverLogFields(server), scheduleId: schedule.id, commandsCount: schedule.commands.length, durationMs: durationSince(startedAt), status: "success" }, "Schedule execution succeeded");
    return { status: "success", message: `Sent ${schedule.commands.length} command${schedule.commands.length === 1 ? "" : "s"}` };
  } catch (error) {
    logError({ ...serverLogFields(server), scheduleId: schedule.id, commandsCount: schedule.commands.length, durationMs: durationSince(startedAt), status: "failed", ...errorLogFields(error) }, "Schedule execution failed");
    return { status: "failed", message: error instanceof Error ? error.message : "Scheduled execution failed" };
  }
}

const runningSchedules = new Set<string>();

async function tickSchedules() {
  const now = new Date();
  const runKey = now.toISOString().slice(0, 16);
  const servers = await queuedReadServers();
  let changed = false;

  for (const server of servers) {
    for (const schedule of server.schedules ?? []) {
      if (!schedule.enabled) continue;
      const key = `${server.id}:${schedule.id}:${runKey}`;
      if (runningSchedules.has(key) || schedule.lastRunAt?.startsWith(runKey)) continue;
      try {
        if (!cronMatches(schedule.cron, now)) continue;
      } catch {
        logWarn({ ...serverLogFields(server), scheduleId: schedule.id, cron: schedule.cron, reason: "invalid_cron" }, "Schedule skipped");
        continue;
      }

      runningSchedules.add(key);
      try {
        logInfo({ ...serverLogFields(server), scheduleId: schedule.id, commandsCount: schedule.commands.length }, "Schedule matched");
        const result = await runScheduledExecution(server, schedule);
        schedule.lastRunAt = new Date().toISOString();
        schedule.lastStatus = result.status;
        schedule.lastMessage = result.message;
        schedule.updatedAt = schedule.lastRunAt;
        changed = true;
      } finally {
        runningSchedules.delete(key);
      }
    }
  }

  if (changed) {
    await updateServers((currentServers) => {
      for (const server of servers) {
        const currentServer = currentServers.find((s) => s.id === server.id);
        if (!currentServer) continue;
        for (const schedule of server.schedules ?? []) {
          const currentSchedule = currentServer.schedules?.find((sch) => sch.id === schedule.id);
          if (currentSchedule) {
            currentSchedule.lastRunAt = schedule.lastRunAt;
            currentSchedule.lastStatus = schedule.lastStatus;
            currentSchedule.lastMessage = schedule.lastMessage;
            currentSchedule.updatedAt = schedule.updatedAt;
          }
        }
      }
    });
  }
}

async function localUpdateServer(serverId: string, input: unknown) {
  const body = input as {
    displayName?: string;
    minecraftVersion?: string;
    loaderVersion?: string;
    installerVersion?: string;
    serverJar?: string;
    dockerContainer?: string;
    dockerImage?: string;
    dockerPorts?: string;
    javaArgs?: string;
    serverPort?: string;
  };
  let updatedServer: ManagedServer | null = null;
  await updateServers(async (servers) => {
    const index = servers.findIndex((candidate) => candidate.id === serverId);
    if (index === -1) {
      throw new Error("Server not found");
    }

    const current = servers[index];
    if (servers.some((server) => server.id !== current.id && server.displayName.toLowerCase() === (body.displayName?.trim() || current.displayName).toLowerCase())) {
      throw new Error("A managed server with this display name already exists");
    }
    const status = await dockerStatus(current);
    if (status.running) {
      throw new Error("Stop the server before changing its configuration");
    }
    const minecraftVersion = body.minecraftVersion?.trim() || current.minecraftVersion;
    const loaderVersion = body.loaderVersion?.trim() || current.loaderVersion || await latestFabricVersion("loader");
    const installerVersion = body.installerVersion?.trim() || current.installerVersion || await latestFabricVersion("installer");
    const serverJar = validateRuntimeJarFilename(body.serverJar?.trim() || current.serverJar || "fabric-server-launch.jar");
    const serverPort = body.serverPort?.trim();
    if (serverPort && !isValidServerPort(serverPort)) {
      throw new Error(`Server port must be between ${minServerPort} and ${maxServerPort}`);
    }
    const dockerContainer = validateDockerContainerName(body.dockerContainer?.trim() || current.dockerContainer || defaultContainerName(current.displayName));
    const dockerImage = validateDockerImageName(body.dockerImage?.trim() || current.dockerImage || defaultDockerImageForMinecraftVersion(minecraftVersion));
    const dockerPorts = body.dockerPorts?.trim() || (serverPort ? `${serverPort}:${serverPort}/tcp` : current.dockerPorts);
    if (dockerPorts) parseDockerPorts(dockerPorts);
    const javaArgs = validateJavaArgs(body.javaArgs?.trim() || current.javaArgs || "-Xms2G -Xmx4G");

    const jarChanged = current.minecraftVersion !== minecraftVersion
      || current.loaderVersion !== loaderVersion
      || current.installerVersion !== installerVersion
      || current.serverJar !== serverJar;

    const updated: ManagedServer = {
      ...current,
      displayName: body.displayName?.trim() || current.displayName,
      minecraftVersion,
      loaderVersion,
      installerVersion,
      serverJar,
      dockerContainer,
      dockerImage,
      dockerPorts,
      javaArgs,
      updatedAt: new Date().toISOString()
    };

    if (jarChanged) {
      await downloadFabricServerJar(updated);
    }
    await writeVersionMetadataFile(updated);
    if (serverPort) {
      await writeFile(ensureInsideServer(updated, "server.properties"), `server-port=${serverPort}\n`, { flag: "wx" }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      });
    }

    servers[index] = updated;
    updatedServer = updated;
  });
  return updatedServer!;
}

async function localDeleteServer(server: ManagedServer, input: unknown) {
  const body = input as { confirmName?: string; deleteFiles?: boolean };
  let deletedContainer = false;
  let deletedFiles = false;
  let serverFields: Record<string, unknown> = {};

  await updateServers(async (servers) => {
    const index = servers.findIndex((candidate) => candidate.id === server.id);
    if (index === -1) {
      throw new Error("Server not found");
    }

    const current = servers[index];
    serverFields = serverLogFields(current);
    const status = await dockerStatus(current);
    if (status.running) {
      throw new Error("Stop the server before deleting it");
    }
    if (body.confirmName !== current.displayName) {
      throw new Error(`Type "${current.displayName}" to confirm deletion`);
    }

    deletedContainer = dockerAvailable() ? await removeManagedDockerContainer(current) : false;
    const deleteFiles = optionalStrictBoolean(body.deleteFiles, "deleteFiles", false);
    if (deleteFiles) {
      const directory = ensureManagedServerDirectory(current);
      await rm(directory, { recursive: true, force: true });
      deletedFiles = true;
    }

    servers.splice(index, 1);
  });

  logInfo({ ...serverFields, deletedFiles, deletedContainer, action: "delete_server" }, "Managed server deleted");
  return { ok: true, deletedFiles, deletedContainer };
}

async function localServerStatus(server: ManagedServer) {
  const latestLogPath = await validateExistingInsideServer(server, "logs/latest.log").catch(() => "");
  const docker = await dockerStatus(server);
  const commandInput = await dockerCommandInputCapability(server, docker);
  return {
    server: await publicServer(server),
    docker,
    fileLogsAvailable: Boolean(latestLogPath && existsSync(latestLogPath)),
    controlAvailable: Boolean(docker.controllable),
    commandInputAvailable: commandInput.available,
    commandInputMessage: commandInput.message
  };
}

async function localSendConsoleCommand(server: ManagedServer, command: unknown) {
  const startedAt = Date.now();
  try {
    const result = await sendDockerStdinCommand(server, typeof command === "string" ? command : "");
    logInfo({ ...serverLogFields(server), action: "send_console_command", commandsCount: 1, durationMs: durationSince(startedAt), status: "succeeded" }, "Console command sent");
    return result;
  } catch (error) {
    logOperationFailure({ ...serverLogFields(server), action: "send_console_command", commandsCount: typeof command === "string" && command.trim() ? 1 : 0, durationMs: durationSince(startedAt), status: "failed" }, "Console command failed", error);
    throw error;
  }
}

async function localStreamConsole(server: ManagedServer, client: unknown, onClose: (cleanup: () => void) => void) {
  const consoleClient = client as Client;
  consoleClient.send(JSON.stringify({ type: "status", status: await dockerStatus(server) }));
  if (dockerControlConfigured(server) && dockerAvailable()) {
    const logRequest = streamDockerLogs(server, consoleClient);
    onClose(() => logRequest?.destroy());
    return;
  }

  onClose(streamLatestServerLog(server, consoleClient));
}

async function localServerLogs(server: ManagedServer) {
  if (dockerControlConfigured(server) && dockerAvailable()) {
    return { text: await dockerRecentLogs(server), source: "docker" };
  }
  return { text: await readLatestServerLog(server), source: "logs/latest.log" };
}

export async function startServer() {
const app = Fastify({
  logger: {
    level: config.logLevel,
    redact: [
      "req.headers.authorization",
      "req.headers.cookie",
      "res.headers.set-cookie",
      "request.headers.authorization",
      "request.headers.cookie"
    ]
  },
  disableRequestLogging: true,
  bodyLimit: 180 * 1024 * 1024
});
appLogger = app.log;
await app.register(helmet, {
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'", "ws:", "wss:"]
    }
  },
  crossOriginOpenerPolicy: false,
  originAgentCluster: false,
  strictTransportSecurity: false,
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  xFrameOptions: { action: "deny" }
});
await app.register(rateLimit, {
  global: true,
  max: 600,
  timeWindow: "1 minute"
});
await app.register(websocket);

app.addHook("onRequest", async (request, reply) => {
  if (request.method === "GET" && !request.url.startsWith("/api/")) {
    return;
  }
  if (request.method === "GET" && request.url.includes("/mods/icon")) {
    return;
  }
  if (request.url.startsWith("/ws/")) {
    assertSameOriginRequest(request);
    return;
  }
  if (request.raw.url?.startsWith("/api/nodes/connect")) {
    return;
  }
  if (request.url.startsWith("/api/")) {
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      assertSameOriginRequest(request);
    }
    const requestedWith = request.headers["x-requested-with"];
    if (requestedWith !== "XMLHttpRequest") {
      reply.code(400);
      throw new Error("CSRF protection: missing or invalid X-Requested-With header");
    }
  }
});

app.get("/api/auth/session", async (request) => {
  const users = await queuedReadUsers();
  const user = await currentUserFromCookie(request.headers.cookie);
  return {
    authenticated: Boolean(user),
    setupRequired: users.length === 0,
    user: user ? publicUser(user) : null
  };
});

app.post<{ Body: { username?: string; password?: string } }>("/api/auth/register-first", authRateLimit, async (request, reply) => {
  const username = validateUsername(request.body.username);
  const password = validatePassword(request.body.password);
  const now = new Date().toISOString();
  const passwordData = hashPassword(password);
  const user: StoredUser = {
    id: randomUUID(),
    username,
    rolePreset: "admin",
    permissions: normalizePermissions(ROLE_PRESETS.admin),
    createdAt: now,
    updatedAt: now,
    ...passwordData
  };
  await updateUsers((users) => {
    if (users.length > 0) {
      const error = new Error("Initial registration is already complete") as Error & { statusCode?: number };
      error.statusCode = 403;
      throw error;
    }
    users.push(user);
  });
  const sessionId = randomBytes(32).toString("base64url");
  sessions.set(sessionId, { id: sessionId, userId: user.id, createdAt: now });
  const isSecure = request.protocol === "https" || request.headers["x-forwarded-proto"] === "https";
  reply.header("Set-Cookie", sessionCookie(sessionId, 60 * 60 * 24 * 14, isSecure));
  logInfo({ userId: user.id, username: user.username, rolePreset: user.rolePreset, action: "register_first" }, "Initial admin user created");
  return { authenticated: true, setupRequired: false, user: publicUser(user) };
});

app.post<{ Body: { username?: string; password?: string } }>("/api/auth/login", authRateLimit, async (request, reply) => {
  const username = request.body.username?.trim() ?? "";
  const password = request.body.password ?? "";
  if (username === "demo" && password === "demo") {
    logInfo({ username: "demo", action: "login_demo" }, "Demo login requested");
    return { authenticated: false, setupRequired: (await queuedReadUsers()).length === 0, demo: true, user: null };
  }
  const users = await queuedReadUsers();
  const user = users.find((candidate) => candidate.username.toLowerCase() === username.toLowerCase());
  if (!user || !verifyPassword(password, user)) {
    logWarn({ username, action: "login", status: "failed" }, "Login failed");
    const error = new Error("Invalid username or password") as Error & { statusCode?: number };
    error.statusCode = 401;
    throw error;
  }
  const sessionId = randomBytes(32).toString("base64url");
  const now = new Date().toISOString();
  sessions.set(sessionId, { id: sessionId, userId: user.id, createdAt: now });
  const isSecure = request.protocol === "https" || request.headers["x-forwarded-proto"] === "https";
  reply.header("Set-Cookie", sessionCookie(sessionId, 60 * 60 * 24 * 14, isSecure));
  logInfo({ userId: user.id, username: user.username, rolePreset: user.rolePreset, action: "login", status: "succeeded" }, "Login succeeded");
  return { authenticated: true, setupRequired: false, user: publicUser(user) };
});

app.post("/api/auth/logout", async (request, reply) => {
  const sessionId = parseCookies(request.headers.cookie).get(sessionCookieName);
  if (sessionId) {
    sessions.delete(sessionId);
  }
  reply.header("Set-Cookie", sessionCookie("", 0));
  logInfo({ action: "logout" }, "User logged out");
  return { ok: true };
});

app.get("/api/users", async (request) => {
  await requireRequestPermission(request, "users.view");
  return { users: (await queuedReadUsers()).map(publicUser) };
});

app.post<{ Body: { username?: string; displayName?: string; password?: string; rolePreset?: RolePreset; permissions?: unknown[] } }>("/api/users", destructiveRateLimit, async (request) => {
  await requireRequestPermission(request, "users.manage");
  const username = validateUsername(request.body.username);
  const displayName = normalizeDisplayName(request.body.displayName);
  const password = validatePassword(request.body.password);
  const rolePreset = normalizeRolePreset(request.body.rolePreset);
  const permissionData = buildUserPermissions({
    rolePreset,
    permissions: request.body.permissions
  });
  let createdUser: StoredUser | null = null;
  await updateUsers((users) => {
    if (users.some((user) => user.username.toLowerCase() === username.toLowerCase())) {
      const error = new Error("A user with that username already exists") as Error & { statusCode?: number };
      error.statusCode = 400;
      throw error;
    }
    const now = new Date().toISOString();
    createdUser = {
      id: randomUUID(),
      username,
      displayName,
      rolePreset: permissionData.rolePreset,
      permissions: permissionData.permissions,
      createdAt: now,
      updatedAt: now,
      ...hashPassword(password)
    };
    users.push(createdUser);
  });
  logInfo({ userId: createdUser!.id, username: createdUser!.username, rolePreset: createdUser!.rolePreset, action: "create_user" }, "User created");
  return publicUser(createdUser!);
});

app.put<{ Params: { id: string }; Body: { username?: string; displayName?: string; password?: string; rolePreset?: RolePreset; permissions?: unknown[] } }>("/api/users/:id", destructiveRateLimit, async (request) => {
  await requireRequestPermission(request, "users.manage");
  let updatedUser: StoredUser | null = null;
  await updateUsers((users) => {
    const index = users.findIndex((user) => user.id === request.params.id);
    if (index === -1) {
      const error = new Error("User not found") as Error & { statusCode?: number };
      error.statusCode = 404;
      throw error;
    }
    const current = users[index];
    const username = request.body.username === undefined ? current.username : validateUsername(request.body.username);
    const displayName = request.body.displayName === undefined ? current.displayName : normalizeDisplayName(request.body.displayName);
    const rolePreset = normalizeRolePreset(request.body.rolePreset);
    const permissionData = buildUserPermissions({
      rolePreset,
      permissions: request.body.permissions
    }, current);
    const password = request.body.password?.trim() ? validatePassword(request.body.password) : undefined;
    if (users.some((user) => user.id !== current.id && user.username.toLowerCase() === username.toLowerCase())) {
      const error = new Error("A user with that username already exists") as Error & { statusCode?: number };
      error.statusCode = 400;
      throw error;
    }
    users[index] = {
      ...current,
      username,
      displayName,
      rolePreset: permissionData.rolePreset,
      permissions: permissionData.permissions,
      updatedAt: new Date().toISOString(),
      ...(password ? hashPassword(password) : {})
    };
    updatedUser = users[index];
  });
  logInfo({ userId: updatedUser!.id, username: updatedUser!.username, rolePreset: updatedUser!.rolePreset, action: "update_user" }, "User updated");
  return publicUser(updatedUser!);
});

app.delete<{ Params: { id: string } }>("/api/users/:id", destructiveRateLimit, async (request) => {
  await requireRequestPermission(request, "users.manage");
  let deletedUser: StoredUser | null = null;
  await updateUsers((users) => {
    const index = users.findIndex((candidate) => candidate.id === request.params.id);
    if (index === -1) {
      const error = new Error("User not found") as Error & { statusCode?: number };
      error.statusCode = 404;
      throw error;
    }
    const user = users[index];
    if (isFullAccessUser(user) && users.filter(isFullAccessUser).length <= 1) {
      const error = new Error("At least one admin user is required") as Error & { statusCode?: number };
      error.statusCode = 400;
      throw error;
    }
    users.splice(index, 1);
    deletedUser = user;
  });

  for (const [sessionId, session] of sessions) {
    if (session.userId === request.params.id) {
      sessions.delete(sessionId);
    }
  }
  logInfo({ userId: deletedUser!.id, username: deletedUser!.username, action: "delete_user" }, "User deleted");
  return { ok: true };
});

app.addHook("preHandler", async (request) => {
  if (!request.raw.url?.startsWith("/api/") || request.raw.url.startsWith("/api/auth/")) {
    return;
  }
  if (request.raw.url.startsWith("/api/nodes/connect")) {
    return;
  }
  const demoMode = request.headers["x-serversentinel-demo-mode"] === "true";
  if (demoMode) {
    if (request.method === "GET" && (request.raw.url === "/api/app" || request.raw.url.startsWith("/api/fabric/versions"))) {
      return;
    }
    const error = new Error("Demo mode is active. Disable demo mode before managing real servers.") as Error & { statusCode?: number };
    error.statusCode = 403;
    throw error;
  }
  await requireRequestPermission(request);
});

app.get("/api/app", async (request) => {
  const demoMode = request.headers["x-serversentinel-demo-mode"] === "true";
  const user = demoMode ? null : await requireRequestPermission(request, "servers.view");
  const servers = await queuedReadServers();
  const nodes = await queuedReadNodes();
  return {
    servers: await Promise.all(servers.map((server) => runtimeForServer(server).publicServer(server, nodes))),
    nodes: nodes.map(publicNode),
    runtimeMode: config.runtimeMode,
    modrinthApiConfigured: Boolean(await modrinthApiKey()),
    dockerSocketMounted: dockerAvailable(),
    totalMemory: totalmem(),
    currentUser: user ? publicUser(user) : undefined
  };
});

app.get("/api/nodes", async (request) => {
  await requireRequestPermission(request, "servers.view");
  return { nodes: (await queuedReadNodes()).map(publicNode) };
});

app.post<{ Body: { name?: string; tokenTtlMinutes?: number; dataMount?: string; panelUrl?: string } }>("/api/nodes", destructiveRateLimit, async (request): Promise<CreateNodeResponse> => {
  await requireRequestPermission(request, "users.manage");
  const now = new Date();
  const token = createJoinToken(request.body.tokenTtlMinutes);
  const nodeId = randomUUID();
  const nodeName = request.body.name?.trim() || "Remote Node";
  const node: ManagedNode = {
    id: nodeId,
    name: nodeName,
    type: "remote",
    status: "unknown",
    isInternal: false,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    compatibility: "unknown",
    capabilities: [],
    joinTokenHash: hashNodeSecret(token.joinToken),
    joinTokenExpiresAt: token.expiresAt
  };
  await updateNodes((nodes) => {
    nodes.push(node);
  });
  return {
    node: publicNode(node),
    joinToken: token.joinToken,
    expiresAt: token.expiresAt,
    install: nodeInstallInstructions({ panelUrl: request.body.panelUrl, joinToken: token.joinToken, dataMount: request.body.dataMount, nodeName })
  };
});

app.post<{ Body: { name?: string; tokenTtlMinutes?: number; dataMount?: string; panelUrl?: string } }>("/api/nodes/pending", destructiveRateLimit, async (request): Promise<CreateNodeResponse> => {
  await requireRequestPermission(request, "users.manage");
  const now = new Date();
  const token = createJoinToken(request.body.tokenTtlMinutes);
  const nodeName = request.body.name?.trim() || "Remote Node";
  const node: ManagedNode = {
    id: randomUUID(),
    name: nodeName,
    type: "remote",
    status: "unknown",
    isInternal: false,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    compatibility: "unknown",
    capabilities: [],
    joinTokenHash: hashNodeSecret(token.joinToken),
    joinTokenExpiresAt: token.expiresAt
  };
  await updateNodes((nodes) => {
    nodes.push(node);
  });
  return {
    node: publicNode(node),
    joinToken: token.joinToken,
    expiresAt: token.expiresAt,
    install: nodeInstallInstructions({ panelUrl: request.body.panelUrl, joinToken: token.joinToken, dataMount: request.body.dataMount, nodeName })
  };
});

app.post<{ Params: { nodeId: string }; Body: { tokenTtlMinutes?: number; dataMount?: string; panelUrl?: string } }>("/api/nodes/:nodeId/rotate-token", destructiveRateLimit, async (request): Promise<CreateNodeResponse> => {
  await requireRequestPermission(request, "users.manage");
  const token = createJoinToken(request.body.tokenTtlMinutes);
  let updatedNode: ManagedNode | undefined;
  await updateNodes((nodes) => {
    const node = nodes.find((candidate) => candidate.id === request.params.nodeId);
    if (!node) nodeNotFound(request.params.nodeId);
    if (node.isInternal) {
      throw new Error("Internal node tokens cannot be rotated");
    }
    node.joinTokenHash = hashNodeSecret(token.joinToken);
    node.joinTokenExpiresAt = token.expiresAt;
    node.updatedAt = new Date().toISOString();
    updatedNode = node;
  });
  return {
    node: publicNode(updatedNode!),
    joinToken: token.joinToken,
    expiresAt: token.expiresAt,
    install: nodeInstallInstructions({ panelUrl: request.body.panelUrl, joinToken: token.joinToken, dataMount: request.body.dataMount, nodeName: updatedNode!.name })
  };
});

app.get<{ Params: { nodeId: string }; Querystring: { panelUrl?: string; dataMount?: string } }>("/api/nodes/:nodeId/install", async (request) => {
  await requireRequestPermission(request, "servers.view");
  const node = (await queuedReadNodes()).find((candidate) => candidate.id === request.params.nodeId);
  if (!node) nodeNotFound(request.params.nodeId);
  return {
    node: publicNode(node),
    install: nodeInstallInstructions({ panelUrl: request.query.panelUrl, dataMount: request.query.dataMount, nodeName: node.name })
  };
});

app.delete<{ Params: { nodeId: string } }>("/api/nodes/:nodeId", destructiveRateLimit, async (request) => {
  await requireRequestPermission(request, "users.manage");
  const servers = await queuedReadServers();
  if (servers.some((server) => server.nodeId === request.params.nodeId)) {
    throw new Error("Cannot delete a node while servers are assigned to it");
  }
  let deleted = false;
  await updateNodes((nodes) => {
    const index = nodes.findIndex((candidate) => candidate.id === request.params.nodeId);
    if (index === -1) nodeNotFound(request.params.nodeId);
    if (nodes[index].isInternal) {
      throw new Error("Internal node cannot be deleted");
    }
    nodes.splice(index, 1);
    deleted = true;
  });
  panelNodeConnections.disconnect(request.params.nodeId);
  return { ok: deleted };
});

app.get<{ Params: { nodeId: string } }>("/api/nodes/:nodeId", async (request, reply) => {
  await requireRequestPermission(request, "servers.view");
  const node = (await queuedReadNodes()).find((candidate) => candidate.id === request.params.nodeId);
  if (!node) {
    return reply.code(404).send({ error: "Node not found", code: "node_not_found" });
  }
  return publicNode(node);
});

app.get("/api/nodes/connect", { websocket: true }, async (socket) => {
  const ws = socket as any;
  const reject = (message: string) => {
    const response: PanelWelcome = { type: "welcome", nodeId: "", protocolVersion: nodeProtocolVersion, accepted: false, compatibility: "incompatible", error: message };
    ws.send(JSON.stringify(response));
    ws.close();
  };

  ws.once("message", async (raw: Buffer) => {
    let hello: NodeHello;
    try {
      hello = JSON.parse(raw.toString()) as NodeHello;
    } catch {
      reject("Invalid node hello");
      return;
    }
    if (hello.type !== "hello") {
      reject("Node hello is required");
      return;
    }
    const now = new Date().toISOString();
    let acceptedNode: ManagedNode | undefined;
    let issuedSecret: string | undefined;
    await updateNodes((nodes) => {
      if (hello.nodeId && hello.nodeSecret) {
        const node = nodes.find((candidate) => candidate.id === hello.nodeId);
        if (!node || !verifyNodeSecret(hello.nodeSecret, node.secretHash)) return;
        acceptedNode = {
          ...node,
          name: hello.nodeName?.trim() || node.name,
          status: "online",
          updatedAt: now,
          lastSeenAt: now,
          connectedAt: now,
          agentVersion: hello.agentVersion,
          protocolVersion: hello.protocolVersion,
          capabilities: hello.capabilities ?? [],
          dockerStatus: hello.dockerStatus,
          dataPathStatus: hello.dataPathStatus,
          compatibility: protocolCompatible(hello.protocolVersion) ? "compatible" : "incompatible"
        };
        nodes[nodes.indexOf(node)] = acceptedNode;
        return;
      }

      if (hello.joinToken) {
        const tokenHash = hashNodeSecret(hello.joinToken);
        const node = nodes.find((candidate) => candidate.joinTokenHash === tokenHash && candidate.joinTokenExpiresAt && new Date(candidate.joinTokenExpiresAt).getTime() > Date.now());
        if (!node) return;
        issuedSecret = newNodeSecret();
        acceptedNode = {
          ...node,
          name: hello.nodeName?.trim() || node.name,
          type: "remote",
          status: "online",
          isInternal: false,
          updatedAt: now,
          lastSeenAt: now,
          connectedAt: now,
          agentVersion: hello.agentVersion,
          protocolVersion: hello.protocolVersion,
          capabilities: hello.capabilities ?? [],
          dockerStatus: hello.dockerStatus,
          dataPathStatus: hello.dataPathStatus,
          compatibility: protocolCompatible(hello.protocolVersion) ? "compatible" : "incompatible",
          secretHash: hashNodeSecret(issuedSecret),
          joinTokenHash: undefined,
          joinTokenExpiresAt: undefined
        };
        nodes[nodes.indexOf(node)] = acceptedNode;
      }
    });

    if (!acceptedNode) {
      reject("Node authentication failed");
      return;
    }

    const welcome: PanelWelcome = {
      type: "welcome",
      nodeId: acceptedNode.id,
      nodeSecret: issuedSecret,
      protocolVersion: nodeProtocolVersion,
      accepted: true,
      compatibility: acceptedNode.compatibility === "compatible" ? "compatible" : "incompatible"
    };
    ws.send(JSON.stringify(welcome));
    panelNodeConnections.connect(acceptedNode, ws);
    ws.on("close", () => {
      void updateNodes((nodes) => {
        const node = nodes.find((candidate) => candidate.id === acceptedNode!.id);
        if (node) {
          node.status = "offline";
          node.updatedAt = new Date().toISOString();
        }
      }).catch(() => {});
    });
  });
});

app.get("/api/context", async (request) => {
  await requireRequestPermission(request, "servers.view");
  const servers = await queuedReadServers();
  const nodes = await queuedReadNodes();
  const publicServers = await Promise.all(servers.map((server) => runtimeForServer(server).publicServer(server, nodes)));
  return {
    nodes: nodes.map((node) => ({
      ...publicNode(node),
      servers: publicServers.filter((server) => server.nodeId === node.id)
    }))
  };
});

app.put<{ Body: { modrinthApiKey?: string } }>("/api/settings/modrinth", async (request) => {
  await requireRequestPermission(request, "integrations.manage");
  const key = request.body.modrinthApiKey?.trim();
  if (!key) {
    throw new Error("Modrinth API key is required");
  }
  await updateSettings((settings) => {
    settings.modrinthApiKey = key;
  });
  logInfo({ action: "configure_modrinth", status: "succeeded" }, "Modrinth API configuration updated");
  return { ok: true, modrinthApiConfigured: true };
});

app.get("/api/fabric/versions", async (request) => {
  if (request.headers["x-serversentinel-demo-mode"] !== "true") {
    await requireRequestPermission(request, "servers.create");
  }
  const [game, loader, installer] = await Promise.all([
    fabricMeta<Array<{ version: string; stable: boolean }>>("/v2/versions/game"),
    fabricMeta<Array<{ version: string; stable: boolean }>>("/v2/versions/loader"),
    fabricMeta<Array<{ version: string; stable: boolean }>>("/v2/versions/installer")
  ]);
  return {
    game: game.filter((version) => version.stable).slice(0, 20),
    loader: loader.filter((version) => version.stable).slice(0, 20),
    installer: installer.filter((version) => version.stable).slice(0, 20)
  };
});

app.post<{
  Body: CreateServerInput;
}>("/api/servers", provisionRateLimit, async (request) => {
  await requireRequestPermission(request, "servers.create");
  const nodeId = request.body.nodeId?.trim() || (config.runtimeMode === "all-in-one" ? localNodeId : "");
  if (!nodeId) throw new Error("nodeId is required when ServerSentinel runs in panel mode");
  const server = await runtimeForNodeId(nodeId).createServer({ ...request.body, nodeId });
  logInfo(serverLogFields(server), "Managed server created");
  return runtimeForServer(server).publicServer(server);
});

app.post<{ Body: CreateServerInput }>("/api/servers/provision", provisionRateLimit, async (request) => {
  await requireRequestPermission(request, "servers.create");
  if (!request.body.nodeId && config.runtimeMode === "panel") {
    throw new Error("nodeId is required when ServerSentinel runs in panel mode");
  }
  const job = startProvisionJob(request.body);
  return job;
});

app.get<{ Params: { id: string } }>("/api/provision/:id", async (request, reply) => {
  await requireRequestPermission(request, "servers.create");
  const job = provisionJobs.get(validateProvisionJobId(request.params.id));
  if (!job) {
    return reply.code(404).send({ error: "Provisioning job not found" });
  }
  return job;
});

app.put<{
  Params: { id: string };
  Body: {
    displayName?: string;
    minecraftVersion?: string;
    loaderVersion?: string;
    installerVersion?: string;
    serverJar?: string;
    dockerContainer?: string;
    dockerImage?: string;
    dockerPorts?: string;
    javaArgs?: string;
    serverPort?: string;
  };
}>("/api/servers/:id", destructiveRateLimit, async (request) => {
  await requireRequestPermission(request, "servers.editSettings");
  const server = await getServer(request.params.id);
  const updatedServer = await runtimeForServer(server).updateServer(server.id, request.body);
  return runtimeForServer(updatedServer).publicServer(updatedServer);
});

app.delete<{
  Params: { id: string };
  Body: {
    confirmName?: string;
    deleteFiles?: boolean;
  };
}>("/api/servers/:id", destructiveRateLimit, async (request) => {
  await requireRequestPermission(request, "servers.delete");
  const server = await getServer(request.params.id);
  return runtimeForServer(server).deleteServer(server, request.body);
});

app.get<{ Params: { id: string } }>("/api/servers/:id/status", async (request) => {
  await requireRequestPermission(request, "servers.view");
  const server = await getServer(request.params.id);
  return runtimeForServer(server).serverStatus(server);
});

app.post<{ Params: { id: string } }>("/api/servers/:id/start", runtimeActionRateLimit, async (request) => {
  await requireRequestPermission(request, "servers.control");
  const server = await getServer(request.params.id);
  return runtimeForServer(server).lifecycle(server, "start");
});

app.post<{ Params: { id: string } }>("/api/servers/:id/stop", runtimeActionRateLimit, async (request) => {
  await requireRequestPermission(request, "servers.control");
  const server = await getServer(request.params.id);
  return runtimeForServer(server).lifecycle(server, "stop");
});

app.post<{ Params: { id: string } }>("/api/servers/:id/restart", runtimeActionRateLimit, async (request) => {
  await requireRequestPermission(request, "servers.control");
  const server = await getServer(request.params.id);
  return runtimeForServer(server).lifecycle(server, "restart");
});

app.post<{ Params: { id: string }; Body: { command?: string } }>("/api/servers/:id/command", commandRateLimit, async (request) => {
  await requireRequestPermission(request, "console.command");
  const server = await getServer(request.params.id);
  return runtimeForServer(server).sendConsoleCommand(server, request.body.command);
});

app.get<{ Params: { id: string } }>("/api/servers/:id/schedules", async (request) => {
  await requireRequestPermission(request, "schedules.view");
  const server = await getServer(request.params.id);
  return { schedules: server.schedules ?? [] };
});

app.post<{
  Params: { id: string };
  Body: { name?: string; cron?: string; commands?: unknown; onlyWhenNoPlayers?: boolean; enabled?: boolean };
}>("/api/servers/:id/schedules", destructiveRateLimit, async (request) => {
  await requireRequestPermission(request, "schedules.manage");
  let createdSchedule: ScheduledExecution | null = null;
  let serverLog: Record<string, unknown> = {};
  await updateServers((servers) => {
    const index = servers.findIndex((candidate) => candidate.id === request.params.id);
    if (index === -1) {
      throw new Error("Server not found");
    }
    const schedule = scheduleFromBody(request.body);
    servers[index].schedules = [...(servers[index].schedules ?? []), schedule];
    servers[index].updatedAt = new Date().toISOString();
    createdSchedule = schedule;
    serverLog = serverLogFields(servers[index]);
  });
  logInfo({ ...serverLog, scheduleId: createdSchedule!.id, enabled: createdSchedule!.enabled, action: "create_schedule" }, "Schedule created");
  return createdSchedule!;
});

app.put<{
  Params: { id: string; scheduleId: string };
  Body: { name?: string; cron?: string; commands?: unknown; onlyWhenNoPlayers?: boolean; enabled?: boolean };
}>("/api/servers/:id/schedules/:scheduleId", destructiveRateLimit, async (request) => {
  await requireRequestPermission(request, "schedules.manage");
  let updatedSchedule: ScheduledExecution | null = null;
  let serverLog: Record<string, unknown> = {};
  await updateServers((servers) => {
    const serverIndex = servers.findIndex((candidate) => candidate.id === request.params.id);
    if (serverIndex === -1) {
      throw new Error("Server not found");
    }
    const scheduleId = validateScheduleId(request.params.scheduleId);
    const schedules = servers[serverIndex].schedules ?? [];
    const scheduleIndex = schedules.findIndex((candidate) => candidate.id === scheduleId);
    if (scheduleIndex === -1) {
      throw new Error("Schedule not found");
    }
    schedules[scheduleIndex] = scheduleFromBody(request.body, schedules[scheduleIndex]);
    servers[serverIndex].schedules = schedules;
    servers[serverIndex].updatedAt = new Date().toISOString();
    updatedSchedule = schedules[scheduleIndex];
    serverLog = serverLogFields(servers[serverIndex]);
  });
  logInfo({ ...serverLog, scheduleId: updatedSchedule!.id, enabled: updatedSchedule!.enabled, action: "update_schedule" }, "Schedule updated");
  return updatedSchedule!;
});

app.delete<{ Params: { id: string; scheduleId: string } }>("/api/servers/:id/schedules/:scheduleId", destructiveRateLimit, async (request) => {
  await requireRequestPermission(request, "schedules.manage");
  let serverLog: Record<string, unknown> = {};
  const scheduleId = validateScheduleId(request.params.scheduleId);
  await updateServers((servers) => {
    const serverIndex = servers.findIndex((candidate) => candidate.id === request.params.id);
    if (serverIndex === -1) {
      throw new Error("Server not found");
    }
    servers[serverIndex].schedules = (servers[serverIndex].schedules ?? []).filter((schedule) => schedule.id !== scheduleId);
    servers[serverIndex].updatedAt = new Date().toISOString();
    serverLog = serverLogFields(servers[serverIndex]);
  });
  logInfo({ ...serverLog, scheduleId, action: "delete_schedule" }, "Schedule deleted");
  return { ok: true };
});

app.get("/ws/console", { websocket: true }, async (socket, request) => {
  const client = socket as unknown as Client;
  const url = new URL(request.url, "http://localhost");
  const serverId = url.searchParams.get("serverId") ?? undefined;
  try {
    await requireRequestPermission(request, "console.view");
    const server = await getServer(serverId);
    logDebug({ ...serverLogFields(server), source: "console_websocket" }, "Console stream connected");
    await runtimeForServer(server).streamConsole(server, client, (cleanup) => socket.on("close", cleanup));
  } catch (error) {
    logWarn({ serverId, source: "console_websocket", ...errorLogFields(error) }, "Console stream unavailable");
    client.send(JSON.stringify({ type: "unavailable", message: (error as Error).message }));
  }
});

app.get<{ Params: { id: string } }>("/api/servers/:id/logs", async (request) => {
  await requireRequestPermission(request, "console.view");
  const server = await getServer(request.params.id);
  return runtimeForServer(server).serverLogs(server);
});

app.get<{ Params: { id: string } }>("/api/servers/:id/stats", async (request) => {
  await requireRequestPermission(request, "servers.view");
  const server = await getServer(request.params.id);
  return runtimeForServer(server).serverStats(server);
});

app.get<{ Params: { id: string } }>("/api/servers/:id/events", async (request) => {
  await requireRequestPermission(request, "servers.view");
  const server = await getServer(request.params.id);
  return runtimeForServer(server).serverOverview(server);
});

app.get<{ Params: { id: string }; Querystring: { path?: string } }>("/api/servers/:id/files", async (request) => {
  const server = await getServer(request.params.id);
  const runtime = runtimeForServer(server);
  const target = await runtime.resolveExistingPath(server, request.query.path ?? ".");
  await requireFilePathPermission(request, server, target, "files.view");
  return runtime.listFiles(server, target);
});

app.get<{ Params: { id: string }; Querystring: { path?: string } }>("/api/servers/:id/file/preview", async (request) => {
  const server = await getServer(request.params.id);
  const runtime = runtimeForServer(server);
  const target = await runtime.resolveExistingPath(server, request.query.path ?? "");
  await requireFilePathPermission(request, server, target, "files.view");
  return runtime.previewFile(server, target);
});

app.get<{ Params: { id: string }; Querystring: { path?: string } }>("/api/servers/:id/file/download", async (request, reply) => {
  const server = await getServer(request.params.id);
  const runtime = runtimeForServer(server);
  const target = await runtime.resolveExistingPath(server, request.query.path ?? "");
  await requireFilePathPermission(request, server, target, "files.download");
  const download = await runtime.downloadFile(server, target);
  return reply
    .header("Content-Type", "application/octet-stream")
    .header("Content-Length", download.size)
    .header("Content-Disposition", `attachment; filename="${encodeURIComponent(download.filename)}"`)
    .send(download.stream);
});

app.get<{ Params: { id: string }; Querystring: { path?: string } }>("/api/servers/:id/file", async (request) => {
  const server = await getServer(request.params.id);
  const runtime = runtimeForServer(server);
  const target = await runtime.resolveExistingPath(server, request.query.path ?? "");
  await requireFilePathPermission(request, server, target, "files.view");
  return runtime.readFile(server, target);
});

app.put<{ Params: { id: string }; Body: { path?: string; content?: string } }>("/api/servers/:id/file", destructiveRateLimit, async (request) => {
  const server = await getServer(request.params.id);
  const runtime = runtimeForServer(server);
  const target = await runtime.resolveExistingPath(server, request.body.path ?? "");
  await requireFilePathPermission(request, server, target, runtime.isServerSettingsFile(server, target) ? "servers.editSettings" : "files.edit");
  return runtime.writeFile(server, target, request.body.content);
});

app.post<{ Params: { id: string }; Body: { path?: string; name?: string } }>("/api/servers/:id/folder", destructiveRateLimit, async (request) => {
  const server = await getServer(request.params.id);
  const runtime = runtimeForServer(server);
  const parent = await runtime.resolveExistingPath(server, request.body.path ?? ".");
  await requireFilePathPermission(request, server, parent, "files.upload");
  return runtime.createFolder(server, parent, request.body.name);
});

app.post<{ Params: { id: string }; Body: { path?: string; filename?: string; contentBase64?: string } }>("/api/servers/:id/files/upload", destructiveRateLimit, async (request) => {
  const server = await getServer(request.params.id);
  const runtime = runtimeForServer(server);
  const parent = await runtime.resolveExistingPath(server, request.body.path ?? ".");
  if (server.nodeId === localNodeId) {
    const parentStat = await stat(parent);
    if (!parentStat.isDirectory()) {
      throw new Error("Upload path is not a directory");
    }
  }
  const filename = safeFileManagerName(request.body.filename);
  const uploadPermission: Permission = runtime.isModsPath(server, join(parent, filename)) && filename.endsWith(".jar") ? "mods.upload" : "files.upload";
  await requireFilePathPermission(request, server, parent, uploadPermission);
  return runtime.uploadFile(server, parent, filename, request.body.contentBase64);
});

app.patch<{ Params: { id: string }; Body: { path?: string; name?: string } }>("/api/servers/:id/file", destructiveRateLimit, async (request) => {
  const server = await getServer(request.params.id);
  const runtime = runtimeForServer(server);
  const source = await runtime.resolveExistingPath(server, request.body.path ?? "");
  if (resolve(source) === resolve(server.serverDir)) {
    throw new Error("Refusing to rename the server root directory");
  }
  const targetName = safeFileManagerName(request.body.name);
  const target = await runtime.resolveWritableResolvedPath(server, join(dirname(source), targetName));
  await requireFilePathPermission(request, server, source, runtime.fileRenamePermission(server, source, target));
  return runtime.renameFile(server, source, targetName);
});

app.post<{ Params: { id: string }; Body: { path?: string; name?: string } }>("/api/servers/:id/file/duplicate", destructiveRateLimit, async (request) => {
  const server = await getServer(request.params.id);
  const runtime = runtimeForServer(server);
  const source = await runtime.resolveExistingPath(server, request.body.path ?? "");
  await requireFilePathPermission(request, server, source, runtime.isModsPath(server, source) ? "mods.upload" : "files.upload");
  return runtime.duplicateFile(server, source, request.body.name);
});

app.delete<{ Params: { id: string }; Querystring: { path?: string; recursive?: string } }>("/api/servers/:id/file", destructiveRateLimit, async (request) => {
  const server = await getServer(request.params.id);
  const runtime = runtimeForServer(server);
  const target = await runtime.resolveExistingPath(server, request.query.path ?? "");
  await requireFilePathPermission(request, server, target, runtime.isModsPath(server, target) ? "mods.remove" : "files.delete");
  return runtime.deleteFile(server, target, request.query.recursive);
});


async function localListFiles(server: ManagedServer, target: string) {
  const targetStat = await stat(target);
  if (!targetStat.isDirectory()) {
    throw new Error("Path is not a directory");
  }

  const entries = await readdir(target, { withFileTypes: true });
  return {
    path: toPublicPath(server, target),
    entries: await Promise.all(
      entries
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
        .map(async (entry) => {
          const absolutePath = join(target, entry.name);
          const entryStat = await lstat(absolutePath);
          return {
            name: entry.name,
            path: toPublicPath(server, absolutePath),
            type: entry.isDirectory() ? "directory" : "file",
            size: entryStat.size,
            modifiedAt: entryStat.mtime.toISOString(),
            permissions: `0${(entryStat.mode & 0o777).toString(8)}`,
            status: fileManagerStatus(entryStat, entry.name)
          };
        })
    )
  };
}

async function localPreviewFile(server: ManagedServer, target: string) {
  const targetStat = await stat(target);
  const publicPath = toPublicPath(server, target);
  if (!targetStat.isFile()) {
    return { path: publicPath, preview: "unsupported", message: "Preview unavailable" };
  }
  if (!isTextLikeServerFile(basename(target))) {
    return { path: publicPath, preview: "unsupported", message: "Preview unavailable" };
  }
  if (targetStat.size > filePreviewSizeLimit) {
    return { path: publicPath, preview: "too_large", message: "File too large to preview" };
  }
  const buffer = await readFile(target);
  if (buffer.includes(0)) {
    return { path: publicPath, preview: "binary", message: "Preview unavailable" };
  }
  return {
    path: publicPath,
    preview: "text",
    content: buffer.toString("utf8"),
    modifiedAt: targetStat.mtime.toISOString()
  };
}

async function localDownloadFile(_server: ManagedServer, target: string) {
  const targetStat = await stat(target);
  if (!targetStat.isFile()) {
    throw new Error("Only files can be downloaded");
  }
  return {
    filename: basename(target),
    size: targetStat.size,
    stream: createReadStream(target)
  };
}

async function localReadEditableFile(server: ManagedServer, target: string) {
  const targetStat = await stat(target);
  if (!targetStat.isFile()) {
    throw new Error("Path is not a file");
  }
  if (targetStat.size > editorFileSizeLimit) {
    logWarn({ ...serverLogFields(server), path: toPublicPath(server, target), size: targetStat.size, reason: "editor_size_limit" }, "File edit rejected");
    throw new Error("File is larger than the 2 MiB editor limit");
  }
  const buffer = await readFile(target);
  if (buffer.includes(0)) {
    logWarn({ ...serverLogFields(server), path: toPublicPath(server, target), reason: "binary_file" }, "File edit rejected");
    throw new Error("Binary files cannot be edited in the browser editor");
  }
  return {
    path: toPublicPath(server, target),
    content: buffer.toString("utf8"),
    modifiedAt: targetStat.mtime.toISOString()
  };
}

async function localWriteEditableFile(server: ManagedServer, target: string, content: unknown) {
  if (typeof content !== "string") {
    throw new Error("Content is required");
  }
  if (Buffer.byteLength(content, "utf8") > editorFileSizeLimit) {
    throw new Error("File content is larger than the 2 MiB editor limit");
  }
  if (content.includes("\0")) {
    throw new Error("Binary files cannot be edited in the browser editor");
  }
  const targetStat = await stat(target);
  if (!targetStat.isFile()) {
    throw new Error("Path is not a file");
  }
  await writeFile(target, content, "utf8");
  logInfo({ ...serverLogFields(server), path: toPublicPath(server, target), action: "write_file" }, "Server file written");
  return { ok: true, path: toPublicPath(server, target) };
}

async function localCreateFolder(server: ManagedServer, parent: string, name: unknown) {
  const parentStat = await stat(parent);
  if (!parentStat.isDirectory()) {
    throw new Error("Parent path is not a directory");
  }
  const folderName = safeFileManagerName(name as string | undefined);
  const target = await ensureWritableResolvedInsideServer(server, join(parent, folderName));
  await mkdir(target, { recursive: false });
  logInfo({ ...serverLogFields(server), path: toPublicPath(server, target), action: "create_folder" }, "Server folder created");
  return { ok: true, path: toPublicPath(server, target) };
}

async function localUploadFile(server: ManagedServer, parent: string, filenameInput: unknown, contentBase64: unknown) {
  const parentStat = await stat(parent);
  if (!parentStat.isDirectory()) {
    throw new Error("Upload path is not a directory");
  }
  const filename = safeFileManagerName(filenameInput as string | undefined);
  if (typeof contentBase64 !== "string") {
    throw new Error("File content is required");
  }
  const content = Buffer.from(contentBase64, "base64");
  if (content.length > fileUploadSizeLimit) {
    throw new Error(`Upload is larger than ${Math.floor(fileUploadSizeLimit / 1024 / 1024)} MiB`);
  }
  const target = await ensureWritableResolvedInsideServer(server, join(parent, filename));
  if (existsSync(target)) {
    throw new Error("A file or folder with that name already exists");
  }
  await writeFile(target, content);
  logInfo({ ...serverLogFields(server), path: toPublicPath(server, target), size: content.length, action: "upload_file" }, "Server file uploaded");
  return { ok: true, path: toPublicPath(server, target), size: content.length };
}

async function localRenameFile(server: ManagedServer, source: string, name: unknown) {
  if (resolve(source) === resolve(server.serverDir)) {
    throw new Error("Refusing to rename the server root directory");
  }
  const targetName = safeFileManagerName(name as string | undefined);
  const target = await ensureWritableResolvedInsideServer(server, join(dirname(source), targetName));
  if (existsSync(target)) {
    throw new Error("A file or folder with that name already exists");
  }
  await rename(source, target);
  logInfo({ ...serverLogFields(server), fromPath: toPublicPath(server, source), path: toPublicPath(server, target), action: "rename_file" }, "Server file renamed");
  return { ok: true, path: toPublicPath(server, target) };
}

async function localDuplicateFile(server: ManagedServer, source: string, name: unknown) {
  const sourceStat = await stat(source);
  if (!sourceStat.isFile()) {
    throw new Error("Only files can be duplicated from the browser file manager");
  }
  const targetName = safeFileManagerName(name as string | undefined);
  const target = await ensureWritableResolvedInsideServer(server, join(dirname(source), targetName));
  if (existsSync(target)) {
    throw new Error("A file or folder with that name already exists");
  }
  await copyFile(source, target);
  logInfo({ ...serverLogFields(server), fromPath: toPublicPath(server, source), path: toPublicPath(server, target), action: "duplicate_file" }, "Server file duplicated");
  return { ok: true, path: toPublicPath(server, target) };
}

async function localDeleteFile(server: ManagedServer, target: string, recursive: unknown) {
  if (recursive !== undefined && recursive !== "true" && recursive !== "false") {
    throw new Error("recursive must be true or false");
  }
  if (resolve(target) === resolve(server.serverDir)) {
    throw new Error("Refusing to delete the server root directory");
  }
  const publicPath = toPublicPath(server, target);
  const targetStat = await stat(target);
  if (targetStat.isDirectory()) {
    if (recursive === "true") {
      await rm(target, { recursive: true, force: false });
    } else {
      try {
        await rmdir(target);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOTEMPTY" || code === "EEXIST") {
          throw new Error("Directory is not empty. Recursive deletion requires recursive=true and explicit confirmation.");
        }
        throw error;
      }
    }
  } else if (targetStat.isFile()) {
    await rm(target, { force: false });
  } else {
    throw new Error("Only files and directories can be deleted from the browser file manager");
  }
  if (publicPath.startsWith("/mods/") && (publicPath.endsWith(".jar") || publicPath.endsWith(".jar.disabled"))) {
    await deleteModIcon(server, basename(publicPath));
  }
  logInfo({ ...serverLogFields(server), path: publicPath, recursive: recursive === "true", action: "delete_file" }, "Server file deleted");
  return { ok: true, path: publicPath };
}


async function readModPreferences(server: ManagedServer): Promise<Record<string, ModPreference>> {
  let path: string;
  try {
    path = await validateExistingInsideServer(server, "mods/.serversentinel-mods.json");
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    return {};
  }
  if (!existsSync(path)) return {};
  return normalizeModPreferences(JSON.parse(await readFile(path, "utf8")) as unknown);
}

async function writeModPreferences(server: ManagedServer, data: Record<string, ModPreference>) {
  const path = await ensureWritableInsideServer(server, "mods/.serversentinel-mods.json");
  await writeJsonFile(path, normalizeModPreferences(data));
}

function normalizeModPreferences(value: unknown): Record<string, ModPreference> {
  const raw = asObject(value, "mod preferences");
  const normalized: Record<string, ModPreference> = {};
  for (const [filename, preference] of Object.entries(raw)) {
    const safeFilename = safeInstalledModFilename(filename);
    const item = asObject(preference, `mod preferences.${filename}`);
    normalized[safeFilename] = {
      channel: normalizeReleaseChannel(optionalString(item.channel, `mod preferences.${filename}.channel`)),
      modrinth: item.modrinth === undefined ? undefined : normalizeInstalledModMetadata(item.modrinth)
    };
  }
  return normalized;
}

function normalizeInstalledModMetadata(value: unknown): InstalledModMetadata {
  const metadata = asObject(value, "installed mod metadata");
  return {
    projectId: requiredString(metadata.projectId, "modrinth.projectId"),
    versionId: requiredString(metadata.versionId, "modrinth.versionId"),
    filename: safeInstalledModFilename(requiredString(metadata.filename, "modrinth.filename")),
    versionNumber: requiredString(metadata.versionNumber, "modrinth.versionNumber"),
    versionType: metadata.versionType === undefined ? undefined : normalizeReleaseChannel(optionalString(metadata.versionType, "modrinth.versionType")),
    gameVersions: asArray(metadata.gameVersions, "modrinth.gameVersions").map((version) => requiredString(version, "modrinth.gameVersions[]")),
    loaders: asArray(metadata.loaders, "modrinth.loaders").map((loader) => requiredString(loader, "modrinth.loaders[]")),
    hashes: metadata.hashes === undefined ? undefined : normalizeStringRecord(metadata.hashes, "modrinth.hashes"),
    installedAt: requiredString(metadata.installedAt, "modrinth.installedAt"),
    installedWithForceIncompatible: requireStrictBoolean(metadata.installedWithForceIncompatible, "modrinth.installedWithForceIncompatible"),
    incompatibilityReason: optionalString(metadata.incompatibilityReason, "modrinth.incompatibilityReason"),
    clientSide: optionalString(metadata.clientSide, "modrinth.clientSide"),
    serverSide: optionalString(metadata.serverSide, "modrinth.serverSide"),
    forceIncompatible: metadata.forceIncompatible === undefined ? undefined : requireStrictBoolean(metadata.forceIncompatible, "modrinth.forceIncompatible")
  };
}

function normalizeStringRecord(value: unknown, label: string) {
  const raw = asObject(value, label);
  const normalized: Record<string, string> = {};
  for (const [key, item] of Object.entries(raw)) {
    normalized[key] = requiredString(item, `${label}.${key}`);
  }
  return normalized;
}

function installedModCompatibility(server: ManagedServer, metadata?: InstalledModMetadata): ModCompatibility {
  if (!metadata) {
    return { status: "unknown", compatible: false, reason: "Server-side support unknown" };
  }
  const serverSide = metadata.serverSide;
  const clientSide = metadata.clientSide;

  if (serverSide === "unsupported") {
    return {
      status: "incompatible",
      compatible: false,
      reason: metadata.installedWithForceIncompatible
        ? (metadata.incompatibilityReason ? `This mod was force installed: ${metadata.incompatibilityReason}` : "Client-only mod; server-side support is unsupported")
        : "Client-only mod; server-side support is unsupported",
      serverSide,
      clientSide
    };
  }
  if (serverSide === "unknown") {
    return {
      status: "unknown",
      compatible: false,
      reason: metadata.installedWithForceIncompatible
        ? (metadata.incompatibilityReason ? `This mod was force installed: ${metadata.incompatibilityReason}` : "Server-side support could not be verified")
        : "Server-side support could not be verified",
      serverSide,
      clientSide
    };
  }
  if (!metadata.loaders.includes("fabric")) {
    return { status: "no_fabric", compatible: false, reason: "This mod does not advertise Fabric support.", serverSide, clientSide };
  }
  if (server.minecraftVersion && !metadata.gameVersions.includes(server.minecraftVersion)) {
    return {
      status: "no_minecraft_version",
      compatible: false,
      reason: `This mod was installed for Minecraft ${metadata.gameVersions.join(", ") || "unknown"}, but this server is ${server.minecraftVersion}.`,
      serverSide,
      clientSide
    };
  }
  if (metadata.installedWithForceIncompatible) {
    return {
      status: "incompatible",
      compatible: false,
      reason: metadata.incompatibilityReason
        ? `This mod was force installed: ${metadata.incompatibilityReason}`
        : "This mod was force installed even though ServerSentinel could not confirm compatibility.",
      serverSide,
      clientSide
    };
  }
  return { status: "compatible", compatible: true, reason: "Compatibility verified for this server.", serverSide, clientSide };
}

async function lookupModrinthUpdate(server: ManagedServer, modPath: string, preferredChannel: ReleaseChannel) {
  if (!server.minecraftVersion) return null;
  const hash = createHash("sha1").update(await readFile(modPath)).digest("hex");
  const currentRes = await modrinthFetch(`https://api.modrinth.com/v2/version_file/${hash}?algorithm=sha1`);
  const current = await currentRes.json() as { project_id?: string; version_number?: string; version_type?: string };
  if (!current.project_id) return null;
  const versionsUrl = new URL(`https://api.modrinth.com/v2/project/${encodeURIComponent(current.project_id)}/version`);
  versionsUrl.searchParams.set("loaders", JSON.stringify(["fabric"]));
  versionsUrl.searchParams.set("game_versions", JSON.stringify([server.minecraftVersion]));
  const versionsRes = await modrinthFetch(versionsUrl.toString());
  const versions = await versionsRes.json() as ModrinthVersion[];
  const target = versions.find((version) => allowedForChannel(version, preferredChannel));
  return {
    projectId: current.project_id,
    currentVersion: current.version_number,
    currentChannel: versionChannel(current.version_type),
    latestVersion: target?.version_number,
    latestChannel: target ? versionChannel(target.version_type) : undefined,
    upToDate: Boolean(target && current.version_number === target.version_number)
  };
}

async function localListMods(server: ManagedServer) {
  await mkdir(ensureInsideServer(server, "mods"), { recursive: true });
  const modsDir = await validateExistingInsideServer(server, "mods");
  const entries = await readdir(modsDir, { withFileTypes: true });
  const prefs = await readModPreferences(server);
  let prefsModified = false;

  const mods = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && (entry.name.endsWith(".jar") || entry.name.endsWith(".jar.disabled")))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(async (entry) => {
        const modPath = await validateExistingResolvedInsideServer(server, join(modsDir, entry.name));
        await ensureModrinthIconForFile(server, entry.name, modPath);
        const modStat = await stat(modPath);
        const preferredChannel = normalizeReleaseChannel(prefs[entry.name]?.channel);
        let metadata = prefs[entry.name]?.modrinth;

        if (!metadata) {
          try {
            const hash = createHash("sha1").update(await readFile(modPath)).digest("hex");
            const currentRes = await modrinthFetch(`https://api.modrinth.com/v2/version_file/${hash}?algorithm=sha1`);
            if (currentRes.ok) {
              const current = await currentRes.json() as any;
              if (current && current.project_id) {
                const project = await fetchProject(current.project_id);
                metadata = {
                  projectId: current.project_id,
                  versionId: current.id,
                  filename: entry.name,
                  versionNumber: current.version_number,
                  versionType: normalizeReleaseChannel(current.version_type),
                  gameVersions: current.game_versions,
                  loaders: current.loaders,
                  hashes: current.files?.find((f: any) => f.hashes?.sha1 === hash || f.primary)?.hashes || { sha1: hash },
                  installedAt: new Date().toISOString(),
                  installedWithForceIncompatible: false,
                  clientSide: project.client_side,
                  serverSide: project.server_side
                };
                prefs[entry.name] = {
                  ...(prefs[entry.name] || {}),
                  channel: preferredChannel,
                  modrinth: metadata
                };
                prefsModified = true;
              }
            }
          } catch {
            // Ignore backfill failures
          }
        }

        let versionInfo: any = null;
        try { versionInfo = await lookupModrinthUpdate(server, modPath, preferredChannel); } catch { versionInfo = null; }
        return {
          filename: entry.name,
          displayName: entry.name.replace(/\.jar\.disabled$/, ".jar"),
          enabled: entry.name.endsWith(".jar"),
          size: modStat.size,
          modifiedAt: modStat.mtime.toISOString(),
          iconUrl: await modIconUrl(server, entry.name),
          preferredChannel,
          compatibility: installedModCompatibility(server, metadata),
          modrinth: metadata,
          versionInfo
        };
      })
  );

  if (prefsModified) {
    await writeModPreferences(server, prefs);
  }

  return { mods };
}

async function localModIcon(server: ManagedServer, filenameInput: unknown) {
  const filename = safeInstalledModFilename(filenameInput as string | undefined);
  let iconsDir: string;
  try {
    iconsDir = await validateExistingInsideServer(server, "mods/.serversentinel-icons");
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    return null;
  }
  const key = modIconKey(filename);
  const icon = existsSync(iconsDir) ? (await readdir(iconsDir)).find((entry) => entry.startsWith(`${key}.`)) : undefined;
  if (!icon) return null;
  const extension = extname(icon).toLowerCase();
  const contentType = extension === ".webp" ? "image/webp" : extension === ".jpg" || extension === ".jpeg" ? "image/jpeg" : "image/png";
  const iconPath = await validateExistingResolvedInsideServer(server, join(iconsDir, icon));
  return { contentType, stream: createReadStream(iconPath) };
}

async function localToggleMod(server: ManagedServer, filenameInput: unknown, enabledInput: unknown) {
  await ensureServerStoppedForModChanges(server);
  const filename = safeInstalledModFilename(filenameInput as string | undefined);
  const enabled = requireStrictBoolean(enabledInput, "enabled");
  const sourceName = filename.endsWith(".jar") && !existsSync(ensureInsideServer(server, join("mods", filename)))
    ? `${filename}.disabled`
    : filename;
  const source = await validateExistingInsideServer(server, join("mods", sourceName));
  const targetName = enabled
    ? sourceName.replace(/\.jar\.disabled$/, ".jar")
    : sourceName.endsWith(".jar.disabled")
      ? sourceName
      : `${sourceName}.disabled`;
  if (sourceName === targetName) {
    return { ok: true, filename: targetName, enabled };
  }
  const target = await ensureWritableInsideServer(server, join("mods", safeInstalledModFilename(targetName)));
  await rename(source, target);
  const prefs = await readModPreferences(server);
  if (prefs[sourceName]) {
    prefs[targetName] = {
      ...prefs[sourceName],
      modrinth: prefs[sourceName].modrinth ? { ...prefs[sourceName].modrinth, filename: targetName } : undefined
    };
    delete prefs[sourceName];
    await writeModPreferences(server, prefs);
  }
  logInfo({ ...serverLogFields(server), filename: basename(target), enabled, action: "toggle_mod" }, "Mod state changed");
  return { ok: true, filename: basename(target), enabled };
}

async function localSetModChannel(server: ManagedServer, filenameInput: unknown, channelInput: ReleaseChannel | undefined) {
  const filename = safeInstalledModFilename(filenameInput as string | undefined);
  const channel = optionalReleaseChannel(channelInput);
  const prefs = await readModPreferences(server);
  prefs[filename] = { ...prefs[filename], channel };
  await writeModPreferences(server, prefs);
  logInfo({ ...serverLogFields(server), filename, channel, action: "set_mod_channel" }, "Mod update channel changed");
  return { ok: true, filename, channel };
}

async function localRemoveMod(server: ManagedServer, filenameInput: unknown) {
  await ensureServerStoppedForModChanges(server);
  const filename = safeInstalledModFilename(filenameInput as string | undefined);
  const target = await validateExistingInsideServer(server, join("mods", filename));
  await rm(target, { force: true });
  await deleteModIcon(server, filename);
  const prefs = await readModPreferences(server);
  if (prefs[filename]) {
    delete prefs[filename];
    await writeModPreferences(server, prefs);
  }
  logInfo({ ...serverLogFields(server), filename, action: "remove_mod" }, "Mod removed");
  return { ok: true, filename };
}

async function localUploadMod(server: ManagedServer, filenameInput: unknown, contentBase64Input: unknown) {
  const startedAt = Date.now();
  let filename: string | undefined;
  try {
    await ensureServerStoppedForModChanges(server);
    filename = safeModFilename(safeInstalledModFilename(filenameInput as string | undefined));
    logInfo({ ...serverLogFields(server), filename, action: "upload_mod" }, "Manual mod upload started");
    const contentBase64 = validateBase64Content(contentBase64Input);
    const content = Buffer.from(contentBase64, "base64");
    if (!content.length || content.length > modFileSizeLimit) {
      throw new Error(`Uploaded mod must be between 1 byte and ${Math.floor(modFileSizeLimit / 1024 / 1024)} MiB`);
    }
    assertJarBuffer(content);
    await mkdir(ensureInsideServer(server, "mods"), { recursive: true });
    await validateExistingInsideServer(server, "mods");
    const destination = await ensureWritableInsideServer(server, join("mods", filename));
    if (existsSync(destination)) {
      throw new Error("A mod with that filename already exists");
    }
    await writeFile(destination, content);
    await deleteModIcon(server, filename);
    const prefs = await readModPreferences(server);
    if (prefs[filename]?.modrinth) {
      prefs[filename] = { channel: normalizeReleaseChannel(prefs[filename].channel) };
      await writeModPreferences(server, prefs);
    }
    logInfo({ ...serverLogFields(server), filename: basename(destination), size: content.length, durationMs: durationSince(startedAt), action: "upload_mod", status: "succeeded" }, "Manual mod upload succeeded");
    return { ok: true, filename: basename(destination), path: toPublicPath(server, destination) };
  } catch (error) {
    logOperationFailure({ ...serverLogFields(server), filename, durationMs: durationSince(startedAt), action: "upload_mod", status: "failed" }, "Manual mod upload failed", error);
    throw error;
  }
}

async function localInstallMod(server: ManagedServer, projectIdInput: unknown, forceIncompatibleInput: unknown, channelInput: ReleaseChannel | undefined) {
  const startedAt = Date.now();
  const projectId = validateModrinthProjectId(projectIdInput);
  const forceIncompatible = optionalStrictBoolean(forceIncompatibleInput, "forceIncompatible", false);
  try {
    await ensureServerStoppedForModChanges(server);
    if (!projectId || !server.minecraftVersion || !server.loaderVersion) {
      throw new Error("projectId, Minecraft version, and Fabric loader version are required for compatible Fabric installs");
    }
    const minecraftVersion = server.minecraftVersion;
    const selectedChannel = optionalReleaseChannel(channelInput);
    logInfo({ ...serverLogFields(server), projectId, channel: selectedChannel, forceIncompatible, action: "modrinth_install" }, "Modrinth install started");

    const projectUrl = new URL(`https://api.modrinth.com/v2/project/${encodeURIComponent(projectId)}`);
    const projectResponse = await modrinthFetch(projectUrl.toString());
    if (!projectResponse.ok) {
      throw new Error(`Modrinth project lookup failed: ${projectResponse.statusText}`);
    }
    const project = await projectResponse.json() as { icon_url?: string | null };
    const compatibility = await resolveModrinthProjectCompatibility({
      projectId,
      minecraftVersion,
      loader: "fabric",
      channel: selectedChannel
    });
    logInfo({ ...serverLogFields(server), projectId, versionId: compatibility.matchedVersionId, compatibility: compatibility.status, forceIncompatible, action: "modrinth_install" }, "Modrinth compatibility decision");
    if (!compatibility.compatible && !forceIncompatible) {
      logWarn({ ...serverLogFields(server), projectId, compatibility: compatibility.status, reason: compatibility.reason, action: "modrinth_install" }, "Modrinth install rejected as incompatible");
      throw new Error(`${compatibility.reason}. Set forceIncompatible to true to install anyway.`);
    }
    const file = compatibility.file;
    if (!compatibility.matchedVersionId || !compatibility.matchedVersionNumber || !file) {
      throw new Error("No installable .jar file was found for that project");
    }
    if (!file.url.startsWith("https://")) {
      throw new Error("Refusing to download a non-HTTPS mod file");
    }
    if (file.size && file.size > modFileSizeLimit) {
      throw new Error(`Mod download is larger than ${Math.floor(modFileSizeLimit / 1024 / 1024)} MiB`);
    }
    const downloadHost = new URL(file.url).host;

    await mkdir(ensureInsideServer(server, "mods"), { recursive: true });
    await validateExistingInsideServer(server, "mods");
    const destination = await ensureWritableInsideServer(server, join("mods", safeModFilename(file.filename)));
    if (existsSync(destination)) {
      throw new Error("A mod with that filename already exists");
    }
    const downloadResponse = await modrinthFetch(file.url);
    if (!downloadResponse.body) {
      throw new Error("Mod download returned no body");
    }
    const contentLength = Number(downloadResponse.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > modFileSizeLimit) {
      throw new Error(`Mod download is larger than ${Math.floor(modFileSizeLimit / 1024 / 1024)} MiB`);
    }
    try {
      await pipeline(
        Readable.fromWeb(downloadResponse.body as unknown as NodeReadableStream<Uint8Array>),
        sizeLimitTransform(modFileSizeLimit),
        createWriteStream(destination)
      );
      await verifyDownloadedJar(destination, file);
    } catch (error) {
      await rm(destination, { force: true }).catch(() => {});
      throw error;
    }
    const filename = basename(destination);
    await saveModIcon(server, filename, project.icon_url);
    const prefs = await readModPreferences(server);
    prefs[filename] = {
      channel: selectedChannel,
      modrinth: {
        projectId,
        versionId: compatibility.matchedVersionId,
        filename,
        versionNumber: compatibility.matchedVersionNumber,
        versionType: compatibility.matchedVersionType,
        gameVersions: compatibility.matchedGameVersions ?? [],
        loaders: compatibility.matchedLoaders ?? [],
        hashes: file.hashes,
        installedAt: new Date().toISOString(),
        installedWithForceIncompatible: forceIncompatible && !compatibility.compatible,
        incompatibilityReason: compatibility.compatible ? undefined : compatibility.reason,
        clientSide: compatibility.clientSide,
        serverSide: compatibility.serverSide,
        forceIncompatible: forceIncompatible && !compatibility.compatible
      }
    };
    await writeModPreferences(server, prefs);

    logInfo({ ...serverLogFields(server), projectId, versionId: compatibility.matchedVersionId, filename, downloadHost, durationMs: durationSince(startedAt), forceIncompatible: forceIncompatible && !compatibility.compatible, action: "modrinth_install", status: "succeeded" }, "Modrinth install succeeded");
    return {
      ok: true,
      projectId,
      version: compatibility.matchedVersionNumber,
      filename,
      path: toPublicPath(server, destination),
      channel: compatibility.matchedVersionType ?? "release",
      compatibility
    };
  } catch (error) {
    logOperationFailure({ ...serverLogFields(server), projectId, durationMs: durationSince(startedAt), forceIncompatible, action: "modrinth_install", status: "failed" }, "Modrinth install failed", error);
    throw error;
  }
}

app.get<{ Params: { id: string } }>("/api/servers/:id/mods", async (request) => {
  await requireRequestPermission(request, "mods.view");
  const server = await getServer(request.params.id);
  return runtimeForServer(server).listMods(server);
});

app.get<{ Params: { id: string }; Querystring: { filename?: string } }>("/api/servers/:id/mods/icon", async (request, reply) => {
  await requireRequestPermission(request, "mods.view");
  const server = await getServer(request.params.id);
  const icon = await runtimeForServer(server).modIcon(server, request.query.filename);
  if (!icon) {
    reply.code(404);
    return { error: "Icon not found" };
  }
  reply.header("Content-Type", icon.contentType);
  return reply.send(icon.stream);
});

app.patch<{ Params: { id: string }; Body: { filename?: string; enabled?: boolean } }>("/api/servers/:id/mods", modChangeRateLimit, async (request) => {
  await requireRequestPermission(request, "mods.enableDisable");
  const server = await getServer(request.params.id);
  return runtimeForServer(server).toggleMod(server, request.body.filename, request.body.enabled);
});


app.put<{ Params: { id: string }; Body: { filename?: string; channel?: ReleaseChannel } }>("/api/servers/:id/mods/channel", modChangeRateLimit, async (request) => {
  await requireRequestPermission(request, "mods.update");
  const server = await getServer(request.params.id);
  return runtimeForServer(server).setModChannel(server, request.body.filename, request.body.channel);
});

app.delete<{ Params: { id: string }; Querystring: { filename?: string } }>("/api/servers/:id/mods", modChangeRateLimit, async (request) => {
  await requireRequestPermission(request, "mods.remove");
  const server = await getServer(request.params.id);
  return runtimeForServer(server).removeMod(server, request.query.filename);
});

app.post<{ Params: { id: string }; Body: { filename?: string; contentBase64?: string } }>("/api/servers/:id/mods/upload", modChangeRateLimit, async (request) => {
  await requireRequestPermission(request, "mods.upload");
  const server = await getServer(request.params.id);
  return runtimeForServer(server).uploadMod(server, request.body.filename, request.body.contentBase64);
});

app.get<{ Querystring: { query?: string; serverId?: string; channel?: ReleaseChannel; compatibility?: string } }>("/api/modrinth/search", async (request) => {
  await requireRequestPermission(request, "mods.view");
  const query = request.query.query?.trim();
  if (!query) {
    return { hits: [], status: "no_project_found" };
  }
  const server = await getServer(request.query.serverId);
  if (!server.minecraftVersion || !server.loaderVersion) {
    throw new Error("Minecraft and Fabric loader versions are required before searching compatible mods");
  }
  const minecraftVersion = server.minecraftVersion;
  const selectedChannel = optionalReleaseChannel(request.query.channel);
  const compatibilityFilter = optionalCompatibilityFilter(request.query.compatibility);
  const startedAt = Date.now();
  logDebug({ ...serverLogFields(server), queryLength: query.length, channel: selectedChannel, compatibilityFilter, action: "modrinth_search" }, "Modrinth search started");

  try {
    const url = new URL("https://api.modrinth.com/v2/search");
    url.searchParams.set("query", query);
    url.searchParams.set("limit", "20");

    const facets: string[][] = [
      ["project_type:mod"],
      ["categories:fabric"],
      [`versions:${minecraftVersion}`]
    ];
    if (compatibilityFilter !== "all") {
      facets.push(["server_side:required", "server_side:optional"]);
    }
    url.searchParams.set("facets", JSON.stringify(facets));

    const response = await modrinthFetch(url.toString());
    const body = await response.json() as { hits?: ModrinthProject[] };
    const hits = await Promise.all((body.hits ?? []).map(async (hit) => {
      const projectId = hit.project_id || hit.id;
      if (!projectId) {
        return {
          ...hit,
          compatibility: unknownCompatibility()
        };
      }
      return {
        ...hit,
        project_id: projectId,
        compatibility: await resolveModrinthProjectCompatibility({
          projectId,
          minecraftVersion,
          loader: "fabric",
          channel: selectedChannel
        })
      };
    }));
    logInfo({ ...serverLogFields(server), resultCount: hits.length, durationMs: durationSince(startedAt), action: "modrinth_search", status: hits.length > 0 ? "projects_found" : "no_project_found" }, "Modrinth search completed");
    return { ...body, hits, status: hits.length > 0 ? "projects_found" : "no_project_found" };
  } catch (error) {
    logError({ ...serverLogFields(server), durationMs: durationSince(startedAt), action: "modrinth_search", status: "failed", ...errorLogFields(error) }, "Modrinth search failed");
    throw error;
  }
});

app.post<{ Body: { serverId?: string; projectId?: string; channel?: ReleaseChannel; forceIncompatible?: boolean } }>("/api/modrinth/install", modChangeRateLimit, async (request) => {
  await requireRequestPermission(request, "mods.install");
  const server = await getServer(request.body.serverId);
  return runtimeForServer(server).installMod(server, request.body.projectId, request.body.forceIncompatible, request.body.channel);
});

const localRuntime = config.runtimeMode === "all-in-one" ? new LocalNodeRuntime({
  publicServer,
  createServer: createManagedServer,
  updateServer: localUpdateServer,
  deleteServer: localDeleteServer,
  serverStatus: localServerStatus,
  lifecycle: dockerAction,
  sendConsoleCommand: localSendConsoleCommand,
  streamConsole: localStreamConsole,
  serverLogs: localServerLogs,
  serverStats: dockerResourceStats,
  serverOverview: serverOverviewData,
  resolveExistingPath: validateExistingInsideServer,
  resolveWritablePath: ensureWritableInsideServer,
  resolveWritableResolvedPath: ensureWritableResolvedInsideServer,
  publicPath: toPublicPath,
  isModsPath,
  isServerSettingsFile,
  fileRenamePermission,
  listFiles: localListFiles,
  previewFile: localPreviewFile,
  downloadFile: localDownloadFile,
  readFile: localReadEditableFile,
  writeFile: localWriteEditableFile,
  createFolder: localCreateFolder,
  uploadFile: localUploadFile,
  renameFile: localRenameFile,
  duplicateFile: localDuplicateFile,
  deleteFile: localDeleteFile,
  listMods: localListMods,
  modIcon: localModIcon,
  toggleMod: localToggleMod,
  setModChannel: localSetModChannel,
  removeMod: localRemoveMod,
  uploadMod: localUploadMod,
  installMod: localInstallMod
}) : undefined;
runtimeRegistry = new NodeRuntimeRegistry(
  localRuntime,
  (nodeId) => new RemoteNodeRuntime(
    nodeId,
    async (id) => (await queuedReadNodes()).find((node) => node.id === id),
    panelNodeConnections,
    publicServer,
    async (server) => {
      await updateServers((servers) => {
        if (servers.some((candidate) => candidate.id === server.id)) {
          throw new Error("A managed server with this id already exists");
        }
        servers.push(server);
      });
    },
    async (serverId) => {
      await updateServers((servers) => {
        const index = servers.findIndex((candidate) => candidate.id === serverId);
        if (index !== -1) servers.splice(index, 1);
      });
    }
  )
);

await registerStaticFrontend(app);

app.setErrorHandler((error, _request, reply) => {
  const expectedUserError = isExpectedUserError(error);
  const statusCode = error instanceof Error && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : expectedUserError ? 400 : 500;
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorCode = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
  const fields = {
    ...routeLogFields(_request, statusCode),
    category: errorCategory(error, statusCode),
    ...errorLogFields(error, statusCode)
  };
  if (statusCode >= 500) {
    app.log.error(fields, "API request failed");
  } else if (/escapes|outside|unsafe path/i.test(errorMessage)) {
    app.log.warn({ ...fields, action: "blocked_unsafe_path" }, "Blocked unsafe file path");
  } else {
    app.log.warn(fields, "API request rejected");
  }
  reply.code(statusCode).send({
    error: statusCode >= 500 ? "Internal server error" : error instanceof Error ? error.message : "Request failed",
    code: errorCode
  });
});

function scheduleNextTick() {
  setTimeout(async () => {
    try {
      await tickSchedules();
    } catch (error: unknown) {
      app.log.error({ ...errorLogFields(error), category: "scheduler" }, "Schedule polling failed");
    } finally {
      scheduleNextTick();
    }
  }, 30_000).unref();
}
scheduleNextTick();

const startupUsers = await readUsers().catch(() => []);
const startupNodes = await readNodes().catch(() => []);
const modrinthConfigured = Boolean(await modrinthApiKey().catch(() => ""));
const dockerSocketMounted = dockerAvailable();
app.log.info({
  appVersion: process.env.npm_package_version ?? "0.2.0",
  configDir: config.configDir,
  managedServersDir: config.serversDir,
  nodeCount: startupNodes.length,
  dockerSocketMounted,
  modrinthApiConfigured: modrinthConfigured,
  authEnabled: startupUsers.length > 0,
  logLevel: config.logLevel,
  port: config.port
}, "ServerSentinel startup configuration");
if (!dockerSocketMounted) {
  app.log.warn({ dockerSocket: config.dockerSocket }, "Docker socket is not mounted; runtime management is unavailable");
}

await app.listen({ host: "0.0.0.0", port: config.port });
app.log.info({ port: config.port }, "ServerSentinel web panel listening");
}
