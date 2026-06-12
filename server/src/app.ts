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
import { shellQuote } from "./docker/shell.js";
import {
  allowedForChannel,
  fetchProject,
  fetchProjectVersions,
  modrinthJarFile,
  normalizeReleaseChannel,
  resolveModrinthProjectCompatibility,
  unknownCompatibility,
  versionChannel
} from "./modrinth/compatibility.js";
import { modrinthFetch } from "./modrinth/modrinthClient.js";
import { LocalNodeRuntime } from "./nodes/localNodeRuntime.js";
import type { CreateNodeResponse, NodeInstallInstructions } from "./nodes/apiTypes.js";
import { buildNodeInstallInstructions } from "./nodes/installInstructions.js";
import { PanelNodeConnections } from "./nodes/panelConnections.js";
import { nodeCapabilities, nodeProtocolVersion, protocolCompatible } from "./nodes/protocol.js";
import type { NodeHello, PanelWelcome } from "./nodes/protocol.js";
import { NodeRuntimeRegistry } from "./nodes/registry.js";
import { RemoteNodeRuntime } from "./nodes/remoteNodeRuntime.js";
import { newNodeSecret } from "./nodes/nodeAgent.js";
import type { NodeRuntime, RuntimeAction } from "./nodes/types.js";
import { defaultServerJarProvider } from "./runtime/mcjarsProvider.js";
import {
  normalizeRuntimeProfile,
  runtimeProfileForServer,
  runtimeTarget,
  type ServerJarProvider
} from "./runtime/profile.js";
import { summarizeRuntimeExit } from "./runtimeErrors.js";
import { queryMinecraftServer } from "./minecraftQuery.js";
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
import { registerAuthRoutes } from "./routes/authRoutes.js";
import { modrinthApiKey, updateSettings, queuedReadSettings } from "./storage/settingsStore.js";
import { asArray, asObject, optionalString, readJsonFile, requiredString, writeJsonFile } from "./storage/jsonFile.js";
import {
  badRequest,
  forbidden,
  optionalCompatibilityFilter,
  optionalNodeDataMount,
  optionalNodePanelUrl,
  optionalReleaseChannel,
  optionalStrictBoolean,
  requireStrictBoolean,
  validateDockerContainerName,
  validateDockerImageName,
  validateJavaArgs,
  validateModrinthProjectId,
  validateModrinthVersionId,
  validateNodeName,
  validateProvisionJobId,
  validateRuntimeJarFilename,
  validateScheduleId,
  validateServerId
} from "./http/validation.js";
export {
  requireStrictBoolean,
  validateDockerContainerName,
  validateJavaArgs,
  validateModrinthProjectId,
  validateRuntimeJarFilename
} from "./http/validation.js";
import type {
  DockerExecCreate,
  DockerExecInspect,
  DockerState,
  InstalledModMetadata,
  ManagedNode,
  ManagedServer,
  ManagedServerPort,
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
  ScheduledRun,
  ServerRuntimeProfile,
  Session,
  StoredUser
} from "./types.js";
import {
  cronMatches,
  ensureInsideServer,
  ensureWritableInsideServer,
  ensureWritableResolvedInsideServer,
  nextCronRun,
  parseDockerPorts,
  safeInstalledModFilename,
  safeModFilename,
  validateExistingInsideServer,
  validateExistingResolvedInsideServer,
  validateCron,
  AsyncQueue
} from "./core.js";

const localNodeId = "local";
const appVersion = process.env.npm_package_version ?? "0.6.0";
const nodeImageRepository = "nl2109/serversentinel";
const nodeImage = config.nodeImage || `${nodeImageRepository}:latest`;
const serversFile = join(config.configDir, "servers.json");
const nodesFile = join(config.configDir, "nodes.json");
const usersFile = join(config.configDir, "users.json");
const versionMetadataFilename = ".serversentinel-version.json";

const serversQueue = new AsyncQueue();
const nodesQueue = new AsyncQueue();
const usersQueue = new AsyncQueue();
export const sessionMaxAgeSeconds = 60 * 60 * 24 * 14;
export const minNodeJoinTokenTtlMinutes = 5;
export const maxNodeJoinTokenTtlMinutes = 1440;
const serverJarProvider: ServerJarProvider = defaultServerJarProvider;


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

type DockerInfo = {
  MemTotal?: number;
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
  queryPort?: string;
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
  errorDetails?: string;
  createdAt: string;
  updatedAt: string;
};

export type DockerHostPortBinding = {
  port: string;
  protocol: string;
  key: string;
};

type ProvisionPortReservation = {
  nodeId: string;
  dockerPorts: string;
  displayName: string;
};

type Client = {
  send: (payload: string) => void;
  readyState: number;
};

const provisionJobs = new Map<string, ProvisionJob>();
const activeProvisionPortReservations = new Map<string, ProvisionPortReservation>();
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
  const details = "details" in error && typeof error.details === "string" ? error.details : undefined;
  return {
    errorName: error.name,
    errorMessage: error.message,
    errorDetails: details,
    statusCode,
    stack: statusCode && statusCode < 500 ? undefined : error.stack
  };
}

function detailedErrorMessage(error: unknown) {
  if (error instanceof Error && "details" in error && typeof error.details === "string" && error.details.trim()) {
    return error.details.trim();
  }
  if (error instanceof Error) {
    return `${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ""}`;
  }
  return String(error);
}

function detailedError(error: Error, details: string) {
  (error as Error & { details?: string }).details = details;
  return error;
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
    rolePreset: normalized.rolePreset,
    permissions: normalized.permissions,
    serverAccess: normalized.serverAccess,
    createdAt: normalized.createdAt
  };
}

function normalizeRolePreset(rolePreset?: unknown): RolePreset | undefined {
  return rolePreset === undefined ? undefined : rolePresetFromUnknown(rolePreset);
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

export function sessionExpired(session: Pick<Session, "createdAt">, now = Date.now()): boolean {
  const createdAt = new Date(session.createdAt).getTime();
  return !Number.isFinite(createdAt) || now - createdAt > sessionMaxAgeSeconds * 1000;
}

async function currentUserFromCookie(cookieHeader?: string) {
  const sessionId = parseCookies(cookieHeader).get(sessionCookieName);
  if (!sessionId) return null;
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (sessionExpired(session)) {
    sessions.delete(sessionId);
    return null;
  }
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

function compareVersionStrings(left?: string, right?: string) {
  if (!left || !right) return null;
  const parse = (value: string) => {
    const match = value.trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
    return match ? [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)] : null;
  };
  const leftParts = parse(left);
  const rightParts = parse(right);
  if (!leftParts || !rightParts) return left === right ? 0 : null;
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] > rightParts[index]) return 1;
    if (leftParts[index] < rightParts[index]) return -1;
  }
  return 0;
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
    lastSeenAt: now,
    totalMemory: totalmem()
  };
}

function optionalNodeTotalMemory(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function normalizeNode(value: unknown): ManagedNode {
  const node = asObject(value, "managed node");
  const type = node.type;
  if (type !== "local" && type !== "remote") {
    throw new Error("managed node type must be local or remote");
  }
  const status = node.status;
  if (status !== "online" && status !== "offline" && status !== "unknown") {
    throw new Error("managed node status must be online, offline, or unknown");
  }
  const totalMemory = optionalNodeTotalMemory(node.totalMemory);
  if (node.totalMemory !== undefined && totalMemory === undefined) {
    throw new Error("node.totalMemory must be a positive number");
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
    totalMemory,
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
    lastSeenAt: current.lastSeenAt ?? now,
    totalMemory: totalmem()
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

async function publicNodes(nodes: ManagedNode[], detectedInternalTotalMemory?: number): Promise<PublicNode[]> {
  const internalTotalMemory = detectedInternalTotalMemory ?? (nodes.some((node) => node.id === localNodeId || node.isInternal)
    ? await detectedTotalMemory()
    : undefined);
  return nodes.map((node) => {
    const publicFields = publicNode(node);
    return (node.id === localNodeId || node.isInternal) && internalTotalMemory
      ? { ...publicFields, totalMemory: internalTotalMemory }
      : publicFields;
  });
}

export function nodeInstallInstructions(input: { panelUrl?: string; joinToken?: string; dataMount?: string; nodeName?: string }): NodeInstallInstructions {
  return buildNodeInstallInstructions({ ...input, image: nodeImage, defaultPanelPort: config.port });
}

function createJoinToken(ttlMinutesInput?: number) {
  const now = new Date();
  const joinToken = randomBytes(32).toString("base64url");
  const ttlMinutes = validateJoinTokenTtlMinutes(ttlMinutesInput);
  return {
    joinToken,
    expiresAt: new Date(now.getTime() + ttlMinutes * 60_000).toISOString()
  };
}

export function validateJoinTokenTtlMinutes(ttlMinutesInput?: unknown): number {
  if (ttlMinutesInput === undefined || ttlMinutesInput === null) return 60;
  if (typeof ttlMinutesInput !== "number" || !Number.isInteger(ttlMinutesInput) || ttlMinutesInput < minNodeJoinTokenTtlMinutes || ttlMinutesInput > maxNodeJoinTokenTtlMinutes) {
    badRequest(`Join token expiry must be a whole number from ${minNodeJoinTokenTtlMinutes} to ${maxNodeJoinTokenTtlMinutes} minutes`);
  }
  return ttlMinutesInput;
}

async function readNodes() {
  const nodes = await readJsonFile(nodesFile, config.runtimeMode === "all-in-one" ? [defaultInternalNode()] : [], (value) => asArray(value, "nodes.json").map(normalizeNode));
  const normalized = nodes.map(normalizeNode).filter((node) => config.runtimeMode !== "panel" || (!node.isInternal && node.type !== "local" && node.id !== localNodeId));
  if (config.runtimeMode === "all-in-one" && ensureDefaultInternalNode(normalized)) {
    await writeJsonFile(nodesFile, normalized);
  } else if (config.runtimeMode === "panel" && normalized.length !== nodes.length) {
    await writeJsonFile(nodesFile, normalized);
  }
  return normalized;
}

async function writeNodes(nodes: ManagedNode[]) {
  const normalized = nodes.map(normalizeNode).filter((node) => config.runtimeMode !== "panel" || (!node.isInternal && node.type !== "local" && node.id !== localNodeId));
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

async function writeVersionMetadataFile(server: ManagedServer) {
  const now = new Date().toISOString();
  const targetRuntime = runtimeTarget(server);
  const metadata: VersionMetadata = {
    minecraftVersion: targetRuntime.minecraftVersion,
    fabricLoaderVersion: targetRuntime.loaderVersion,
    createdAt: now,
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
  const targetRuntime = runtimeTarget(server);
  const detected = await detectVersionsFromLauncherJar(server);
  const logs = detected.minecraftVersion && detected.fabricLoaderVersion
    ? {}
    : await detectVersionsFromLogs(server);

  const minecraftSource = detected.minecraftVersion ? "detected" : logs.minecraftVersion ? "log" : targetRuntime.minecraftVersion ? "profile" : "unknown";
  const fabricSource = detected.fabricLoaderVersion ? "detected" : logs.fabricLoaderVersion ? "log" : targetRuntime.loaderVersion ? "profile" : "unknown";
  return {
    minecraftVersion: versionResolution(detected.minecraftVersion || logs.minecraftVersion || targetRuntime.minecraftVersion, minecraftSource, lastCheckedAt),
    fabricLoaderVersion: versionResolution(detected.fabricLoaderVersion || logs.fabricLoaderVersion || targetRuntime.loaderVersion, fabricSource, lastCheckedAt)
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
    schedules: (server.schedules ?? []).map(publicSchedule),
    serverType: server.serverType,
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
    directoryLabel: server.storageName || server.displayName,
    hasDockerContainer: Boolean(server.dockerContainer),
    nodeName: node?.name,
    runtimeProfile: runtimeProfileForServer(server),
    resolvedVersions: server.nodeId === localNodeId ? await resolveServerVersions(server) : {
      minecraftVersion: versionResolution(runtimeTarget(server).minecraftVersion, runtimeTarget(server).minecraftVersion ? "profile" : "unknown", new Date().toISOString()),
      fabricLoaderVersion: versionResolution(runtimeTarget(server).loaderVersion, runtimeTarget(server).loaderVersion ? "profile" : "unknown", new Date().toISOString())
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
    lastMessage: optionalString(schedule.lastMessage, "schedule.lastMessage"),
    recentRuns: schedule.recentRuns === undefined ? undefined : asArray(schedule.recentRuns, "schedule.recentRuns").map(normalizeScheduledRun).slice(0, 25)
  };
}

function normalizeScheduledRun(value: unknown): ScheduledRun {
  const run = asObject(value, "scheduled run");
  return {
    id: requiredString(run.id, "run.id"),
    scheduleId: validateScheduleId(run.scheduleId),
    scheduleName: requiredString(run.scheduleName, "run.scheduleName"),
    status: requiredString(run.status, "run.status"),
    message: optionalString(run.message, "run.message"),
    ranAt: requiredString(run.ranAt, "run.ranAt")
  };
}

function publicSchedule(schedule: ScheduledExecution): ScheduledExecution {
  const nextRun = schedule.enabled ? safeNextCronRun(schedule.cron) : null;
  return {
    ...schedule,
    nextRunAt: nextRun?.toISOString(),
    recentRuns: (schedule.recentRuns ?? []).slice(0, 25)
  };
}

function safeNextCronRun(cron: string) {
  try {
    return nextCronRun(cron);
  } catch {
    return null;
  }
}

function normalizeManagedServer(value: unknown): ManagedServer {
  const server = asObject(value, "managed server");
  const serverType = server.serverType;
  if (serverType !== "fabric") {
    throw new Error("managed server serverType must be fabric");
  }
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
  const serversDir = resolve(config.serversDir);
  const serverDir = nodeId === localNodeId
    ? resolve(requiredString(server.serverDir, "server.serverDir"))
    : resolve(requiredString(server.serverDir, "server.serverDir"));
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
    runtimeProfile: normalizeRuntimeProfile(server.runtimeProfile),
    dockerContainer: server.dockerContainer === undefined ? undefined : validateDockerContainerName(server.dockerContainer),
    dockerImage: server.dockerImage === undefined ? undefined : validateDockerImageName(server.dockerImage),
    dockerMountSource: optionalString(server.dockerMountSource, "server.dockerMountSource"),
    dockerWorkingDir: optionalString(server.dockerWorkingDir, "server.dockerWorkingDir"),
    dockerPorts,
    managedPorts,
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
  const validServers = servers.filter((server) => nodeIds.has(server.nodeId));
  if (validServers.length !== servers.length) {
    const removedServers = servers.filter((server) => !nodeIds.has(server.nodeId));
    console.warn(`Purged ${removedServers.length} managed server record${removedServers.length === 1 ? "" : "s"} referencing unknown node ids.`);
    await writeJsonFile(serversFile, validServers);
  }
  return validServers;
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

export function removeServersForNode(servers: ManagedServer[], nodeId: string) {
  let removed = 0;
  for (let index = servers.length - 1; index >= 0; index -= 1) {
    if (servers[index].nodeId === nodeId) {
      servers.splice(index, 1);
      removed += 1;
    }
  }
  return removed;
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
    headers: { "User-Agent": "ServerSentinel/0.6.0 (Fabric mod manager)" }
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

function modrinthIconProxyUrl(iconUrl?: string | null) {
  if (!iconUrl) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(iconUrl);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:") return undefined;
  if (parsed.hostname !== "cdn.modrinth.com" && !parsed.hostname.endsWith(".modrinth.com")) return undefined;
  return `/api/modrinth/icon?url=${encodeURIComponent(parsed.toString())}`;
}

async function fetchModrinthIcon(iconUrl: unknown) {
  const url = typeof iconUrl === "string" ? iconUrl : "";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    badRequest("A valid Modrinth icon URL is required");
  }
  if (parsed.protocol !== "https:" || (parsed.hostname !== "cdn.modrinth.com" && !parsed.hostname.endsWith(".modrinth.com"))) {
    badRequest("Only Modrinth icon URLs can be proxied");
  }
  const response = await fetch(parsed.toString(), {
    headers: { "User-Agent": "ServerSentinel/0.6.0 (Fabric mod manager)" }
  });
  if (!response.ok || !response.body) {
    const error = new Error("Icon not found") as Error & { statusCode?: number };
    error.statusCode = 404;
    throw error;
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 1024 * 1024) {
    badRequest("Icon is larger than the 1 MiB limit");
  }
  const contentType = response.headers.get("content-type") ?? "";
  const safeContentType = contentType.includes("webp")
    ? "image/webp"
    : contentType.includes("jpeg")
      ? "image/jpeg"
      : contentType.includes("png")
        ? "image/png"
        : "image/png";
  return { bytes, contentType: safeContentType };
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

const defaultQueryPort = 25566;

export function dockerHostPortBindings(dockerPorts?: string): DockerHostPortBinding[] {
  const { portBindings } = parseDockerPorts(dockerPorts);
  return Object.entries(portBindings).flatMap(([containerPort, bindings]) => {
    const [, protocol = "tcp"] = containerPort.split("/", 2);
    return bindings.map((binding) => ({
      port: binding.HostPort,
      protocol,
      key: `${binding.HostPort}/${protocol}`
    }));
  });
}

function assertUniqueDockerHostPorts(dockerPorts: string) {
  const seen = new Map<string, DockerHostPortBinding>();
  for (const port of dockerHostPortBindings(dockerPorts)) {
    const existing = seen.get(port.key);
    if (existing) {
      throw new Error(`Port ${existing.port}/${existing.protocol} is listed more than once. Each Docker host port can only be used once per server.`);
    }
    seen.set(port.key, port);
  }
}

function parsePortNumber(value: string, field: string) {
  if (!isValidServerPort(value)) {
    throw new Error(`${field} must be between ${minServerPort} and ${maxServerPort}`);
  }
  return Number(value);
}

function queryPortEntry(port: number): ManagedServerPort {
  return {
    id: "minecraft-query",
    name: "Minecraft Query",
    type: "query",
    protocol: "udp",
    internalPort: port,
    externalPort: port,
    required: true,
    removable: false,
    advanced: true
  };
}

function portEntryBinding(port: ManagedServerPort) {
  return `${port.externalPort}:${port.internalPort}/${port.protocol}`;
}

function managedPortsForDockerPorts(dockerPorts: string, existing: ManagedServerPort[] = []) {
  const queryPort = existing.find((port) => port.type === "query")?.externalPort;
  const seen = new Set<string>();
  const ports: ManagedServerPort[] = [];
  const { portBindings } = parseDockerPorts(dockerPorts);
  for (const [containerPort, bindings] of Object.entries(portBindings)) {
    const [internalPortValue, protocol = "tcp"] = containerPort.split("/", 2);
    for (const binding of bindings) {
      const externalPort = Number(binding.HostPort);
      const internalPort = Number(internalPortValue);
      const key = `${externalPort}/${protocol}`;
      const existingEntry = existing.find((port) => `${port.externalPort}/${port.protocol}` === key);
      const type = existingEntry?.type ?? (protocol === "tcp" && ports.length === 0 ? "minecraft" : "custom");
      if (seen.has(key)) continue;
      seen.add(key);
      ports.push(existingEntry ?? {
        id: type === "minecraft" ? "minecraft-server" : `custom-${key}`,
        name: type === "minecraft" ? "Minecraft Server" : `Port ${externalPort}/${protocol}`,
        type,
        protocol: protocol as "tcp" | "udp",
        internalPort,
        externalPort,
        required: type !== "custom",
        removable: type === "custom",
        advanced: type !== "minecraft"
      });
    }
  }
  if (queryPort && !ports.some((port) => port.type === "query")) {
    ports.push(queryPortEntry(queryPort));
  }
  return ports;
}

function normalizeManagedPorts(dockerPorts: string, managedPorts: ManagedServerPort[] = []) {
  const ports = managedPortsForDockerPorts(dockerPorts, managedPorts);
  const query = ports.find((port) => port.type === "query");
  return query ? ports.map((port) => port.type === "query" ? { ...queryPortEntry(query.externalPort), internalPort: query.internalPort } : port) : ports;
}

function dockerPortsWithManagedEntries(dockerPorts: string, managedPorts: ManagedServerPort[]) {
  const bindings = new Map<string, string>();
  for (const rawPort of dockerPorts.split(",")) {
    const rawBinding = rawPort.trim();
    if (!rawBinding) continue;
    const [hostPort, containerPortWithProtocol] = rawBinding.includes(":") ? rawBinding.split(":", 2) : [rawBinding, rawBinding];
    const [, protocol = "tcp"] = containerPortWithProtocol.split("/", 2);
    bindings.set(`${hostPort}/${protocol}`, rawBinding.includes("/") ? rawBinding : `${hostPort}:${containerPortWithProtocol}/tcp`);
  }
  for (const port of managedPorts) {
    bindings.set(`${port.externalPort}/${port.protocol}`, portEntryBinding(port));
  }
  return [...bindings.values()].join(",");
}

function usedPortKeysForNode(servers: ManagedServer[], nodeId: string, ignoreServerId?: string) {
  const used = new Set<string>();
  for (const server of servers) {
    if (server.nodeId !== nodeId || server.id === ignoreServerId) continue;
    for (const port of dockerHostPortBindings(server.dockerPorts || "25565:25565/tcp")) {
      used.add(port.key);
    }
    for (const port of server.managedPorts ?? []) {
      used.add(`${port.externalPort}/${port.protocol}`);
    }
  }
  return used;
}

function usedProvisionPortKeys(nodeId: string, ignoreJobId?: string) {
  const used = new Set<string>();
  for (const [jobId, reservation] of activeProvisionPortReservations) {
    if (jobId === ignoreJobId || reservation.nodeId !== nodeId) continue;
    for (const port of dockerHostPortBindings(reservation.dockerPorts)) {
      used.add(port.key);
    }
  }
  return used;
}

export function allocateQueryPort(servers: ManagedServer[], nodeId: string, dockerPorts: string, explicitQueryPort?: string, options: { ignoreServerId?: string; ignoreJobId?: string } = {}) {
  const requestedKeys = new Set(dockerHostPortBindings(dockerPorts).map((port) => port.key));
  const used = usedPortKeysForNode(servers, nodeId, options.ignoreServerId);
  for (const key of usedProvisionPortKeys(nodeId, options.ignoreJobId)) used.add(key);
  if (explicitQueryPort?.trim()) {
    const port = parsePortNumber(explicitQueryPort.trim(), "Query port");
    const key = `${port}/udp`;
    if (used.has(key) || requestedKeys.has(`${port}/tcp`)) {
      throw new Error(`Port ${port}/udp is already used on this node. Choose a different Minecraft Query port.`);
    }
    return port;
  }
  for (let port = defaultQueryPort; port <= maxServerPort; port += 1) {
    const udpKey = `${port}/udp`;
    const tcpKey = `${port}/tcp`;
    if (!used.has(udpKey) && !used.has(tcpKey) && !requestedKeys.has(udpKey) && !requestedKeys.has(tcpKey)) {
      return port;
    }
  }
  throw new Error("No free Minecraft Query port is available on this node.");
}

export function normalizeCreateServerPorts(input: CreateServerInput, servers: ManagedServer[] = [], nodeId = localNodeId, options: { ignoreServerId?: string; ignoreJobId?: string } = {}) {
  const serverPort = input.serverPort?.trim() || "25565";
  if (!isValidServerPort(serverPort)) {
    throw new Error(`Server port must be between ${minServerPort} and ${maxServerPort}`);
  }
  const dockerPorts = input.dockerPorts?.trim() || `${serverPort}:${serverPort}/tcp`;
  assertUniqueDockerHostPorts(dockerPorts);
  const queryPort = allocateQueryPort(servers, nodeId, dockerPorts, input.queryPort, options);
  const managedPorts = normalizeManagedPorts(dockerPorts, [queryPortEntry(queryPort)]);
  const completeDockerPorts = dockerPortsWithManagedEntries(dockerPorts, managedPorts);
  assertUniqueDockerHostPorts(completeDockerPorts);
  return { serverPort, dockerPorts: completeDockerPorts, queryPort, managedPorts };
}

function portConflictMessage(port: DockerHostPortBinding, ownerName: string) {
  return `Port ${port.port}/${port.protocol} is already used on this node by ${ownerName}. Choose a different server port or Docker port binding.`;
}

export function findExistingServerPortConflict(
  servers: ManagedServer[],
  nodeId: string,
  dockerPorts: string,
  ignoreServerId?: string
) {
  const requestedPorts = dockerHostPortBindings(dockerPorts);
  const requestedKeys = new Set(requestedPorts.map((port) => port.key));
  for (const server of servers) {
    if (server.nodeId !== nodeId || server.id === ignoreServerId) continue;
    for (const port of dockerHostPortBindings(server.dockerPorts || "25565:25565/tcp")) {
      if (requestedKeys.has(port.key)) {
        return {
          port,
          ownerName: `managed server "${server.displayName}"`
        };
      }
    }
  }
  return null;
}

function findProvisionPortConflict(nodeId: string, dockerPorts: string, ignoreJobId?: string) {
  const requestedPorts = dockerHostPortBindings(dockerPorts);
  const requestedKeys = new Set(requestedPorts.map((port) => port.key));
  for (const [jobId, reservation] of activeProvisionPortReservations) {
    if (jobId === ignoreJobId || reservation.nodeId !== nodeId) continue;
    for (const port of dockerHostPortBindings(reservation.dockerPorts)) {
      if (requestedKeys.has(port.key)) {
        return {
          port,
          ownerName: `provisioning job for "${reservation.displayName}"`
        };
      }
    }
  }
  return null;
}

async function assertNodePortsAvailable(nodeId: string, dockerPorts: string, options: { ignoreServerId?: string; ignoreJobId?: string } = {}) {
  const existingConflict = findExistingServerPortConflict(await queuedReadServers(), nodeId, dockerPorts, options.ignoreServerId);
  if (existingConflict) {
    throw new Error(portConflictMessage(existingConflict.port, existingConflict.ownerName));
  }
  const provisionConflict = findProvisionPortConflict(nodeId, dockerPorts, options.ignoreJobId);
  if (provisionConflict) {
    throw new Error(portConflictMessage(provisionConflict.port, provisionConflict.ownerName));
  }
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

function dockerRuntimeConfigHash(server: ManagedServer) {
  const targetRuntime = runtimeTarget(server);
  return createHash("sha256").update(JSON.stringify({
    image: server.dockerImage || defaultDockerImageForMinecraftVersion(targetRuntime.minecraftVersion),
    workingDir: serverDockerWorkingDir(server),
    bindTarget: serverDockerBindTarget(server),
    ports: server.dockerPorts || "25565:25565/tcp",
    serverJar: targetRuntime.serverJar,
    javaArgs: server.javaArgs || "-Xms2G -Xmx4G",
    restartPolicy: "unless-stopped"
  })).digest("hex");
}

async function detectedTotalMemory() {
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

async function ensureDockerContainer(server: ManagedServer) {
  const expectedConfigHash = dockerRuntimeConfigHash(server);
  const existing = await inspectDockerContainer(server);
  if (existing) {
    if (existing.Config?.Labels?.["serversentinel.managed"] !== "true") {
      logWarn(serverLogFields(server), "Refusing to control unmanaged Docker container");
      throw new Error(`Container ${dockerContainerName(server)} exists but is not managed by ServerSentinel; refusing to control it`);
    }
    if (dockerContainerMountValid(server, existing) && existing.Config?.Labels?.["serversentinel.config-hash"] === expectedConfigHash) {
      return;
    }
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
  const command = `test -f ${quotedServerJar} || { echo "ServerSentinel could not find ${runtime.serverJar} in $(pwd)" >&2; ls -la >&2; exit 66; }; exec java ${javaArgs} -jar ${quotedServerJar} nogui`;
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
          RestartPolicy: { Name: "unless-stopped" },
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
          "serversentinel.managed": "true",
          "serversentinel.config-hash": expectedConfigHash
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

async function updateServerProperties(server: ManagedServer, updates: Record<string, string>) {
  const path = ensureInsideServer(server, "server.properties");
  let values: Record<string, string> = {};
  try {
    values = parseProperties(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeFile(path, serializeProperties({ ...values, ...updates }), "utf8");
}

function normalizeJavaRuntime(server: ManagedServer) {
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

function configuredServerPort(server: ManagedServer, props: Record<string, string>) {
  if (props["server-port"]) return props["server-port"];
  const tcpPort = dockerHostPortBindings(server.dockerPorts || "25565:25565/tcp").find((port) => port.protocol === "tcp");
  return tcpPort?.port || "25565";
}

function configuredQueryPort(server: ManagedServer, props: Record<string, string>) {
  const storedQuery = server.managedPorts?.find((port) => port.type === "query");
  if (storedQuery) return storedQuery.externalPort;
  if (props["query.port"] && isValidServerPort(props["query.port"])) return Number(props["query.port"]);
  const udpPort = dockerHostPortBindings(server.dockerPorts || "").find((port) => port.protocol === "udp");
  return udpPort ? Number(udpPort.port) : null;
}

function validDockerTimestamp(value?: string) {
  return value && !value.startsWith("0001-") ? value : undefined;
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
    const bracketedMatch = rest.match(/^\[(?<thread>[^\]]+)\]\s+\[(?<level>[A-Z]+)\]:\s*(?<message>.*)$/);
    if (bracketedMatch) {
      level = bracketedMatch.groups!.level;
      message = bracketedMatch.groups!.message;
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
  const startedAt = dockerInspect.status === "fulfilled"
    ? validDockerTimestamp(dockerInspect.value?.State?.StartedAt)
    : undefined;
  const stoppedAt = dockerInspect.status === "fulfilled"
    ? validDockerTimestamp(dockerInspect.value?.State?.FinishedAt)
    : undefined;
  const queryMetrics = dockerInspect.status === "fulfilled" && dockerInspect.value?.State?.Running
    ? await queryPlayerMetrics(server, props).catch(() => ({ responding: false, playersOnline: null, maxPlayers: null }))
    : { responding: false, playersOnline: null, maxPlayers: null };
  const activity: ServerActivity = {
    lastStartedAt: startedAt ?? reversedEvents.find((event) => event.eventType === "server_started")?.timestamp,
    lastStoppedAt: stoppedAt ?? reversedEvents.find((event) => event.eventType === "server_stopped")?.timestamp,
    currentWorld: props["level-name"],
    serverPort: configuredServerPort(server, props),
    eulaAccepted,
    javaRuntime: normalizeJavaRuntime(server),
    playersOnline: queryMetrics.playersOnline,
    maxPlayers: queryMetrics.maxPlayers ?? (props["max-players"] ? Number(props["max-players"]) : null)
  };
  return { events, eventsStatus, activity };
}

async function queryPlayerMetrics(server: ManagedServer, props: Record<string, string> = {}) {
  if (props["enable-query"] && props["enable-query"].toLowerCase() !== "true") {
    return { responding: false, playersOnline: null, maxPlayers: null };
  }
  const queryPort = configuredQueryPort(server, props);
  if (!queryPort) {
    return { responding: false, playersOnline: null, maxPlayers: null };
  }
  return queryMinecraftServer("127.0.0.1", queryPort);
}

async function onlinePlayerCount(server: ManagedServer) {
  const path = await validateExistingInsideServer(server, "server.properties").catch(() => "");
  const props = path ? parseProperties(await readFile(path, "utf8")) : {};
  const metrics = await queryPlayerMetrics(server, props).catch(() => ({ responding: false, playersOnline: null, maxPlayers: null }));
  return metrics.playersOnline;
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
  const profile = runtimeProfileForServer(server);
  const artifact = profile?.jarArtifact;
  const downloadUrl = artifact?.downloadUrl;
  const filename = artifact?.filename ?? server.serverJar;
  if (!profile || !filename) {
    throw new Error("A resolved Fabric runtime profile is required before downloading the server jar");
  }
  if (!downloadUrl) {
    throw new Error("The runtime profile does not include a Fabric server jar download URL");
  }
  if (!downloadUrl.startsWith("https://")) {
    throw new Error("Refusing to download a non-HTTPS Fabric server jar");
  }

  const target = ensureInsideServer(server, filename);
  const startedAt = Date.now();
  logInfo({ ...serverLogFields(server), minecraftVersion: profile.minecraftVersion, loaderVersion: profile.loaderVersion, jarProvider: profile.jarProvider, filename }, "Downloading Fabric server launcher");
  const response = await fetch(downloadUrl, {
    headers: {
      "User-Agent": "ServerSentinel/0.6.0 (Fabric runtime downloader)"
    }
  });
  if (!response.ok || !response.body) {
    const body = !response.ok ? await response.text().catch(() => "") : "";
    const details = `Fabric server launcher download failed\nurl=${downloadUrl}\nstatus=${response.status} ${response.statusText}\nbody=${body || "(empty)"}`;
    const error = detailedError(new Error(`Fabric server download failed: ${response.status} ${response.statusText}`), details);
    logError({ ...serverLogFields(server), downloadUrl, statusCode: response.status, responseBody: body || undefined, errorDetails: details, durationMs: durationSince(startedAt) }, "Fabric server launcher download failed");
    throw error;
  }
  await pipeline(
    Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>),
    createWriteStream(target)
  );
  const downloaded = await stat(target);
  if (!downloaded.isFile() || downloaded.size === 0) {
    throw new Error("Fabric server launcher download did not produce a runnable jar");
  }
  logInfo({ ...serverLogFields(server), filename, size: downloaded.size, durationMs: durationSince(startedAt) }, "Fabric server launcher downloaded");
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
  queryPort: number,
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
  await updateServerProperties(server, {
    "server-port": serverPort,
    "enable-query": "true",
    "query.port": String(queryPort)
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
  const runtimeProfile = await serverJarProvider.resolveFabricServerJar({
    minecraftVersion,
    loaderVersion: input.loaderVersion?.trim() || "latest",
    preferStable: true
  });
  const serverJar = validateRuntimeJarFilename(input.serverJar?.trim() || runtimeProfile.jarArtifact.filename);
  const runtimeProfileForRecord: ServerRuntimeProfile = {
    ...runtimeProfile,
    jarArtifact: {
      ...runtimeProfile.jarArtifact,
      filename: serverJar
    }
  };
  const existingServers = await queuedReadServers();
  const { serverPort, dockerPorts, queryPort, managedPorts } = normalizeCreateServerPorts(input, existingServers, localNodeId, { ignoreJobId: jobId });
  await assertNodePortsAvailable(localNodeId, dockerPorts, { ignoreJobId: jobId });
  const dockerContainer = validateDockerContainerName(input.dockerContainer?.trim() || defaultContainerName(displayName));
  const dockerImage = validateDockerImageName(input.dockerImage?.trim() || defaultDockerImageForMinecraftVersion(runtimeProfileForRecord.minecraftVersion));
  const javaArgs = validateJavaArgs(input.javaArgs?.trim() || "-Xms2G -Xmx4G");

  const now = new Date().toISOString();
  const server: ManagedServer = {
    id: randomUUID(),
    nodeId: localNodeId,
    displayName,
    serverDir: resolvedServerDir,
    storageName,
    minecraftVersion,
    loaderVersion: runtimeProfileForRecord.loaderVersion,
    installerVersion: undefined,
    serverJar,
    runtimeProfile: runtimeProfileForRecord,
    dockerContainer,
    dockerImage,
    dockerMountSource: config.serversDockerVolume || resolvedServerDir,
    dockerWorkingDir: config.serversDockerVolume ? `/data/servers/${storageName}` : undefined,
    dockerPorts,
    managedPorts,
    javaArgs,
    serverType: "fabric",
    createdAt: now,
    updatedAt: now
  };

  logInfo({ ...serverLogFields(server), jobId, minecraftVersion: runtimeProfileForRecord.minecraftVersion, loaderVersion: runtimeProfileForRecord.loaderVersion, jarProvider: runtimeProfileForRecord.jarProvider }, "Fabric runtime profile resolved for provisioning");
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

async function startProvisionJob(input: CreateServerInput) {
  const nodeId = input.nodeId?.trim() || (config.runtimeMode === "all-in-one" ? localNodeId : "");
  if (!nodeId) {
    throw new Error("nodeId is required when ServerSentinel runs in panel mode");
  }
  const { dockerPorts, queryPort } = normalizeCreateServerPorts(input, await queuedReadServers(), nodeId);
  await assertNodePortsAvailable(nodeId, dockerPorts);
  input.dockerPorts = dockerPorts;
  input.queryPort = String(queryPort);
  const id = randomUUID();
  const now = new Date().toISOString();
  activeProvisionPortReservations.set(id, {
    nodeId,
    dockerPorts,
    displayName: input.displayName?.trim() || "unnamed server"
  });
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
    logError({ jobId: id, nodeId, serverName: input.displayName?.trim(), errorDetails: detailedErrorMessage(error), ...errorLogFields(error) }, "Provisioning job failed");
    updateProvisionJob(id, {
      status: "failed",
      error: error instanceof Error ? error.message : "Server setup failed",
      errorDetails: detailedErrorMessage(error),
      task: "Server setup failed"
    });
    setTimeout(() => provisionJobs.delete(id), 10 * 60 * 1000).unref();
  }).finally(() => {
    activeProvisionPortReservations.delete(id);
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
    lastMessage: existing?.lastMessage,
    recentRuns: existing?.recentRuns
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
      const count = await runtime.onlinePlayerCount(server);
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
        const ranAt = new Date().toISOString();
        const run: ScheduledRun = {
          id: randomUUID(),
          scheduleId: schedule.id,
          scheduleName: schedule.name,
          status: result.status,
          message: result.message,
          ranAt
        };
        schedule.lastRunAt = ranAt;
        schedule.lastStatus = result.status;
        schedule.lastMessage = result.message;
        schedule.recentRuns = [run, ...(schedule.recentRuns ?? [])].slice(0, 25);
        schedule.updatedAt = ranAt;
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
            currentSchedule.recentRuns = schedule.recentRuns;
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
    queryPort?: string;
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
    const currentRuntime = runtimeProfileForServer(current);
    const minecraftVersion = body.minecraftVersion?.trim() || currentRuntime?.minecraftVersion || current.minecraftVersion;
    if (!minecraftVersion) {
      throw new Error("Minecraft version is required");
    }
    const requestedLoaderVersion = body.loaderVersion?.trim() || currentRuntime?.loaderVersion || current.loaderVersion || "latest";
    const serverJar = validateRuntimeJarFilename(body.serverJar?.trim() || currentRuntime?.jarArtifact.filename || current.serverJar || "fabric-server-launch.jar");
    const shouldResolveRuntime = body.minecraftVersion !== undefined || body.loaderVersion !== undefined || !currentRuntime;
    const resolvedRuntime = shouldResolveRuntime
      ? await serverJarProvider.resolveFabricServerJar({
          minecraftVersion,
          loaderVersion: requestedLoaderVersion,
          preferStable: true
        })
      : currentRuntime;
    if (!resolvedRuntime) {
      throw new Error("A Fabric runtime profile is required before changing server settings");
    }
    const runtimeProfile: ServerRuntimeProfile = {
      ...resolvedRuntime,
      jarArtifact: {
        ...resolvedRuntime.jarArtifact,
        filename: serverJar
      }
    };
    const loaderVersion = runtimeProfile.loaderVersion;
    const serverPort = body.serverPort?.trim();
    if (serverPort && !isValidServerPort(serverPort)) {
      throw new Error(`Server port must be between ${minServerPort} and ${maxServerPort}`);
    }
    const dockerContainer = validateDockerContainerName(body.dockerContainer?.trim() || current.dockerContainer || defaultContainerName(current.displayName));
    const dockerImage = validateDockerImageName(body.dockerImage?.trim() || current.dockerImage || defaultDockerImageForMinecraftVersion(runtimeProfile.minecraftVersion));
    const requestedDockerPorts = body.dockerPorts?.trim() || (serverPort ? `${serverPort}:${serverPort}/tcp` : current.dockerPorts);
    const currentQueryPort = current.managedPorts?.find((port) => port.type === "query")?.externalPort;
    const queryPortInput = body.queryPort?.trim() || (currentQueryPort ? String(currentQueryPort) : undefined);
    const queryPort = queryPortInput
      ? allocateQueryPort(servers, current.nodeId, requestedDockerPorts || "", queryPortInput, { ignoreServerId: current.id })
      : allocateQueryPort(servers, current.nodeId, requestedDockerPorts || "", undefined, { ignoreServerId: current.id });
    const managedPorts = normalizeManagedPorts(requestedDockerPorts || "", [queryPortEntry(queryPort)]);
    const dockerPorts = dockerPortsWithManagedEntries(requestedDockerPorts || "", managedPorts);
    if (dockerPorts) assertUniqueDockerHostPorts(dockerPorts);
    if (dockerPorts) {
      const existingConflict = findExistingServerPortConflict(servers, current.nodeId, dockerPorts, current.id);
      if (existingConflict) {
        throw new Error(portConflictMessage(existingConflict.port, existingConflict.ownerName));
      }
      const provisionConflict = findProvisionPortConflict(current.nodeId, dockerPorts);
      if (provisionConflict) {
        throw new Error(portConflictMessage(provisionConflict.port, provisionConflict.ownerName));
      }
    }
    const javaArgs = validateJavaArgs(body.javaArgs?.trim() || current.javaArgs || "-Xms2G -Xmx4G");

    const jarChanged = current.minecraftVersion !== minecraftVersion
      || current.loaderVersion !== loaderVersion
      || current.serverJar !== serverJar
      || current.runtimeProfile.jarArtifact.downloadUrl !== runtimeProfile.jarArtifact.downloadUrl;
    const containerConfigChanged = current.dockerContainer !== dockerContainer
      || current.dockerImage !== dockerImage
      || current.dockerPorts !== dockerPorts
      || current.javaArgs !== javaArgs
      || current.serverJar !== serverJar;

    const updated: ManagedServer = {
      ...current,
      displayName: body.displayName?.trim() || current.displayName,
      minecraftVersion,
      loaderVersion,
      installerVersion: undefined,
      serverJar,
      runtimeProfile,
      dockerContainer,
      dockerImage,
      dockerPorts,
      managedPorts,
      javaArgs,
      updatedAt: new Date().toISOString()
    };

    if (jarChanged) {
      await downloadFabricServerJar(updated);
    }
    if (containerConfigChanged && dockerAvailable()) {
      await removeManagedDockerContainer(current);
      await ensureDockerContainer(updated);
    }
    await writeVersionMetadataFile(updated);
    if (serverPort || queryPort !== currentQueryPort) {
      await updateServerProperties(updated, {
        ...(serverPort ? { "server-port": serverPort } : {}),
        "enable-query": "true",
        "query.port": String(queryPort)
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
  if (request.method === "GET" && request.url.startsWith("/api/modrinth/icon")) {
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

registerAuthRoutes(app, {
  authRateLimit,
  destructiveRateLimit,
  sessions,
  sessionCookieName,
  sessionMaxAgeSeconds,
  parseCookies,
  sessionCookie,
  currentUserFromCookie,
  queuedReadUsers,
  updateUsers,
  requireRequestPermission,
  validateUsername,
  validatePassword,
  normalizeRolePreset,
  buildUserPermissions,
  hashPassword,
  verifyPassword,
  publicUser,
  logInfo,
  logWarn
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
    if (request.method === "GET" && (request.raw.url === "/api/app" || request.raw.url.startsWith("/api/fabric/versions") || request.raw.url.startsWith("/api/runtime/fabric/"))) {
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
  const totalMemory = await detectedTotalMemory();
  return {
    servers: await Promise.all(servers.map((server) => runtimeForServer(server).publicServer(server, nodes))),
    nodes: await publicNodes(nodes, totalMemory),
    runtimeMode: config.runtimeMode,
    modrinthApiConfigured: Boolean(await modrinthApiKey()),
    dockerSocketMounted: dockerAvailable(),
    totalMemory,
    currentUser: user ? publicUser(user) : undefined
  };
});

app.get("/api/nodes", async (request) => {
  await requireRequestPermission(request, "servers.view");
  return { nodes: await publicNodes(await queuedReadNodes()) };
});

app.post<{ Body: { name?: string; tokenTtlMinutes?: number; dataMount?: string; panelUrl?: string } }>("/api/nodes", destructiveRateLimit, async (request): Promise<CreateNodeResponse> => {
  await requireRequestPermission(request, "users.manage");
  const now = new Date();
  const token = createJoinToken(request.body.tokenTtlMinutes);
  const nodeId = randomUUID();
  const nodeName = validateNodeName(request.body.name);
  const panelUrl = optionalNodePanelUrl(request.body.panelUrl);
  const dataMount = optionalNodeDataMount(request.body.dataMount);
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
    install: nodeInstallInstructions({ panelUrl, joinToken: token.joinToken, dataMount, nodeName })
  };
});

app.post<{ Body: { name?: string; tokenTtlMinutes?: number; dataMount?: string; panelUrl?: string } }>("/api/nodes/pending", destructiveRateLimit, async (request): Promise<CreateNodeResponse> => {
  await requireRequestPermission(request, "users.manage");
  const now = new Date();
  const token = createJoinToken(request.body.tokenTtlMinutes);
  const nodeName = validateNodeName(request.body.name);
  const panelUrl = optionalNodePanelUrl(request.body.panelUrl);
  const dataMount = optionalNodeDataMount(request.body.dataMount);
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
    install: nodeInstallInstructions({ panelUrl, joinToken: token.joinToken, dataMount, nodeName })
  };
});

app.post<{ Params: { nodeId: string }; Body: { tokenTtlMinutes?: number; dataMount?: string; panelUrl?: string } }>("/api/nodes/:nodeId/rotate-token", destructiveRateLimit, async (request): Promise<CreateNodeResponse> => {
  await requireRequestPermission(request, "users.manage");
  const token = createJoinToken(request.body.tokenTtlMinutes);
  const panelUrl = optionalNodePanelUrl(request.body.panelUrl);
  const dataMount = optionalNodeDataMount(request.body.dataMount);
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
    install: nodeInstallInstructions({ panelUrl, joinToken: token.joinToken, dataMount, nodeName: updatedNode!.name })
  };
});

app.get<{ Params: { nodeId: string }; Querystring: { panelUrl?: string; dataMount?: string } }>("/api/nodes/:nodeId/install", async (request) => {
  await requireRequestPermission(request, "servers.view");
  const panelUrl = optionalNodePanelUrl(request.query.panelUrl);
  const dataMount = optionalNodeDataMount(request.query.dataMount);
  const node = (await queuedReadNodes()).find((candidate) => candidate.id === request.params.nodeId);
  if (!node) nodeNotFound(request.params.nodeId);
  return {
    node: publicNode(node),
    install: nodeInstallInstructions({ panelUrl, dataMount, nodeName: node.name })
  };
});

app.post<{ Params: { nodeId: string }; Body: { image?: string } }>("/api/nodes/:nodeId/update", destructiveRateLimit, async (request) => {
  await requireRequestPermission(request, "users.manage");
  const body = request.body ?? {};
  const node = (await queuedReadNodes()).find((candidate) => candidate.id === request.params.nodeId);
  if (!node) nodeNotFound(request.params.nodeId);
  if (node.isInternal) {
    throw new Error("Internal node cannot be updated from the Nodes page.");
  }
  const nodePanelVersionComparison = compareVersionStrings(node.agentVersion, appVersion);
  if (nodePanelVersionComparison === 1) {
    throw new Error(`Node agent ${node.agentVersion} is newer than this panel (${appVersion}). Update the panel before updating this node image.`);
  }
  if (node.agentVersion && node.agentVersion !== appVersion && nodePanelVersionComparison === null) {
    throw new Error(`Node agent version ${node.agentVersion} could not be compared with panel version ${appVersion}. Update the panel and node to matching release versions.`);
  }
  const image = validateDockerImageName(body.image?.trim() || nodeImage);
  if (node.status !== "online") {
    return {
      ok: false,
      mode: "offline",
      message: "Node is offline. Update it on the node host, then refresh this page.",
      image,
      command: `docker pull ${image}`
    };
  }
  if (!panelNodeConnections.isConnected(node.id)) {
    return {
      ok: false,
      mode: "offline",
      message: "Node is not connected to the panel right now. Update it on the node host, then refresh this page.",
      image,
      command: `docker pull ${image}`
    };
  }
  return panelNodeConnections.request(node, "node.update", { image }, 30_000);
});

app.delete<{ Params: { nodeId: string }; Querystring: { force?: string } }>("/api/nodes/:nodeId", destructiveRateLimit, async (request) => {
  await requireRequestPermission(request, "users.manage");
  const node = (await queuedReadNodes()).find((candidate) => candidate.id === request.params.nodeId);
  if (!node) nodeNotFound(request.params.nodeId);
  if (node.isInternal) {
    throw new Error("Internal node cannot be deleted");
  }
  const servers = await queuedReadServers();
  const assignedServers = servers.filter((server) => server.nodeId === request.params.nodeId);
  const force = request.query.force === "true";
  if (assignedServers.length && !force) {
    throw new Error("Cannot delete a node while servers are assigned to it");
  }
  let selfRemoval: { ok: boolean; message: string } = node.capabilities?.includes("node.remove") && panelNodeConnections.isConnected(node.id)
    ? { ok: false, message: "Node container self-stop was not attempted." }
    : { ok: false, message: "Node is offline or does not support panel-triggered self-stop. Stop its container manually if it is still running." };
  if (node.capabilities?.includes("node.remove") && panelNodeConnections.isConnected(node.id)) {
    try {
      const result = await panelNodeConnections.request(node, "node.remove", undefined, 10_000) as { message?: string };
      selfRemoval = { ok: true, message: result.message || "Node container will stop itself." };
    } catch (error) {
      selfRemoval = {
        ok: false,
        message: error instanceof Error ? error.message : "Node container self-stop failed. Stop it manually if it is still running."
      };
    }
  }
  let deletedServers = 0;
  if (force && assignedServers.length) {
    await updateServers((currentServers) => {
      deletedServers = removeServersForNode(currentServers, request.params.nodeId);
    });
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
  return { ok: deleted, deletedServers, selfRemoval };
});

app.get<{ Params: { nodeId: string } }>("/api/nodes/:nodeId", async (request, reply) => {
  await requireRequestPermission(request, "servers.view");
  const node = (await queuedReadNodes()).find((candidate) => candidate.id === request.params.nodeId);
  if (!node) {
    return reply.code(404).send({ error: "Node not found", code: "node_not_found" });
  }
  return (await publicNodes([node]))[0];
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
          totalMemory: optionalNodeTotalMemory(hello.totalMemory) ?? node.totalMemory,
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
          totalMemory: optionalNodeTotalMemory(hello.totalMemory) ?? node.totalMemory,
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
  const publicNodeList = await publicNodes(nodes);
  return {
    nodes: publicNodeList.map((node) => ({
      ...node,
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
  const game = await serverJarProvider.listMinecraftVersions();
  const latestGame = game.find((version) => version.type === "release") ?? game[0];
  const loader = latestGame ? await serverJarProvider.listFabricLoaderVersions(latestGame.id).catch(() => []) : [];
  return {
    game: game.map((version) => ({ version: version.id, stable: version.type === "release" && version.supported, type: version.type ?? "unknown" })),
    loader: loader.slice(0, 20).map((version) => ({ version: version.loaderVersion, stable: version.stable !== false })),
    installer: []
  };
});

app.get("/api/runtime/fabric/minecraft-versions", async (request) => {
  if (request.headers["x-serversentinel-demo-mode"] !== "true") {
    await requireRequestPermission(request, "servers.create");
  }
  return { versions: await serverJarProvider.listMinecraftVersions() };
});

app.get<{ Querystring: { minecraftVersion?: string; refresh?: string } }>("/api/runtime/fabric/loader-versions", async (request) => {
  if (request.headers["x-serversentinel-demo-mode"] !== "true") {
    await requireRequestPermission(request, "servers.create");
  }
  const minecraftVersion = request.query.minecraftVersion?.trim();
  if (!minecraftVersion) {
    throw new Error("minecraftVersion is required");
  }
  return {
    minecraftVersion,
    loaderVersions: await serverJarProvider.listFabricLoaderVersions(minecraftVersion, { forceRefresh: request.query.refresh === "true" })
  };
});

app.post<{ Body: { minecraftVersion?: string; loaderVersion?: string; preferStable?: boolean; refresh?: boolean } }>("/api/runtime/fabric/resolve", async (request) => {
  await requireRequestPermission(request, "servers.create");
  const minecraftVersion = request.body.minecraftVersion?.trim();
  if (!minecraftVersion) {
    throw new Error("minecraftVersion is required");
  }
  const runtimeProfile = await serverJarProvider.resolveFabricServerJar({
    minecraftVersion,
    loaderVersion: request.body.loaderVersion?.trim() || "latest",
    preferStable: request.body.preferStable !== false,
    forceRefresh: request.body.refresh === true
  });
  return { runtimeProfile, warnings: [] };
});

app.post<{
  Body: CreateServerInput;
}>("/api/servers", provisionRateLimit, async (request) => {
  await requireRequestPermission(request, "servers.create");
  const nodeId = request.body.nodeId?.trim() || (config.runtimeMode === "all-in-one" ? localNodeId : "");
  if (!nodeId) throw new Error("nodeId is required when ServerSentinel runs in panel mode");
  const { dockerPorts, queryPort } = normalizeCreateServerPorts(request.body, await queuedReadServers(), nodeId);
  await assertNodePortsAvailable(nodeId, dockerPorts);
  request.body.dockerPorts = dockerPorts;
  request.body.queryPort = String(queryPort);
  const server = await runtimeForNodeId(nodeId).createServer({ ...request.body, nodeId });
  logInfo(serverLogFields(server), "Managed server created");
  return runtimeForServer(server).publicServer(server);
});

app.post<{ Body: CreateServerInput }>("/api/servers/provision", provisionRateLimit, async (request) => {
  await requireRequestPermission(request, "servers.create");
  if (!request.body.nodeId && config.runtimeMode === "panel") {
    throw new Error("nodeId is required when ServerSentinel runs in panel mode");
  }
  const job = await startProvisionJob(request.body);
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
    queryPort?: string;
    javaArgs?: string;
    serverPort?: string;
  };
}>("/api/servers/:id", destructiveRateLimit, async (request) => {
  await requireRequestPermission(request, "servers.editSettings");
  const server = await getServer(request.params.id);
  const nextDisplayName = request.body.displayName?.trim() || server.displayName;
  const servers = await queuedReadServers();
  if (servers.some((candidate) => candidate.id !== server.id && candidate.displayName.toLowerCase() === nextDisplayName.toLowerCase())) {
    throw new Error("A managed server with this display name already exists");
  }
  const serverPort = request.body.serverPort?.trim();
  if (serverPort && !isValidServerPort(serverPort)) {
    throw new Error(`Server port must be between ${minServerPort} and ${maxServerPort}`);
  }
  const requestedDockerPorts = request.body.dockerPorts?.trim() || (serverPort ? `${serverPort}:${serverPort}/tcp` : server.dockerPorts);
  const currentQueryPort = server.managedPorts?.find((port) => port.type === "query")?.externalPort;
  const queryPort = request.body.queryPort?.trim() || (currentQueryPort ? String(currentQueryPort) : undefined);
  const allocatedQueryPort = allocateQueryPort(servers, server.nodeId, requestedDockerPorts || "", queryPort, { ignoreServerId: server.id });
  const managedPorts = normalizeManagedPorts(requestedDockerPorts || "", [queryPortEntry(allocatedQueryPort)]);
  const dockerPorts = dockerPortsWithManagedEntries(requestedDockerPorts || "", managedPorts);
  if (dockerPorts) {
    assertUniqueDockerHostPorts(dockerPorts);
    await assertNodePortsAvailable(server.nodeId, dockerPorts, { ignoreServerId: server.id });
  }
  const updatedServer = await runtimeForServer(server).updateServer(server, { ...request.body, dockerPorts, queryPort: String(allocatedQueryPort) });
  return runtimeForServer(updatedServer).publicServer(updatedServer);
});

app.get<{ Params: { id: string } }>("/api/servers/:id/runtime", async (request) => {
  await requireRequestPermission(request, "servers.view");
  const server = await getServer(request.params.id);
  const runtimeProfile = runtimeProfileForServer(server);
  return {
    serverId: server.id,
    runtimeProfile,
    compatibilityStatus: runtimeProfile.compatibilityStatus
  };
});

app.post<{ Params: { id: string }; Body: { refresh?: boolean } }>("/api/servers/:id/runtime/refresh", destructiveRateLimit, async (request) => {
  await requireRequestPermission(request, "servers.editSettings");
  const server = await getServer(request.params.id);
  const runtimeProfile = runtimeProfileForServer(server);
  const refreshed = await serverJarProvider.resolveFabricServerJar({
    minecraftVersion: runtimeProfile.minecraftVersion,
    loaderVersion: runtimeProfile.loaderVersion || "latest",
    preferStable: true,
    forceRefresh: request.body.refresh === true
  });
  const nextProfile: ServerRuntimeProfile = {
    ...refreshed,
    jarArtifact: {
      ...refreshed.jarArtifact,
      filename: runtimeProfile.jarArtifact.filename || refreshed.jarArtifact.filename
    }
  };
  let updatedServer: ManagedServer | undefined;
  await updateServers((servers) => {
    const index = servers.findIndex((candidate) => candidate.id === server.id);
    if (index === -1) throw new Error("Server not found");
    servers[index] = {
      ...servers[index],
      minecraftVersion: nextProfile.minecraftVersion,
      loaderVersion: nextProfile.loaderVersion,
      serverJar: nextProfile.jarArtifact.filename,
      runtimeProfile: nextProfile,
      updatedAt: new Date().toISOString()
    };
    updatedServer = servers[index];
  });
  return {
    serverId: server.id,
    runtimeProfile: nextProfile,
    server: updatedServer ? await runtimeForServer(updatedServer).publicServer(updatedServer) : undefined,
    warnings: []
  };
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
    overrideMinecraftVersion: metadata.overrideMinecraftVersion === undefined ? undefined : requireStrictBoolean(metadata.overrideMinecraftVersion, "modrinth.overrideMinecraftVersion"),
    overrideReason: optionalString(metadata.overrideReason, "modrinth.overrideReason"),
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
  const target = runtimeTarget(server);
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
  if (target.minecraftVersion && !metadata.gameVersions.includes(target.minecraftVersion)) {
    return {
      status: "no_minecraft_version",
      compatible: false,
      reason: `This mod was installed for Minecraft ${metadata.gameVersions.join(", ") || "unknown"}, but this server is ${target.minecraftVersion}.`,
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
  const targetRuntime = runtimeTarget(server);
  if (!targetRuntime.minecraftVersion) return null;
  const hash = createHash("sha1").update(await readFile(modPath)).digest("hex");
  const currentRes = await modrinthFetch(`https://api.modrinth.com/v2/version_file/${hash}?algorithm=sha1`);
  const current = await currentRes.json() as { project_id?: string; version_number?: string; version_type?: string };
  if (!current.project_id) return null;
  const versionsUrl = new URL(`https://api.modrinth.com/v2/project/${encodeURIComponent(current.project_id)}/version`);
  versionsUrl.searchParams.set("loaders", JSON.stringify(["fabric"]));
  versionsUrl.searchParams.set("game_versions", JSON.stringify([targetRuntime.minecraftVersion]));
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

type ModrinthInstallRequest = {
  projectId: string;
  versionId?: string;
  forceIncompatible: boolean;
  overrideMinecraftVersion: boolean;
  channel: ReleaseChannel;
};

function parseModrinthInstallRequest(input: unknown): ModrinthInstallRequest {
  const body = asObject(input, "mod install request");
  return {
    projectId: validateModrinthProjectId(body.projectId),
    versionId: validateModrinthVersionId(body.versionId),
    forceIncompatible: optionalStrictBoolean(body.forceIncompatible, "forceIncompatible", false),
    overrideMinecraftVersion: optionalStrictBoolean(body.overrideMinecraftVersion, "overrideMinecraftVersion", false),
    channel: optionalReleaseChannel(body.channel)
  };
}

function compatibilityFromSelectedVersion(input: {
  version: ModrinthVersion;
  file: NonNullable<ReturnType<typeof modrinthJarFile>>;
  projectSides: { server_side?: string; client_side?: string };
  minecraftVersion: string;
  compatible: boolean;
  reason: string;
}): ModCompatibility {
  return {
    status: input.compatible ? "compatible" : "incompatible",
    compatible: input.compatible,
    reason: input.reason,
    matchedVersionId: input.version.id,
    matchedVersionNumber: input.version.version_number,
    matchedVersionType: versionChannel(input.version.version_type),
    matchedLoaders: input.version.loaders,
    matchedGameVersions: input.version.game_versions,
    file: input.file,
    serverSide: input.projectSides.server_side,
    clientSide: input.projectSides.client_side
  };
}

type PlannedModInstall = {
  projectId: string;
  project: ModrinthProject;
  version: ModrinthVersion;
  file: NonNullable<ReturnType<typeof modrinthJarFile>>;
  compatibility: ModCompatibility;
  dependencyType: "root" | "required";
};

type OptionalModDependency = {
  projectId?: string;
  versionId?: string;
  dependencyType: string;
  reason: string;
};

async function fetchModrinthVersion(versionId: string) {
  const response = await modrinthFetch(`https://api.modrinth.com/v2/version/${encodeURIComponent(versionId)}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch Modrinth version ${versionId}: ${response.statusText}`);
  }
  return await response.json() as ModrinthVersion;
}

async function planRequiredModrinthInstalls(input: {
  rootProjectId: string;
  rootProject: ModrinthProject;
  rootVersion: ModrinthVersion;
  minecraftVersion: string;
  channel: ReleaseChannel;
}) {
  const planned = new Map<string, PlannedModInstall>();
  const optionalDependencies: OptionalModDependency[] = [];
  const visiting = new Set<string>();

  const planVersion = async (
    projectId: string,
    project: ModrinthProject,
    version: ModrinthVersion,
    dependencyType: "root" | "required"
  ) => {
    const key = version.id || projectId;
    if (planned.has(key)) return;
    if (visiting.has(key)) {
      throw new Error(`Required Modrinth dependency cycle detected at ${project.title || projectId}`);
    }
    visiting.add(key);
    const file = modrinthJarFile(version);
    if (!file) {
      throw new Error(`Required dependency ${project.title || projectId} has no installable .jar file for this runtime`);
    }
    const hasFabric = version.loaders.includes("fabric");
    const matchesMinecraft = version.game_versions.includes(input.minecraftVersion);
    if (!hasFabric) {
      throw new Error(`Required dependency ${project.title || projectId} is not available for Fabric`);
    }
    if (!matchesMinecraft) {
      throw new Error(`Required dependency ${project.title || projectId} is not available for Minecraft ${input.minecraftVersion}`);
    }
    const projectSides = { server_side: project.server_side, client_side: project.client_side };
    const compatibility = compatibilityFromSelectedVersion({
      version,
      file,
      projectSides,
      minecraftVersion: input.minecraftVersion,
      compatible: true,
      reason: dependencyType === "root" ? "Compatible server-side Fabric mod" : "Compatible required dependency"
    });

    for (const dependency of version.dependencies ?? []) {
      const type = dependency.dependency_type || "required";
      if (type !== "required") {
        optionalDependencies.push({
          projectId: dependency.project_id,
          versionId: dependency.version_id,
          dependencyType: type,
          reason: "Optional dependency was not installed automatically"
        });
        continue;
      }
      let dependencyVersion: ModrinthVersion | undefined;
      let dependencyProjectId = dependency.project_id;
      if (dependency.version_id) {
        dependencyVersion = await fetchModrinthVersion(dependency.version_id);
        dependencyProjectId ||= dependencyVersion.project_id;
      }
      if (!dependencyProjectId) {
        throw new Error(`Required dependency for ${project.title || projectId} does not include a project id`);
      }
      const dependencyProject = await fetchProject(dependencyProjectId) as ModrinthProject;
      dependencyVersion ??= (await fetchProjectVersions(dependencyProjectId, {
        loader: "fabric",
        minecraftVersion: input.minecraftVersion
      })).find((candidate) => allowedForChannel(candidate, input.channel) && modrinthJarFile(candidate));
      if (!dependencyVersion) {
        throw new Error(`Required dependency ${dependencyProject.title || dependencyProjectId} has no compatible Fabric version for Minecraft ${input.minecraftVersion}`);
      }
      await planVersion(dependencyProjectId, dependencyProject, dependencyVersion, "required");
    }

    visiting.delete(key);
    planned.set(key, {
      projectId,
      project,
      version,
      file,
      compatibility,
      dependencyType
    });
  };

  await planVersion(input.rootProjectId, input.rootProject, input.rootVersion, "root");
  return {
    installs: Array.from(planned.values()).sort((a, b) => a.dependencyType === b.dependencyType ? 0 : a.dependencyType === "required" ? -1 : 1),
    optionalDependencies
  };
}

async function localInstallMod(server: ManagedServer, input: unknown) {
  const startedAt = Date.now();
  const install = parseModrinthInstallRequest(input);
  const projectId = install.projectId;
  const forceIncompatible = install.forceIncompatible;
  try {
    await ensureServerStoppedForModChanges(server);
    const targetRuntime = runtimeTarget(server);
    if (!projectId || !targetRuntime.minecraftVersion || targetRuntime.loader !== "fabric") {
      throw new Error("A resolved Fabric runtime profile is required before installing compatible mods");
    }
    const minecraftVersion = targetRuntime.minecraftVersion;
    const selectedChannel = install.channel;
    logInfo({ ...serverLogFields(server), projectId, versionId: install.versionId, channel: selectedChannel, forceIncompatible, overrideMinecraftVersion: install.overrideMinecraftVersion, action: "modrinth_install" }, "Modrinth install started");

    const [project, versions] = await Promise.all([
      fetchProject(projectId) as Promise<ModrinthProject>,
      fetchProjectVersions(projectId)
    ]);
    const projectSides = { server_side: project.server_side, client_side: project.client_side };
    const selectedVersion = install.versionId
      ? versions.find((version) => version.id === install.versionId)
      : versions.find((version) => (
        allowedForChannel(version, selectedChannel)
        && version.loaders.includes("fabric")
        && version.game_versions.includes(minecraftVersion)
        && modrinthJarFile(version)
        && modrinthServerSideSupported(project.server_side)
      ));
    if (!selectedVersion) {
      throw new Error(install.versionId ? "The selected Modrinth version could not be found" : "No compatible installable version was found for that project");
    }
    if (!allowedForChannel(selectedVersion, selectedChannel)) {
      throw new Error("The selected version is outside the requested release channel");
    }
    const file = modrinthJarFile(selectedVersion);
    const hasFabric = selectedVersion.loaders.includes("fabric");
    const matchesMinecraft = selectedVersion.game_versions.includes(minecraftVersion);
    const serverSide = project.server_side;
    const serverSupported = modrinthServerSideSupported(serverSide);
    if (!file) {
      throw new Error("No installable .jar file was found for that version");
    }
    if (!hasFabric) {
      throw new Error("The selected version is not a Fabric version");
    }
    if (serverSide === "unsupported") {
      throw new Error("Client-only mods cannot be installed on the server");
    }
    if (serverSide === "unknown" && !forceIncompatible) {
      throw new Error("Server-side support is unknown. Confirm the risk before installing.");
    }
    if (!serverSupported && !forceIncompatible) {
      throw new Error("Server-side support could not be verified. Confirm the risk before installing.");
    }
    if (!matchesMinecraft && !install.overrideMinecraftVersion) {
      throw new Error(`This version is not marked for Minecraft ${minecraftVersion}. Confirm the Minecraft version override before installing.`);
    }
    const compatible = hasFabric && matchesMinecraft && serverSupported;
    const incompatibilityReason = compatible
      ? undefined
      : !matchesMinecraft
        ? `Installed with Minecraft version override. Server ${minecraftVersion}; mod ${selectedVersion.game_versions.join(", ") || "unknown"}.`
        : serverSide === "unknown"
          ? "Server-side support could not be verified"
          : "Installed with compatibility override";
    const compatibility = compatibilityFromSelectedVersion({
      version: selectedVersion,
      file,
      projectSides,
      minecraftVersion,
      compatible,
      reason: compatible ? "Compatible server-side Fabric mod" : incompatibilityReason ?? "Installed with compatibility override"
    });
    logInfo({ ...serverLogFields(server), projectId, versionId: compatibility.matchedVersionId, compatibility: compatibility.status, forceIncompatible, action: "modrinth_install" }, "Modrinth compatibility decision");
    if (!compatibility.compatible && !forceIncompatible) {
      logWarn({ ...serverLogFields(server), projectId, compatibility: compatibility.status, reason: compatibility.reason, action: "modrinth_install" }, "Modrinth install rejected as incompatible");
      throw new Error(`${compatibility.reason}. Set forceIncompatible to true to install anyway.`);
    }
    const installPlan = compatibility.compatible
      ? await planRequiredModrinthInstalls({
          rootProjectId: projectId,
          rootProject: project,
          rootVersion: selectedVersion,
          minecraftVersion,
          channel: selectedChannel
        })
      : {
          installs: [{
            projectId,
            project,
            version: selectedVersion,
            file,
            compatibility,
            dependencyType: "root" as const
          }],
          optionalDependencies: [] as OptionalModDependency[]
        };

    await mkdir(ensureInsideServer(server, "mods"), { recursive: true });
    await validateExistingInsideServer(server, "mods");
    const installed: Array<{ projectId: string; version: string; filename: string; dependencyType: "root" | "required"; path: string }> = [];
    const prefs = await readModPreferences(server);

    for (const planned of installPlan.installs) {
      if (!planned.file.url.startsWith("https://")) {
        throw new Error("Refusing to download a non-HTTPS mod file");
      }
      if (planned.file.size && planned.file.size > modFileSizeLimit) {
        throw new Error(`Mod download is larger than ${Math.floor(modFileSizeLimit / 1024 / 1024)} MiB`);
      }
      const destination = await ensureWritableInsideServer(server, join("mods", safeModFilename(planned.file.filename)));
      if (existsSync(destination)) {
        if (planned.dependencyType === "required") continue;
        throw new Error("A mod with that filename already exists");
      }
      const downloadResponse = await modrinthFetch(planned.file.url);
      if (!downloadResponse.ok) {
        throw new Error(`Mod download failed: ${downloadResponse.statusText}`);
      }
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
        await verifyDownloadedJar(destination, planned.file);
      } catch (error) {
        await rm(destination, { force: true }).catch(() => {});
        throw error;
      }
      const filename = basename(destination);
      await saveModIcon(server, filename, planned.project.icon_url);
      prefs[filename] = {
        channel: selectedChannel,
        modrinth: {
          projectId: planned.projectId,
          versionId: planned.version.id,
          filename,
          versionNumber: planned.version.version_number,
          versionType: versionChannel(planned.version.version_type),
          gameVersions: planned.version.game_versions,
          loaders: planned.version.loaders,
          hashes: planned.file.hashes,
          installedAt: new Date().toISOString(),
          installedWithForceIncompatible: planned.dependencyType === "root" && forceIncompatible && !compatibility.compatible,
          incompatibilityReason: planned.dependencyType === "root" ? incompatibilityReason : undefined,
          overrideMinecraftVersion: planned.dependencyType === "root" && install.overrideMinecraftVersion && !matchesMinecraft,
          overrideReason: planned.dependencyType === "root" && install.overrideMinecraftVersion && !matchesMinecraft ? incompatibilityReason : undefined,
          clientSide: planned.project.client_side,
          serverSide: planned.project.server_side,
          forceIncompatible: planned.dependencyType === "root" && forceIncompatible && !compatibility.compatible
        }
      };
      installed.push({
        projectId: planned.projectId,
        version: planned.version.version_number,
        filename,
        dependencyType: planned.dependencyType,
        path: toPublicPath(server, destination)
      });
    }
    await writeModPreferences(server, prefs);

    const rootInstall = installed.find((item) => item.dependencyType === "root");
    logInfo({ ...serverLogFields(server), projectId, versionId: compatibility.matchedVersionId, filename: rootInstall?.filename, installedCount: installed.length, durationMs: durationSince(startedAt), forceIncompatible: forceIncompatible && !compatibility.compatible, action: "modrinth_install", status: "succeeded" }, "Modrinth install succeeded");
    return {
      ok: true,
      projectId,
      version: selectedVersion.version_number,
      filename: rootInstall?.filename ?? safeModFilename(file.filename),
      path: rootInstall?.path,
      channel: versionChannel(selectedVersion.version_type),
      compatibility,
      installed,
      optionalDependencies: installPlan.optionalDependencies
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

app.get<{ Querystring: { url?: string } }>("/api/modrinth/icon", async (request, reply) => {
  await requireRequestPermission(request, "mods.view");
  const icon = await fetchModrinthIcon(request.query.url);
  reply.header("Content-Type", icon.contentType);
  reply.header("Cache-Control", "public, max-age=3600");
  return reply.send(icon.bytes);
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

type ModrinthInstallVersionStatus =
  | "recommended"
  | "compatible"
  | "version_mismatch"
  | "wrong_loader"
  | "no_installable_jar"
  | "client_only"
  | "server_support_unknown";

function modrinthServerSideSupported(serverSide?: string) {
  return serverSide === undefined || serverSide === "required" || serverSide === "optional";
}

function classifyModrinthInstallVersion(input: {
  version: ModrinthVersion;
  minecraftVersion: string;
  projectSides: { server_side?: string; client_side?: string };
  recommended: boolean;
  dependencyProjects: Map<string, ModrinthProject>;
}) {
  const file = modrinthJarFile(input.version);
  const hasFabric = input.version.loaders.includes("fabric");
  const matchesMinecraft = input.version.game_versions.includes(input.minecraftVersion);
  const serverSide = input.projectSides.server_side;
  const serverSupported = modrinthServerSideSupported(serverSide);
  const selectable = Boolean(file && hasFabric && serverSupported);
  const compatible = selectable && matchesMinecraft;
  let status: ModrinthInstallVersionStatus = compatible ? "compatible" : "version_mismatch";
  let statusLabel = compatible ? "Compatible" : "Version mismatch";
  let reason = compatible
    ? "Compatible Fabric server mod"
    : `Not marked for Minecraft ${input.minecraftVersion}`;

  if (!file) {
    status = "no_installable_jar";
    statusLabel = "No installable jar";
    reason = "No installable .jar file was found";
  } else if (!hasFabric) {
    status = "wrong_loader";
    statusLabel = "Wrong loader";
    reason = "This version is not for Fabric";
  } else if (serverSide === "unsupported") {
    status = "client_only";
    statusLabel = "Client-only";
    reason = "Server-side support is unsupported";
  } else if (serverSide === "unknown") {
    status = "server_support_unknown";
    statusLabel = "Server support unknown";
    reason = "Server-side support could not be verified";
  } else if (input.recommended) {
    status = "recommended";
    statusLabel = "Recommended";
  }

  return {
    id: input.version.id,
    versionNumber: input.version.version_number,
    releaseChannel: versionChannel(input.version.version_type),
    publishedAt: input.version.date_published,
    minecraftVersions: input.version.game_versions,
    loaders: input.version.loaders,
    file: file ? {
      filename: file.filename,
      size: file.size,
      hashes: file.hashes
    } : undefined,
    compatible,
    selectable,
    requiresMinecraftAcknowledgement: selectable && !matchesMinecraft,
    status,
    statusLabel,
    reason,
    dependencies: (input.version.dependencies ?? []).map((dependency) => {
      const project = dependency.project_id ? input.dependencyProjects.get(dependency.project_id) : undefined;
      return {
        projectId: dependency.project_id,
        versionId: dependency.version_id,
        dependencyType: dependency.dependency_type || "required",
        title: project?.title,
        iconUrl: modrinthIconProxyUrl(project?.icon_url)
      };
    })
  };
}

app.get<{ Params: { projectId: string }; Querystring: { serverId?: string; channel?: ReleaseChannel } }>("/api/modrinth/projects/:projectId/versions", async (request) => {
  await requireRequestPermission(request, "mods.view");
  const projectId = validateModrinthProjectId(request.params.projectId);
  const server = await getServer(request.query.serverId);
  const targetRuntime = runtimeTarget(server);
  if (!targetRuntime.minecraftVersion || targetRuntime.loader !== "fabric") {
    throw new Error("A resolved Fabric runtime profile is required before reviewing mod versions");
  }
  const selectedChannel = optionalReleaseChannel(request.query.channel);
  const startedAt = Date.now();
  logDebug({ ...serverLogFields(server), projectId, channel: selectedChannel, action: "modrinth_project_versions" }, "Modrinth project versions started");

  try {
    const [project, versions] = await Promise.all([
      fetchProject(projectId) as Promise<ModrinthProject>,
      fetchProjectVersions(projectId)
    ]);
    const allowedVersions = versions.filter((version) => allowedForChannel(version, selectedChannel));
    const dependencyProjectIds = Array.from(new Set(allowedVersions.flatMap((version) => (
      version.dependencies ?? []
    )).map((dependency) => dependency.project_id).filter((id): id is string => Boolean(id)))).slice(0, 40);
    const dependencyProjects = new Map<string, ModrinthProject>();
    await Promise.all(dependencyProjectIds.map(async (dependencyProjectId) => {
      try {
        dependencyProjects.set(dependencyProjectId, await fetchProject(dependencyProjectId) as ModrinthProject);
      } catch {
        // Dependency names are helpful for the modal, but should not block version selection.
      }
    }));
    const projectSides = {
      server_side: project.server_side,
      client_side: project.client_side
    };
    const firstCompatibleId = allowedVersions.find((version) => (
      version.loaders.includes("fabric")
      && version.game_versions.includes(targetRuntime.minecraftVersion!)
      && modrinthJarFile(version)
      && modrinthServerSideSupported(project.server_side)
    ))?.id;
    const classified = allowedVersions.map((version) => classifyModrinthInstallVersion({
      version,
      minecraftVersion: targetRuntime.minecraftVersion!,
      projectSides,
      recommended: version.id === firstCompatibleId,
      dependencyProjects
    }));
    const compatibleVersions = classified.filter((version) => version.compatible);
    const otherVersions = classified.filter((version) => !version.compatible);

    logInfo({ ...serverLogFields(server), projectId, resultCount: classified.length, durationMs: durationSince(startedAt), action: "modrinth_project_versions", status: "versions_found" }, "Modrinth project versions completed");
    return {
      project: {
        id: projectId,
        title: project.title,
        description: project.description,
        iconUrl: modrinthIconProxyUrl(project.icon_url),
        clientSide: project.client_side,
        serverSide: project.server_side
      },
      target: {
        serverId: server.id,
        serverName: server.displayName,
        minecraftVersion: targetRuntime.minecraftVersion,
        loader: targetRuntime.loader
      },
      channel: selectedChannel,
      compatibleVersions,
      otherVersions
    };
  } catch (error) {
    logError({ ...serverLogFields(server), projectId, durationMs: durationSince(startedAt), action: "modrinth_project_versions", status: "failed", ...errorLogFields(error) }, "Modrinth project versions failed");
    throw error;
  }
});

app.get<{ Querystring: { query?: string; serverId?: string; channel?: ReleaseChannel; compatibility?: string; offset?: string; limit?: string } }>("/api/modrinth/search", async (request) => {
  await requireRequestPermission(request, "mods.view");
  const query = request.query.query?.trim();
  if (!query) {
    return { hits: [], status: "no_project_found" };
  }
  const server = await getServer(request.query.serverId);
  const targetRuntime = runtimeTarget(server);
  if (!targetRuntime.minecraftVersion || targetRuntime.loader !== "fabric") {
    throw new Error("A resolved Fabric runtime profile is required before searching compatible mods");
  }
  const minecraftVersion = targetRuntime.minecraftVersion;
  const selectedChannel = optionalReleaseChannel(request.query.channel);
  const compatibilityFilter = optionalCompatibilityFilter(request.query.compatibility);
  const startedAt = Date.now();
  logDebug({ ...serverLogFields(server), queryLength: query.length, channel: selectedChannel, compatibilityFilter, action: "modrinth_search" }, "Modrinth search started");

  try {
    const url = new URL("https://api.modrinth.com/v2/search");
    url.searchParams.set("query", query);
    const limit = request.query.limit ? String(parseInt(request.query.limit, 10)) : "20";
    url.searchParams.set("limit", limit);
    if (request.query.offset) {
      const offset = String(parseInt(request.query.offset, 10));
      url.searchParams.set("offset", offset);
    }

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
        icon_url: modrinthIconProxyUrl(hit.icon_url),
        compatibility: await resolveModrinthProjectCompatibility({
          projectId,
          minecraftVersion,
          loader: targetRuntime.loader,
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

app.post<{ Body: { serverId?: string; projectId?: string; versionId?: string; channel?: ReleaseChannel; forceIncompatible?: boolean; overrideMinecraftVersion?: boolean } }>("/api/modrinth/install", modChangeRateLimit, async (request) => {
  await requireRequestPermission(request, "mods.install");
  const server = await getServer(request.body.serverId);
  return runtimeForServer(server).installMod(server, request.body);
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
  onlinePlayerCount,
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
    async (server) => {
      await updateServers((servers) => {
        const index = servers.findIndex((candidate) => candidate.id === server.id);
        if (index === -1) throw new Error("Server not found");
        servers[index] = server;
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
  const errorDetails = error instanceof Error && "details" in error && typeof error.details === "string" ? error.details : undefined;
  const publicMessage = statusCode >= 500 ? "Internal server error" : error instanceof Error ? error.message : "Request failed";
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
    error: publicMessage,
    message: publicMessage,
    code: errorCode,
    errorDetails,
    statusCode
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
  appVersion,
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
