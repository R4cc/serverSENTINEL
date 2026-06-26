import Fastify from "fastify";
import type { FastifyBaseLogger, FastifyRequest } from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readFile, realpath, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
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
  latestCompatibleProjectVersion,
  minecraftVersionsInclude,
  modrinthJarFile,
  modrinthServerSideSupported,
  modrinthVersionIsNewer,
  normalizeReleaseChannel,
  resolveSelectedProjectVersion,
  unknownCompatibility,
  versionChannel
} from "./modrinth/compatibility.js";
import { configureModrinthApiKeyProvider, modrinthFetch } from "./modrinth/modrinthClient.js";
import { createModUpdatePlan, executeSafeUpdatePlan, type ModUpdatePlan, type SafeBatchUpdateResult } from "./modrinth/updatePlan.js";
import { LocalNodeRuntime } from "./nodes/localNodeRuntime.js";
import type { CreateNodeResponse, NodeInstallInstructions } from "./nodes/apiTypes.js";
import { buildNodeInstallInstructions } from "./nodes/installInstructions.js";
import { PanelNodeConnections } from "./nodes/panelConnections.js";
import { nodeAdvertisesCapability, nodeProtocolVersion, normalizeNodeHello } from "./nodes/protocol.js";
import type { NodeHello, PanelWelcome } from "./nodes/protocol.js";
import { NodeRuntimeRegistry } from "./nodes/registry.js";
import { RemoteNodeRuntime } from "./nodes/remoteNodeRuntime.js";
import { newNodeSecret } from "./nodes/nodeAgent.js";
import type { NodeRuntime } from "./nodes/types.js";
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
  normalizePermissions,
  permissionsForRolePreset,
  requirePermission as requireUserPermission,
  rolePresetFromUnknown
} from "./permissions.js";
import { registerStaticFrontend } from "./staticFrontend.js";
import { registerAuthRoutes } from "./routes/authRoutes.js";
import { ResourceStatsCollector } from "./resourceStatsCollector.js";
import { asArray, asObject, optionalString, requiredString } from "./storage/valueValidation.js";
import { openStorageDatabase } from "./storage/database.js";
import { initializeRuntimeDataRoot } from "./storage/runtimePaths.js";
import { defaultServerContainerName, isInsideServersDirectory, newServerId, serverDirectory, serverStorageName } from "./storage/serverIdentity.js";
import { normalizeStoredUser, UsersRepository, validateUsername } from "./storage/usersRepository.js";
import { NodesRepository, normalizeNode } from "./storage/nodesRepository.js";
import { SettingsRepository } from "./storage/settingsRepository.js";
import { SessionsRepository } from "./storage/sessionsRepository.js";
import { ServersRepository } from "./storage/serversRepository.js";
import { FileEditLeasesRepository } from "./storage/fileEditLeasesRepository.js";
import { ResourceStatsRepository } from "./storage/resourceStatsRepository.js";
import { ModPreferencesRepository } from "./storage/modPreferencesRepository.js";
import { OperationsRepository } from "./storage/operationsRepository.js";
import {
  applyImportArtifact,
  createExportArtifact,
  exportArtifactFilename,
  exportDownloadStream,
  parseExportArtifactBase64,
  validateImportArtifact,
  writeExportArtifact
} from "./importExport.js";
import { apiErrorResponse, errorStatusCode, publicApiError } from "./http/errors.js";
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
  validateOperationId,
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
  OperationRecord,
  OperationStatus,
  OperationType,
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
  normalizePublicFilePath,
  parseDockerPorts,
  safeInstalledModFilename,
  safeModFilename,
  validateExistingInsideServer,
  validateExistingResolvedInsideServer,
  validateCron,
  AsyncQueue
} from "./core.js";

const localNodeId = "local";
const appVersion = process.env.npm_package_version ?? "0.8.0";
const nodeImageRepository = "nl2109/serversentinel";
const nodeImage = config.nodeImage || `${nodeImageRepository}:latest`;
const versionMetadataFilename = ".serversentinel-version.json";

const serverSideEffectsQueue = new AsyncQueue();
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

type VersionMetadata = {
  minecraftVersion?: string;
  fabricLoaderVersion?: string;
  createdAt?: string;
  updatedAt?: string;
};

function runtimeSelection(input: unknown) {
  const runtime = asObject(input, "runtime");
  const loader = optionalString(runtime.loader, "runtime.loader") || "fabric";
  if (loader !== "fabric") {
    throw new Error("Only Fabric runtime profiles are supported");
  }
  return {
    loader,
    minecraftVersion: optionalString(runtime.minecraftVersion, "runtime.minecraftVersion"),
    loaderVersion: optionalString(runtime.loaderVersion, "runtime.loaderVersion"),
    serverJar: runtime.serverJar === undefined ? undefined : validateRuntimeJarFilename(runtime.serverJar)
  };
}

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

const activeProvisionPortReservations = new Map<string, ProvisionPortReservation>();
let usersRepository: UsersRepository;
let nodesRepository: NodesRepository;
let settingsRepository: SettingsRepository;
let sessionsRepository: SessionsRepository;
let serversRepository: ServersRepository;
let fileEditLeasesRepository: FileEditLeasesRepository;
let modPreferencesRepository: ModPreferencesRepository;
let operationsRepository: OperationsRepository;
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
const resourceStatsPollMs = 5_000;
const resourceStatsHistoryWindowMs = 60 * 60 * 1000;

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
  return usersRepository.list();
}

async function modrinthApiKey() {
  return settingsRepository.get().modrinthApiKey || process.env.MODRINTH_API_KEY || "";
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
  const session = sessionsRepository.find(sessionId);
  if (!session) return null;
  if (sessionExpired(session)) {
    sessionsRepository.delete(sessionId);
    return null;
  }
  const users = await readUsers();
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
  const nodes = nodesRepository.list();
  const normalized = nodes.map(normalizeNode).filter((node) => config.runtimeMode !== "panel" || (!node.isInternal && node.type !== "local" && node.id !== localNodeId));
  const changed = config.runtimeMode === "all-in-one" ? ensureDefaultInternalNode(normalized) : normalized.length !== nodes.length;
  if (changed) {
    nodesRepository.update((stored) => stored.splice(0, stored.length, ...normalized));
  }
  return normalized;
}

function fileLeaseOwner(request: { headers: { cookie?: string } }, user: StoredUser) {
  const sessionId = parseCookies(request.headers.cookie).get(sessionCookieName);
  if (!sessionId) {
    const error = new Error("Authentication required") as Error & { statusCode?: number };
    error.statusCode = 401;
    throw error;
  }
  return { userId: user.id, sessionId, displayName: user.username };
}

export function fileContentRevision(content: string) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function fileRevisionConflict(): never {
  const error = new Error("The file changed after editing began. Reload it before making more changes.") as Error & {
    statusCode?: number;
    code?: string;
  };
  error.statusCode = 409;
  error.code = "file_revision_conflict";
  throw error;
}

export function assertFileRevision(requested: string | undefined, acquired: string, current: string) {
  if (!requested || requested !== acquired || current !== acquired) fileRevisionConflict();
}

async function readFileWithRevision(runtime: NodeRuntime, server: ManagedServer, target: string) {
  const result = await runtime.readFile(server, target) as { path?: string; content?: string; modifiedAt?: string };
  if (typeof result.content !== "string") throw new Error("File content is unavailable");
  return { ...result, content: result.content, revision: fileContentRevision(result.content) };
}

function publicFileEditLease(lease: import("./types.js").FileEditLease) {
  const { sessionId: _sessionId, ...publicLease } = lease;
  return publicLease;
}

async function fileEditLockPath(runtime: NodeRuntime, server: ManagedServer, target: string) {
  if (server.nodeId === localNodeId) {
    const [root, realTarget] = await Promise.all([realpath(server.serverDir), realpath(target)]);
    const relativePath = relative(root, realTarget).replaceAll("\\", "/");
    return normalizePublicFilePath(relativePath ? `/${relativePath}` : "/");
  }
  return normalizePublicFilePath(runtime.publicPath(server, target));
}

async function updateNodes(updater: (nodes: ManagedNode[]) => void) {
  nodesRepository.update((stored) => {
    const nodes = stored.map(normalizeNode).filter((node) => config.runtimeMode !== "panel" || (!node.isInternal && node.type !== "local" && node.id !== localNodeId));
    if (config.runtimeMode === "all-in-one") ensureDefaultInternalNode(nodes);
    updater(nodes);
    const normalized = nodes.map(normalizeNode).filter((node) => config.runtimeMode !== "panel" || (!node.isInternal && node.type !== "local" && node.id !== localNodeId));
    if (config.runtimeMode === "all-in-one") ensureDefaultInternalNode(normalized);
    stored.splice(0, stored.length, ...normalized);
  });
}

let runtimeRegistry: NodeRuntimeRegistry | undefined;
let resourceStatsCollector: ResourceStatsCollector | undefined;

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
  try {
    const jarPath = await validateExistingInsideServer(server, runtimeTarget(server).serverJar);
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
  const availableNodes = nodes ?? await readNodes();
  const node = findServerNode(server, availableNodes);
  return {
    id: server.id,
    nodeId: server.nodeId,
    displayName: server.displayName,
    storageName: server.storageName,
    dockerContainer: server.dockerContainer,
    dockerImage: server.dockerImage,
    dockerPorts: server.dockerPorts,
    javaArgs: server.javaArgs,
    restartRequiredSince: server.restartRequiredSince,
    schedules: (server.schedules ?? []).map(publicSchedule),
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
    directoryLabel: server.storageName || server.id,
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
    restartRequiredSince: optionalString(server.restartRequiredSince, "server.restartRequiredSince"),
    schedules: server.schedules === undefined ? undefined : asArray(server.schedules, "server.schedules").map(normalizeSchedule),
    createdAt: requiredString(server.createdAt, "server.createdAt"),
    updatedAt: requiredString(server.updatedAt, "server.updatedAt")
  };
}

async function readServers() {
  return serversRepository.list();
}

function listManagedServers() {
  return readServers();
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
  const servers = await listManagedServers();
  const server = serverId ? servers.find((candidate) => candidate.id === serverId) : servers[0];
  if (!server) {
    throw new Error("No managed server instance is registered");
  }
  return server;
}

function ensureManagedServerDirectory(server: ManagedServer) {
  const serverDir = resolve(server.serverDir);
  if (!isInsideServersDirectory(config.serversDir, serverDir)) {
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
    headers: { "User-Agent": "ServerSentinel/0.8.0 (Fabric mod manager)" }
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
    headers: { "User-Agent": "ServerSentinel/0.8.0 (Fabric mod manager)" }
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

async function ensureModrinthIconForFile(server: ManagedServer, filename: string, filePath: string, metadata?: InstalledModMetadata) {
  if (await modIconUrl(server, filename)) return;
  try {
    if (metadata?.projectId) {
      const project = await fetchProject(metadata.projectId) as { icon_url?: string | null };
      await saveModIcon(server, filename, project.icon_url);
      return;
    }
    const safeFilePath = await validateExistingResolvedInsideServer(server, filePath);
    const hash = createHash("sha1").update(await readFile(safeFilePath)).digest("hex");
    const versionResponse = await modrinthFetch(`https://api.modrinth.com/v2/version_file/${hash}?algorithm=sha1`);
    const version = await versionResponse.json() as { project_id?: string };
    if (!version.project_id) return;
    const project = await fetchProject(version.project_id) as { icon_url?: string | null };
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
  const existingConflict = findExistingServerPortConflict(await listManagedServers(), nodeId, dockerPorts, options.ignoreServerId);
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
  return validateDockerContainerName(defaultServerContainerName(server.id));
}

function dockerControlConfigured(server: ManagedServer) {
  return Boolean(server.dockerContainer || (server.dockerMountSource && runtimeTarget(server).serverJar));
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
      controllable: Boolean(server.dockerMountSource && runtimeTarget(server).serverJar),
      state: "unknown" as DockerState,
      container: dockerContainerName(server),
      message: server.dockerMountSource && runtimeTarget(server).serverJar
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
  let inFlight = false;

  const send = (text: string) => {
    if (text && client.readyState === 1) {
      client.send(JSON.stringify({ type: "log", source: "latest.log", text, at: new Date().toISOString() }));
    }
  };

  const poll = async () => {
    if (closed || inFlight) return;
    inFlight = true;
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
    } finally {
      inFlight = false;
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
  const filename = artifact?.filename;
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
      "User-Agent": "ServerSentinel/0.8.0 (Fabric runtime downloader)"
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
    throw new Error("Stop the server before changing mods");
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
  const selectedRuntime = runtimeSelection(input.runtime);
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

  report?.(25, "Resolving Fabric versions");
  const runtimeProfile = await serverJarProvider.resolveFabricServerJar({
    minecraftVersion,
    loaderVersion: selectedRuntime.loaderVersion || "latest",
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
  await assertNodePortsAvailable(localNodeId, dockerPorts, { ignoreJobId: jobId });
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
    serversRepository.create(server);
    report?.(100, "Server setup complete");
    logInfo({ ...serverLogFields(server), jobId, durationMs: durationSince(startedAt), status: "succeeded" }, "Provisioning succeeded");
    return server;
  } catch (error) {
    logError({ ...serverLogFields(server), jobId, durationMs: durationSince(startedAt), status: "failed", ...errorLogFields(error) }, "Provisioning failed");
    throw error;
  }
}

function operationErrorMessage(error: unknown, fallback = "Operation failed") {
  return error instanceof Error ? error.message : fallback;
}

function optionalOperationStatus(value: unknown): OperationStatus | undefined {
  if (value === undefined) return undefined;
  if (value === "queued" || value === "running" || value === "succeeded" || value === "failed" || value === "cancelled") {
    return value;
  }
  throw new Error("Operation status must be queued, running, succeeded, failed, or cancelled");
}

async function recordOperation<T>(
  input: {
    type: OperationType;
    serverId?: string;
    nodeId?: string;
    createdBy?: string;
    task: string;
    runningTask?: string;
    successTask?: string;
    serverIdFromResult?: (value: T) => string | undefined;
    result?: (value: T) => unknown;
    markRestartRequiredOnSuccess?: boolean | ((value: T) => boolean);
    clearRestartRequiredOnSuccess?: boolean;
  },
  action: (operation: OperationRecord) => Promise<T>
) {
  const operation = operationsRepository.create({
    type: input.type,
    serverId: input.serverId,
    nodeId: input.nodeId,
    createdBy: input.createdBy,
    task: input.task
  });
  operationsRepository.start(operation.id, { progress: 5, task: input.runningTask ?? input.task });
  try {
    const result = await action(operation);
    const resultServerId = input.serverIdFromResult?.(result);
    const affectedServerId = resultServerId ?? input.serverId;
    const shouldMarkRestartRequired = typeof input.markRestartRequiredOnSuccess === "function"
      ? input.markRestartRequiredOnSuccess(result)
      : input.markRestartRequiredOnSuccess;
    if (affectedServerId && shouldMarkRestartRequired) {
      serversRepository.markRestartRequired(affectedServerId);
    }
    if (affectedServerId && input.clearRestartRequiredOnSuccess) {
      serversRepository.clearRestartRequired(affectedServerId);
    }
    operationsRepository.succeed(operation.id, {
      serverId: resultServerId,
      progress: 100,
      task: input.successTask ?? "Operation complete",
      result: input.result ? input.result(result) : result
    });
    return result;
  } catch (error) {
    operationsRepository.fail(operation.id, operationErrorMessage(error), {
      task: "Operation failed",
      logSummary: detailedErrorMessage(error)
    });
    throw error;
  }
}

function markServerRestartRequired(serverId: string) {
  serversRepository.markRestartRequired(serverId);
}

function isRestartSensitivePath(server: ManagedServer, runtime: NodeRuntime, absolutePath: string) {
  return runtime.isServerSettingsFile(server, absolutePath) || runtime.isModsPath(server, absolutePath);
}

function serverSettingsRestartRequired(before: ManagedServer, after: ManagedServer) {
  return JSON.stringify(runtimeProfileForServer(before)) !== JSON.stringify(runtimeProfileForServer(after))
    || before.dockerContainer !== after.dockerContainer
    || before.dockerImage !== after.dockerImage
    || before.dockerPorts !== after.dockerPorts
    || JSON.stringify(before.managedPorts ?? []) !== JSON.stringify(after.managedPorts ?? [])
    || before.javaArgs !== after.javaArgs;
}

async function startProvisionOperation(input: CreateServerInput, createdBy: string) {
  const nodeId = input.nodeId?.trim() || (config.runtimeMode === "all-in-one" ? localNodeId : "");
  if (!nodeId) {
    throw new Error("nodeId is required when ServerSentinel runs in panel mode");
  }
  const { dockerPorts, queryPort } = normalizeCreateServerPorts(input, await listManagedServers(), nodeId);
  await assertNodePortsAvailable(nodeId, dockerPorts);
  input.dockerPorts = dockerPorts;
  input.queryPort = String(queryPort);
  const operation = operationsRepository.create({
    type: "server.create",
    nodeId,
    createdBy,
    progress: 0,
    task: "Queued server setup"
  });
  operationsRepository.start(operation.id, { progress: 0, task: "Queued server setup" });
  activeProvisionPortReservations.set(operation.id, {
    nodeId,
    dockerPorts,
    displayName: input.displayName?.trim() || "unnamed server"
  });
  logInfo({ operationId: operation.id, serverName: input.displayName?.trim() }, "Provisioning operation started");

  void runtimeForNodeId(nodeId).createServer({ ...input, nodeId }, (progress, task) => {
    operationsRepository.update(operation.id, { progress, task });
  }, operation.id).then(async (server) => {
    operationsRepository.succeed(operation.id, {
      serverId: server.id,
      progress: 100,
      task: "Server setup complete",
      result: { server: await runtimeForServer(server).publicServer(server) }
    });
  }).catch((error: unknown) => {
    logError({ operationId: operation.id, nodeId, serverName: input.displayName?.trim(), errorDetails: detailedErrorMessage(error), ...errorLogFields(error) }, "Provisioning operation failed");
    operationsRepository.fail(operation.id, operationErrorMessage(error, "Server setup failed"), {
      task: "Server setup failed",
      logSummary: detailedErrorMessage(error)
    });
  }).finally(() => {
    activeProvisionPortReservations.delete(operation.id);
  });

  return operationsRepository.find(operation.id)!;
}

function selectedExportServerIds(value: unknown) {
  if (value === undefined) return undefined;
  return asArray(value, "serverIds").map((id) => validateServerId(id));
}

function targetNodeIdFromBody(value: unknown) {
  const targetNodeId = typeof value === "string" ? value.trim() : "";
  if (!targetNodeId) {
    throw new Error("targetNodeId is required");
  }
  return targetNodeId;
}

async function startExportOperation(input: { serverIds?: string[] }, createdBy: string) {
  const operation = operationsRepository.create({
    type: "export.run",
    createdBy,
    progress: 0,
    task: "Queued export"
  });
  operationsRepository.start(operation.id, { progress: 0, task: "Preparing export" });
  void (async () => {
    try {
      const artifact = await createExportArtifact({
        appVersion,
        settings: settingsRepository.get(),
        nodes: await readNodes(),
        servers: await listManagedServers(),
        selectedServerIds: input.serverIds,
        modPreferencesForServer: (serverId) => modPreferencesRepository.list(serverId),
        report: (progress, task) => operationsRepository.update(operation.id, { progress, task })
      });
      const written = await writeExportArtifact(join(config.exportsDir, exportArtifactFilename(operation.id)), artifact);
      operationsRepository.succeed(operation.id, {
        progress: 100,
        task: "Export ready",
        result: {
          artifact: {
            filename: written.filename,
            size: written.size,
            sha256: written.sha256,
            downloadUrl: `/api/exports/${operation.id}/download`
          },
          artifactPath: written.path,
          serverCount: artifact.servers.length,
          serverFileCount: artifact.manifest.content.serverFiles
        }
      });
    } catch (error) {
      logError({ operationId: operation.id, action: "export", status: "failed", ...errorLogFields(error) }, "Export operation failed");
      operationsRepository.fail(operation.id, operationErrorMessage(error, "Export failed"), {
        task: "Export failed",
        logSummary: detailedErrorMessage(error)
      });
    }
  })();
  return operationsRepository.find(operation.id)!;
}

async function startImportOperation(input: { artifactBase64: string; targetNodeId: string; importInstanceSettings?: boolean }, createdBy: string) {
  const operation = operationsRepository.create({
    type: "import.run",
    nodeId: input.targetNodeId,
    createdBy,
    progress: 0,
    task: "Queued import"
  });
  operationsRepository.start(operation.id, { progress: 0, task: "Validating import" });
  void (async () => {
    try {
      const artifact = parseExportArtifactBase64(input.artifactBase64);
      const result = await applyImportArtifact(artifact, {
        targetNodeId: input.targetNodeId,
        nodes: await readNodes(),
        existingServers: await listManagedServers(),
        serversDir: config.serversDir,
        tmpDir: config.tmpDir,
        serversRepository,
        modPreferencesRepository,
        settingsRepository,
        importInstanceSettings: input.importInstanceSettings,
        report: (progress, task) => operationsRepository.update(operation.id, { progress, task })
      });
      operationsRepository.succeed(operation.id, {
        progress: 100,
        task: "Import complete",
        result
      });
    } catch (error) {
      logError({ operationId: operation.id, action: "import", status: "failed", ...errorLogFields(error) }, "Import operation failed");
      operationsRepository.fail(operation.id, operationErrorMessage(error, "Import failed"), {
        task: "Import failed",
        logSummary: detailedErrorMessage(error)
      });
    }
  })();
  return operationsRepository.find(operation.id)!;
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
  const servers = await listManagedServers();
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
        const operation = operationsRepository.create({
          type: "schedule.run",
          serverId: server.id,
          nodeId: server.nodeId,
          task: `Running schedule ${schedule.name}`,
          progress: 0
        });
        operationsRepository.start(operation.id, { progress: 10, task: `Running schedule ${schedule.name}` });
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
        serversRepository.recordScheduledRun(server.id, schedule.id, run);
        if (result.status === "failed") {
          operationsRepository.fail(operation.id, result.message, {
            progress: 100,
            task: "Schedule run failed",
            result: { scheduleId: schedule.id, run }
          });
        } else {
          operationsRepository.succeed(operation.id, {
            progress: 100,
            task: result.status === "skipped" ? "Schedule run skipped" : "Schedule run complete",
            result: { scheduleId: schedule.id, run }
          });
        }
      } finally {
        runningSchedules.delete(key);
      }
    }
  }

}

async function localUpdateServer(serverId: string, input: unknown) {
  const body = input as {
    displayName?: string;
    runtime?: CreateServerInput["runtime"];
    dockerContainer?: string;
    dockerImage?: string;
    dockerPorts?: string;
    queryPort?: string;
    javaArgs?: string;
    serverPort?: string;
  };
  let updatedServer: ManagedServer | null = null;
  await serverSideEffectsQueue.enqueue(async () => {
    const servers = await readServers();
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
    const selectedRuntime = body.runtime === undefined ? undefined : runtimeSelection(body.runtime);
    const minecraftVersion = selectedRuntime?.minecraftVersion || currentRuntime.minecraftVersion;
    if (!minecraftVersion) {
      throw new Error("Minecraft version is required");
    }
    const requestedLoaderVersion = selectedRuntime?.loaderVersion || currentRuntime.loaderVersion || "latest";
    const serverJar = selectedRuntime?.serverJar || currentRuntime.jarArtifact.filename || "fabric-server-launch.jar";
    const shouldResolveRuntime = selectedRuntime?.minecraftVersion !== undefined || selectedRuntime?.loaderVersion !== undefined;
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
    const serverPort = body.serverPort?.trim();
    if (serverPort && !isValidServerPort(serverPort)) {
      throw new Error(`Server port must be between ${minServerPort} and ${maxServerPort}`);
    }
    const dockerContainer = validateDockerContainerName(body.dockerContainer?.trim() || current.dockerContainer || defaultServerContainerName(current.id));
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

    const jarChanged = currentRuntime.minecraftVersion !== minecraftVersion
      || currentRuntime.loaderVersion !== runtimeProfile.loaderVersion
      || currentRuntime.jarArtifact.filename !== serverJar
      || current.runtimeProfile.jarArtifact.downloadUrl !== runtimeProfile.jarArtifact.downloadUrl;
    const containerConfigChanged = current.dockerContainer !== dockerContainer
      || current.dockerImage !== dockerImage
      || current.dockerPorts !== dockerPorts
      || current.javaArgs !== javaArgs
      || currentRuntime.jarArtifact.filename !== serverJar;

    const updated: ManagedServer = {
      ...current,
      displayName: body.displayName?.trim() || current.displayName,
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

    serversRepository.replaceMetadata(updated);
    updatedServer = updated;
  });
  return updatedServer!;
}

async function localDeleteServer(server: ManagedServer, input: unknown) {
  const body = input as { confirmName?: string; deleteFiles?: boolean };
  let deletedContainer = false;
  let deletedFiles = false;
  let serverFields: Record<string, unknown> = {};

  await serverSideEffectsQueue.enqueue(async () => {
    const servers = await readServers();
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

    serversRepository.delete(current.id);
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
initializeRuntimeDataRoot(config.paths);
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
const storageDatabase = openStorageDatabase();
usersRepository = new UsersRepository(storageDatabase);
nodesRepository = new NodesRepository(storageDatabase);
settingsRepository = new SettingsRepository(storageDatabase);
sessionsRepository = new SessionsRepository(storageDatabase);
serversRepository = new ServersRepository(storageDatabase, normalizeManagedServer);
fileEditLeasesRepository = new FileEditLeasesRepository(storageDatabase);
modPreferencesRepository = new ModPreferencesRepository(storageDatabase);
operationsRepository = new OperationsRepository(storageDatabase);
const recoveredOperations = operationsRepository.failIncompleteOnStartup();
if (recoveredOperations > 0) {
  logWarn({ operationCount: recoveredOperations }, "Recovered incomplete operations after startup");
}
configureModrinthApiKeyProvider(modrinthApiKey);
app.addHook("onClose", async () => {
  storageDatabase.close();
});
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

// WebSocket endpoints intentionally do not use the JSON API error envelope:
// /api/nodes/connect is the node-agent handshake, and /ws/console streams terminal frames.
registerAuthRoutes(app, {
  authRateLimit,
  destructiveRateLimit,
  sessions: sessionsRepository,
  users: usersRepository,
  sessionCookieName,
  sessionMaxAgeSeconds,
  parseCookies,
  sessionCookie,
  currentUserFromCookie,
  requireRequestPermission,
  validateUsername,
  validatePassword,
  normalizeRolePreset,
  buildUserPermissions,
  hashPassword,
  verifyPassword,
  publicUser,
  demoEnabled: config.enableDemo,
  logInfo,
  logWarn
});

function isDemoModeRequest(request: { headers: Record<string, unknown> }) {
  return config.enableDemo && request.headers["x-serversentinel-demo-mode"] === "true";
}

app.addHook("preHandler", async (request) => {
  if (!request.raw.url?.startsWith("/api/") || request.raw.url.startsWith("/api/auth/")) {
    return;
  }
  if (request.raw.url.startsWith("/api/nodes/connect")) {
    return;
  }
  const demoMode = isDemoModeRequest(request);
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
  const demoMode = isDemoModeRequest(request);
  const user = demoMode ? null : await requireRequestPermission(request, "servers.view");
  const servers = await listManagedServers();
  const nodes = await readNodes();
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
  return { nodes: await publicNodes(await readNodes()) };
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
  nodesRepository.create(node);
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
  nodesRepository.create(node);
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
  const updatedNode = nodesRepository.updateById(request.params.nodeId, (node) => {
    if (node.isInternal) {
      throw new Error("Internal node tokens cannot be rotated");
    }
    return {
      ...node,
      joinTokenHash: hashNodeSecret(token.joinToken),
      joinTokenExpiresAt: token.expiresAt,
      updatedAt: new Date().toISOString()
    };
  });
  return {
    node: publicNode(updatedNode),
    joinToken: token.joinToken,
    expiresAt: token.expiresAt,
    install: nodeInstallInstructions({ panelUrl, joinToken: token.joinToken, dataMount, nodeName: updatedNode.name })
  };
});

app.get<{ Params: { nodeId: string }; Querystring: { panelUrl?: string; dataMount?: string } }>("/api/nodes/:nodeId/install", async (request) => {
  await requireRequestPermission(request, "servers.view");
  const panelUrl = optionalNodePanelUrl(request.query.panelUrl);
  const dataMount = optionalNodeDataMount(request.query.dataMount);
  const node = (await readNodes()).find((candidate) => candidate.id === request.params.nodeId);
  if (!node) nodeNotFound(request.params.nodeId);
  return {
    node: publicNode(node),
    install: nodeInstallInstructions({ panelUrl, dataMount, nodeName: node.name })
  };
});

app.post<{ Params: { nodeId: string }; Body: { image?: string } }>("/api/nodes/:nodeId/update", destructiveRateLimit, async (request) => {
  await requireRequestPermission(request, "users.manage");
  const body = request.body ?? {};
  const node = (await readNodes()).find((candidate) => candidate.id === request.params.nodeId);
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
  const result = await panelNodeConnections.request(node, "node.update", { image }, 30_000);
  const updateResult = result as { ok?: boolean; mode?: string };
  if (updateResult.ok && updateResult.mode === "self") {
    const connectedAt = node.connectedAt;
    const now = new Date().toISOString();
    await updateNodes((nodes) => {
      const current = nodes.find((candidate) => candidate.id === node.id);
      if (!current || current.connectedAt !== connectedAt) return;
      current.status = "offline";
      current.updatedAt = now;
    });
  }
  return result;
});

app.post<{ Params: { nodeId: string } }>("/api/nodes/:nodeId/restart", destructiveRateLimit, async (request) => {
  await requireRequestPermission(request, "users.manage");
  const node = (await readNodes()).find((candidate) => candidate.id === request.params.nodeId);
  if (!node) nodeNotFound(request.params.nodeId);
  if (node.isInternal) {
    if (!dockerAvailable()) {
      throw new Error("Docker socket is not mounted on the panel container. Mount the Docker socket to restart the panel container.");
    }
    const containerId = process.env.HOSTNAME || "";
    if (!containerId) {
      throw new Error("Could not determine the panel container ID.");
    }
    setTimeout(() => {
      void dockerRequest("POST", `/containers/${encodeURIComponent(containerId)}/restart?t=10`, 204).catch((error) => {
        console.error(`Panel self-restart failed: ${(error as Error).message}`);
      });
    }, 500);
    return {
      ok: true,
      message: "Panel container restart started. The panel will reconnect shortly."
    };
  }

  if (node.status !== "online") {
    throw new Error("Node is offline.");
  }
  if (!panelNodeConnections.isConnected(node.id)) {
    throw new Error("Node is not connected to the panel right now.");
  }

  const result = await panelNodeConnections.request(node, "node.restart", {}, 30_000);
  const restartResult = result as { ok?: boolean };
  if (restartResult.ok) {
    const connectedAt = node.connectedAt;
    const now = new Date().toISOString();
    await updateNodes((nodes) => {
      const current = nodes.find((candidate) => candidate.id === node.id);
      if (!current || current.connectedAt !== connectedAt) return;
      current.status = "offline";
      current.updatedAt = now;
    });
  }
  return result;
});

app.delete<{ Params: { nodeId: string }; Querystring: { force?: string } }>("/api/nodes/:nodeId", destructiveRateLimit, async (request) => {
  await requireRequestPermission(request, "users.manage");
  const node = (await readNodes()).find((candidate) => candidate.id === request.params.nodeId);
  if (!node) nodeNotFound(request.params.nodeId);
  if (node.isInternal) {
    throw new Error("Internal node cannot be deleted");
  }
  const servers = await listManagedServers();
  const assignedServers = servers.filter((server) => server.nodeId === request.params.nodeId);
  const force = request.query.force === "true";
  if (assignedServers.length && !force) {
    throw new Error("Cannot delete a node while servers are assigned to it");
  }
  let selfRemoval: { ok: boolean; message: string } = nodeAdvertisesCapability(node, "node.remove") && panelNodeConnections.isConnected(node.id)
    ? { ok: false, message: "Node container self-stop was not attempted." }
    : { ok: false, message: "Node is offline or does not support panel-triggered self-stop. Stop its container manually if it is still running." };
  if (nodeAdvertisesCapability(node, "node.remove") && panelNodeConnections.isConnected(node.id)) {
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
  const { deletedServers } = nodesRepository.deleteWithServers(request.params.nodeId, force);
  panelNodeConnections.disconnect(request.params.nodeId);
  return { ok: true, deletedServers, selfRemoval };
});

app.get<{ Params: { nodeId: string } }>("/api/nodes/:nodeId", async (request, reply) => {
  await requireRequestPermission(request, "servers.view");
  const node = (await readNodes()).find((candidate) => candidate.id === request.params.nodeId);
  if (!node) {
    return reply.code(404).send(apiErrorResponse("NODE_NOT_FOUND", "Node not found"));
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
      hello = normalizeNodeHello(JSON.parse(raw.toString()));
    } catch (error) {
      reject(`Invalid node hello: ${(error as Error).message}`);
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
          name: hello.nodeName,
          status: "online",
          updatedAt: now,
          lastSeenAt: now,
          connectedAt: now,
          agentVersion: hello.agentVersion,
          protocolVersion: hello.protocolVersion,
          capabilities: hello.capabilities,
          dockerStatus: hello.dockerStatus,
          dataPathStatus: hello.dataPathStatus,
          totalMemory: optionalNodeTotalMemory(hello.totalMemory) ?? node.totalMemory,
          compatibility: "compatible"
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
          name: hello.nodeName,
          type: "remote",
          status: "online",
          isInternal: false,
          updatedAt: now,
          lastSeenAt: now,
          connectedAt: now,
          agentVersion: hello.agentVersion,
          protocolVersion: hello.protocolVersion,
          capabilities: hello.capabilities,
          dockerStatus: hello.dockerStatus,
          dataPathStatus: hello.dataPathStatus,
          totalMemory: optionalNodeTotalMemory(hello.totalMemory) ?? node.totalMemory,
          compatibility: "compatible",
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
      compatibility: "compatible"
    };
    ws.send(JSON.stringify(welcome));
    panelNodeConnections.connect(acceptedNode, ws);
    ws.on("close", () => {
      if (panelNodeConnections.isConnected(acceptedNode!.id)) return;
      void updateNodes((nodes) => {
        const node = nodes.find((candidate) => candidate.id === acceptedNode!.id);
        if (node && node.connectedAt === acceptedNode!.connectedAt) {
          node.status = "offline";
          node.updatedAt = new Date().toISOString();
        }
      }).catch(() => {});
    });
  });
});

app.get("/api/context", async (request) => {
  await requireRequestPermission(request, "servers.view");
  const servers = await listManagedServers();
  const nodes = await readNodes();
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
  settingsRepository.setModrinthApiKey(key);
  logInfo({ action: "configure_modrinth", status: "succeeded" }, "Modrinth API configuration updated");
  return { ok: true, modrinthApiConfigured: true };
});

app.get("/api/fabric/versions", async (request) => {
  if (!isDemoModeRequest(request)) {
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
  if (!isDemoModeRequest(request)) {
    await requireRequestPermission(request, "servers.create");
  }
  return { versions: await serverJarProvider.listMinecraftVersions() };
});

app.get<{ Querystring: { minecraftVersion?: string; refresh?: string } }>("/api/runtime/fabric/loader-versions", async (request) => {
  if (!isDemoModeRequest(request)) {
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

app.get<{ Querystring: { serverId?: string; status?: string; limit?: string } }>("/api/operations", async (request) => {
  await requireRequestPermission(request, "servers.view");
  const status = optionalOperationStatus(request.query.status);
  const parsedLimit = request.query.limit ? Number.parseInt(request.query.limit, 10) : undefined;
  const serverId = request.query.serverId ? validateServerId(request.query.serverId) : undefined;
  if (serverId) await getServer(serverId);
  return {
    operations: operationsRepository.list({
      serverId,
      status,
      limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined
    })
  };
});

app.get<{ Params: { id: string } }>("/api/operations/:id", async (request, reply) => {
  await requireRequestPermission(request, "servers.view");
  const operation = operationsRepository.find(validateOperationId(request.params.id));
  if (!operation) {
    return reply.code(404).send(apiErrorResponse("OPERATION_NOT_FOUND", "Operation not found"));
  }
  if (operation.serverId) await getServer(operation.serverId);
  return operation;
});

app.post<{ Params: { id: string } }>("/api/operations/:id/cancel", destructiveRateLimit, async (request, reply) => {
  await requireRequestPermission(request, "servers.editSettings");
  const operation = operationsRepository.cancel(validateOperationId(request.params.id), "Operation cancelled by user");
  if (!operation) {
    return reply.code(404).send(apiErrorResponse("OPERATION_NOT_FOUND", "Operation not found"));
  }
  return operation;
});

app.post<{ Body: { serverIds?: unknown } }>("/api/exports", destructiveRateLimit, async (request) => {
  const user = await requireRequestPermission(request, "servers.view");
  return startExportOperation({
    serverIds: selectedExportServerIds(request.body.serverIds)
  }, user.id);
});

app.get<{ Params: { operationId: string } }>("/api/exports/:operationId/download", async (request, reply) => {
  await requireRequestPermission(request, "servers.view");
  const operation = operationsRepository.find(validateOperationId(request.params.operationId));
  if (!operation || operation.type !== "export.run") {
    return reply.code(404).send(apiErrorResponse("EXPORT_NOT_FOUND", "Export operation not found"));
  }
  if (operation.status !== "succeeded") {
    throw new Error("Export is not ready for download");
  }
  const result = operation.result as { artifactPath?: string; artifact?: { filename?: string; size?: number } } | undefined;
  const artifactPath = result?.artifactPath;
  if (!artifactPath || !isInsideServersDirectory(config.exportsDir, artifactPath)) {
    throw new Error("Export artifact is not available");
  }
  reply.header("content-type", "application/json");
  reply.header("content-disposition", `attachment; filename="${result?.artifact?.filename ?? exportArtifactFilename(operation.id)}"`);
  if (result?.artifact?.size) reply.header("content-length", String(result.artifact.size));
  return reply.send(exportDownloadStream(artifactPath));
});

app.post<{ Body: { artifactBase64?: string; targetNodeId?: string } }>("/api/imports/validate", destructiveRateLimit, async (request) => {
  await requireRequestPermission(request, "servers.create");
  const artifact = parseExportArtifactBase64(request.body.artifactBase64 ?? "");
  return validateImportArtifact(artifact, {
    targetNodeId: typeof request.body.targetNodeId === "string" ? request.body.targetNodeId.trim() : undefined,
    nodes: await readNodes(),
    existingServers: await listManagedServers(),
    serversDir: config.serversDir,
    tmpDir: config.tmpDir
  });
});

app.post<{ Body: { artifactBase64?: string; targetNodeId?: string; importInstanceSettings?: boolean } }>("/api/imports/apply", destructiveRateLimit, async (request) => {
  const user = await requireRequestPermission(request, "servers.create");
  return startImportOperation({
    artifactBase64: request.body.artifactBase64 ?? "",
    targetNodeId: targetNodeIdFromBody(request.body.targetNodeId),
    importInstanceSettings: request.body.importInstanceSettings
  }, user.id);
});

app.post<{
  Body: CreateServerInput;
}>("/api/servers", provisionRateLimit, async (request) => {
  const user = await requireRequestPermission(request, "servers.create");
  const nodeId = request.body.nodeId?.trim() || (config.runtimeMode === "all-in-one" ? localNodeId : "");
  if (!nodeId) throw new Error("nodeId is required when ServerSentinel runs in panel mode");
  const { dockerPorts, queryPort } = normalizeCreateServerPorts(request.body, await listManagedServers(), nodeId);
  await assertNodePortsAvailable(nodeId, dockerPorts);
  request.body.dockerPorts = dockerPorts;
  request.body.queryPort = String(queryPort);
  const server = await recordOperation({
    type: "server.create",
    nodeId,
    createdBy: user.id,
    task: "Creating server",
    runningTask: "Creating server",
    successTask: "Server setup complete",
    serverIdFromResult: (createdServer: ManagedServer) => createdServer.id,
    result: (createdServer: ManagedServer) => ({ serverId: createdServer.id })
  }, (operation) => runtimeForNodeId(nodeId).createServer({ ...request.body, nodeId }, undefined, operation.id));
  logInfo(serverLogFields(server), "Managed server created");
  return runtimeForServer(server).publicServer(server);
});

app.post<{ Body: CreateServerInput }>("/api/servers/provision", provisionRateLimit, async (request) => {
  const user = await requireRequestPermission(request, "servers.create");
  if (!request.body.nodeId && config.runtimeMode === "panel") {
    throw new Error("nodeId is required when ServerSentinel runs in panel mode");
  }
  return startProvisionOperation(request.body, user.id);
});

app.put<{
  Params: { id: string };
  Body: {
    displayName?: string;
    runtime?: CreateServerInput["runtime"];
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
  const servers = await listManagedServers();
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
  if (serverSettingsRestartRequired(server, updatedServer)) {
    markServerRestartRequired(updatedServer.id);
    return runtimeForServer(updatedServer).publicServer(await getServer(updatedServer.id));
  }
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
  const updatedServer: ManagedServer = {
    ...server,
    runtimeProfile: nextProfile,
    updatedAt: new Date().toISOString()
  };
  serversRepository.replaceMetadata(updatedServer);
  return {
    serverId: server.id,
    runtimeProfile: nextProfile,
    server: await runtimeForServer(updatedServer).publicServer(updatedServer),
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
  const user = await requireRequestPermission(request, "servers.control");
  const server = await getServer(request.params.id);
  return recordOperation({
    type: "server.start",
    serverId: server.id,
    nodeId: server.nodeId,
    createdBy: user.id,
    task: "Starting server",
    successTask: "Server started",
    clearRestartRequiredOnSuccess: true
  }, () => runtimeForServer(server).lifecycle(server, "start"));
});

app.post<{ Params: { id: string } }>("/api/servers/:id/stop", runtimeActionRateLimit, async (request) => {
  const user = await requireRequestPermission(request, "servers.control");
  const server = await getServer(request.params.id);
  return recordOperation({
    type: "server.stop",
    serverId: server.id,
    nodeId: server.nodeId,
    createdBy: user.id,
    task: "Stopping server",
    successTask: "Server stopped",
    clearRestartRequiredOnSuccess: true
  }, () => runtimeForServer(server).lifecycle(server, "stop"));
});

app.post<{ Params: { id: string } }>("/api/servers/:id/restart", runtimeActionRateLimit, async (request) => {
  const user = await requireRequestPermission(request, "servers.control");
  const server = await getServer(request.params.id);
  return recordOperation({
    type: "server.restart",
    serverId: server.id,
    nodeId: server.nodeId,
    createdBy: user.id,
    task: "Restarting server",
    successTask: "Server restarted",
    clearRestartRequiredOnSuccess: true
  }, () => runtimeForServer(server).lifecycle(server, "restart"));
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
  const server = await getServer(request.params.id);
  const createdSchedule = scheduleFromBody(request.body);
  serversRepository.createSchedule(server.id, createdSchedule, createdSchedule.updatedAt);
  logInfo({ ...serverLogFields(server), scheduleId: createdSchedule.id, enabled: createdSchedule.enabled, action: "create_schedule" }, "Schedule created");
  return createdSchedule;
});

app.put<{
  Params: { id: string; scheduleId: string };
  Body: { name?: string; cron?: string; commands?: unknown; onlyWhenNoPlayers?: boolean; enabled?: boolean };
}>("/api/servers/:id/schedules/:scheduleId", destructiveRateLimit, async (request) => {
  await requireRequestPermission(request, "schedules.manage");
  const server = await getServer(request.params.id);
  const scheduleId = validateScheduleId(request.params.scheduleId);
  const existing = server.schedules?.find((candidate) => candidate.id === scheduleId);
  if (!existing) throw new Error("Schedule not found");
  const updatedSchedule = scheduleFromBody(request.body, existing);
  serversRepository.updateSchedule(server.id, updatedSchedule, updatedSchedule.updatedAt);
  logInfo({ ...serverLogFields(server), scheduleId: updatedSchedule.id, enabled: updatedSchedule.enabled, action: "update_schedule" }, "Schedule updated");
  return updatedSchedule;
});

app.delete<{ Params: { id: string; scheduleId: string } }>("/api/servers/:id/schedules/:scheduleId", destructiveRateLimit, async (request) => {
  await requireRequestPermission(request, "schedules.manage");
  const server = await getServer(request.params.id);
  const scheduleId = validateScheduleId(request.params.scheduleId);
  serversRepository.deleteSchedule(server.id, scheduleId, new Date().toISOString());
  logInfo({ ...serverLogFields(server), scheduleId, action: "delete_schedule" }, "Schedule deleted");
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
  return resourceStatsCollector
    ? resourceStatsCollector.collectServer(server)
    : runtimeForServer(server).serverStats(server);
});

app.get<{ Params: { id: string } }>("/api/servers/:id/stats/history", async (request) => {
  await requireRequestPermission(request, "servers.view");
  const server = await getServer(request.params.id);
  if (!resourceStatsCollector) {
    const sampledAt = Date.now();
    const stats = await runtimeForServer(server).serverStats(server);
    return {
      samples: [
        stats && typeof stats === "object"
          ? { ...(stats as Record<string, unknown>), sampledAt }
          : {
              available: false,
              running: false,
              cpuPercent: 0,
              memoryUsageBytes: 0,
              memoryLimitBytes: 0,
              readAt: new Date(sampledAt).toISOString(),
              message: "Container stats are unavailable",
              sampledAt
            }
      ]
    };
  }
  return resourceStatsCollector.history(server);
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
  return readFileWithRevision(runtime, server, target);
});

app.post<{ Params: { id: string }; Body: { path?: string; revision?: string } }>("/api/servers/:id/file/lease", destructiveRateLimit, async (request) => {
  const server = await getServer(request.params.id);
  const runtime = runtimeForServer(server);
  const target = await runtime.resolveExistingPath(server, request.body.path ?? "");
  const user = await requireFilePathPermission(request, server, target, runtime.isServerSettingsFile(server, target) ? "servers.editSettings" : "files.edit");
  const file = await readFileWithRevision(runtime, server, target);
  if (!request.body.revision || request.body.revision !== file.revision) fileRevisionConflict();
  const path = await fileEditLockPath(runtime, server, target);
  const lease = fileEditLeasesRepository.acquire({
    serverId: server.id,
    path,
    fileRevision: file.revision,
    owner: fileLeaseOwner(request, user)
  });
  return { lease: publicFileEditLease(lease) };
});

app.post<{ Params: { id: string; leaseId: string } }>("/api/servers/:id/file/lease/:leaseId/heartbeat", async (request) => {
  const user = await requireRequestPermission(request);
  const lease = fileEditLeasesRepository.heartbeat(request.params.leaseId, fileLeaseOwner(request, user));
  if (lease.serverId !== request.params.id) {
    const error = new Error("The edit lease does not belong to this server") as Error & { statusCode?: number; code?: string };
    error.statusCode = 409;
    error.code = "file_edit_lease_lost";
    throw error;
  }
  return { lease: publicFileEditLease(lease) };
});

app.delete<{ Params: { id: string; leaseId: string }; Querystring: { force?: string } }>("/api/servers/:id/file/lease/:leaseId", async (request) => {
  if (request.query.force === "true") {
    await requireRequestPermission(request, "users.manage");
    return { ok: fileEditLeasesRepository.forceRelease(request.params.leaseId, request.params.id) };
  }
  const user = await requireRequestPermission(request);
  return { ok: fileEditLeasesRepository.release(request.params.leaseId, fileLeaseOwner(request, user)) };
});

app.put<{ Params: { id: string }; Body: { path?: string; content?: string; leaseId?: string; revision?: string } }>("/api/servers/:id/file", destructiveRateLimit, async (request) => {
  const server = await getServer(request.params.id);
  const runtime = runtimeForServer(server);
  const target = await runtime.resolveExistingPath(server, request.body.path ?? "");
  const user = await requireFilePathPermission(request, server, target, runtime.isServerSettingsFile(server, target) ? "servers.editSettings" : "files.edit");
  if (!request.body.leaseId) {
    const error = new Error("A valid file edit lease is required") as Error & { statusCode?: number; code?: string };
    error.statusCode = 409;
    error.code = "file_edit_lease_lost";
    throw error;
  }
  const path = await fileEditLockPath(runtime, server, target);
  const owner = fileLeaseOwner(request, user);
  const lease = fileEditLeasesRepository.requireOwned(request.body.leaseId, server.id, path, owner);
  const current = await readFileWithRevision(runtime, server, target);
  assertFileRevision(request.body.revision, lease.fileRevision, current.revision);
  const result = await runtime.writeFile(server, target, request.body.content) as Record<string, unknown>;
  fileEditLeasesRepository.release(lease.leaseId, owner);
  if (isRestartSensitivePath(server, runtime, target)) {
    markServerRestartRequired(server.id);
  }
  return { ...result, revision: fileContentRevision(request.body.content ?? "") };
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
  const result = await runtime.uploadFile(server, parent, filename, request.body.contentBase64);
  if (uploadPermission === "mods.upload") {
    markServerRestartRequired(server.id);
  }
  return result;
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
  const result = await runtime.renameFile(server, source, targetName);
  if (isRestartSensitivePath(server, runtime, source) || isRestartSensitivePath(server, runtime, target)) {
    markServerRestartRequired(server.id);
  }
  return result;
});

app.post<{ Params: { id: string }; Body: { path?: string; name?: string } }>("/api/servers/:id/file/duplicate", destructiveRateLimit, async (request) => {
  const server = await getServer(request.params.id);
  const runtime = runtimeForServer(server);
  const source = await runtime.resolveExistingPath(server, request.body.path ?? "");
  await requireFilePathPermission(request, server, source, runtime.isModsPath(server, source) ? "mods.upload" : "files.upload");
  const result = await runtime.duplicateFile(server, source, request.body.name);
  if (runtime.isModsPath(server, source)) {
    markServerRestartRequired(server.id);
  }
  return result;
});

app.delete<{ Params: { id: string }; Querystring: { path?: string; recursive?: string } }>("/api/servers/:id/file", destructiveRateLimit, async (request) => {
  const server = await getServer(request.params.id);
  const runtime = runtimeForServer(server);
  const target = await runtime.resolveExistingPath(server, request.query.path ?? "");
  await requireFilePathPermission(request, server, target, runtime.isModsPath(server, target) ? "mods.remove" : "files.delete");
  const result = await runtime.deleteFile(server, target, request.query.recursive);
  if (isRestartSensitivePath(server, runtime, target)) {
    markServerRestartRequired(server.id);
  }
  return result;
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
  return normalizeModPreferences(modPreferencesRepository.list(server.id));
}

async function writeModPreferences(server: ManagedServer, data: Record<string, ModPreference>) {
  modPreferencesRepository.replaceAll(server.id, normalizeModPreferences(data));
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
  if (target.minecraftVersion && !minecraftVersionsInclude(metadata.gameVersions, target.minecraftVersion)) {
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

type InstalledModUpdateCurrent = {
  project_id?: string;
  id?: string;
  version_id?: string;
  version_number?: string;
  version_type?: string;
};

type InstalledModUpdateInfo = {
  projectId: string;
  currentVersion?: string;
  currentChannel: ReleaseChannel;
  latestVersion?: string;
  latestVersionId?: string;
  latestFilename?: string;
  latestChannel?: ReleaseChannel;
  upToDate: boolean;
};

async function lookupModrinthUpdateForCurrent(server: ManagedServer, current: InstalledModUpdateCurrent | undefined, preferredChannel: ReleaseChannel, options: { forceRefresh?: boolean } = {}) {
  const targetRuntime = runtimeTarget(server);
  if (!targetRuntime.minecraftVersion) return null;
  if (!current?.project_id) return null;
  const versionFilter = {
    loader: "fabric",
    minecraftVersion: targetRuntime.minecraftVersion
  };
  const versions = await fetchProjectVersions(current.project_id, versionFilter, options);
  let target = latestCompatibleProjectVersion(versions, { ...versionFilter, channel: preferredChannel });
  if (!target) {
    target = latestCompatibleProjectVersion(await fetchProjectVersions(current.project_id, undefined, options), { ...versionFilter, channel: preferredChannel });
  }
  const currentVersionId = current.version_id ?? current.id;
  let currentVersion: ModrinthVersion | undefined;
  if (currentVersionId) {
    currentVersion = await resolveSelectedProjectVersion({
      projectId: current.project_id,
      versionId: currentVersionId,
      versions
    }).catch(() => undefined);
  }
  if (currentVersion
    && allowedForChannel(currentVersion, preferredChannel)
    && currentVersion.loaders.includes(versionFilter.loader)
    && minecraftVersionsInclude(currentVersion.game_versions, versionFilter.minecraftVersion)
    && modrinthJarFile(currentVersion)
    && modrinthVersionIsNewer(currentVersion, target)
  ) {
    target = currentVersion;
  }
  const currentMatchesTarget = Boolean(target && (
    current.version_id
      ? current.version_id === target.id
      : current.version_number === target.version_number
  ));
  return {
    projectId: current.project_id,
    currentVersion: current.version_number,
    currentChannel: versionChannel(current.version_type),
    latestVersion: target?.version_number,
    latestVersionId: target?.id,
    latestFilename: modrinthJarFile(target)?.filename,
    latestChannel: target ? versionChannel(target.version_type) : undefined,
    upToDate: Boolean(target && currentMatchesTarget)
  } satisfies InstalledModUpdateInfo;
}

async function lookupModrinthUpdateFromMetadata(server: ManagedServer, metadata: InstalledModMetadata, preferredChannel: ReleaseChannel, options: { forceRefresh?: boolean } = {}) {
  return lookupModrinthUpdateForCurrent(server, {
    project_id: metadata.projectId,
    version_id: metadata.versionId,
    version_number: metadata.versionNumber,
    version_type: metadata.versionType
  }, preferredChannel, options);
}

async function lookupModrinthUpdate(server: ManagedServer, modPath: string, preferredChannel: ReleaseChannel, metadata?: InstalledModMetadata, options: { forceRefresh?: boolean } = {}) {
  if (metadata?.projectId) {
    return lookupModrinthUpdateFromMetadata(server, metadata, preferredChannel, options);
  }
  const hash = createHash("sha1").update(await readFile(modPath)).digest("hex");
  const currentRes = await modrinthFetch(`https://api.modrinth.com/v2/version_file/${hash}?algorithm=sha1`);
  const current = await currentRes.json() as InstalledModUpdateCurrent;
  return lookupModrinthUpdateForCurrent(server, {
    project_id: current.project_id,
    version_id: current.version_id ?? current.id,
    version_number: current.version_number,
    version_type: current.version_type
  }, preferredChannel, options);
}

function remoteModMetadata(value: unknown): InstalledModMetadata | null {
  if (!value || typeof value !== "object") return null;
  const metadata = value as Partial<InstalledModMetadata>;
  if (!metadata.projectId || !metadata.versionId || !metadata.versionNumber) return null;
  return {
    projectId: metadata.projectId,
    versionId: metadata.versionId,
    filename: metadata.filename ? safeInstalledModFilename(metadata.filename) : "unknown.jar",
    versionNumber: metadata.versionNumber,
    versionType: metadata.versionType,
    gameVersions: Array.isArray(metadata.gameVersions) ? metadata.gameVersions.filter((item): item is string => typeof item === "string") : [],
    loaders: Array.isArray(metadata.loaders) ? metadata.loaders.filter((item): item is string => typeof item === "string") : [],
    hashes: metadata.hashes,
    installedAt: metadata.installedAt || new Date(0).toISOString(),
    installedWithForceIncompatible: metadata.installedWithForceIncompatible === true,
    incompatibilityReason: metadata.incompatibilityReason,
    overrideMinecraftVersion: metadata.overrideMinecraftVersion,
    overrideReason: metadata.overrideReason,
    clientSide: metadata.clientSide,
    serverSide: metadata.serverSide,
    forceIncompatible: metadata.forceIncompatible
  };
}

async function enrichInstalledModUpdates(server: ManagedServer, result: unknown, options: { forceRefresh?: boolean } = {}) {
  if (!result || typeof result !== "object" || !Array.isArray((result as { mods?: unknown }).mods)) return result;
  const base = result as { mods: Array<Record<string, unknown>> };
  const mods = await Promise.all(base.mods.map(async (mod) => {
    const metadata = remoteModMetadata(mod.modrinth);
    if (!metadata) return mod;
    const preferredChannel = normalizeReleaseChannel(typeof mod.preferredChannel === "string" ? mod.preferredChannel : undefined);
    try {
      const versionInfo = await lookupModrinthUpdateFromMetadata(server, metadata, preferredChannel, options);
      return versionInfo ? { ...mod, versionInfo } : mod;
    } catch {
      return mod;
    }
  }));
  return { ...base, mods };
}

async function localListMods(server: ManagedServer, options: { forceRefresh?: boolean } = {}) {
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

        await ensureModrinthIconForFile(server, entry.name, modPath, metadata);
        let versionInfo: any = null;
        try { versionInfo = await lookupModrinthUpdate(server, modPath, preferredChannel, metadata, options); } catch { versionInfo = null; }
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

async function downloadModrinthJar(file: NonNullable<ReturnType<typeof modrinthJarFile>>) {
  if (!file.url.startsWith("https://")) {
    throw new Error("Refusing to download a non-HTTPS mod file");
  }
  if (file.size && file.size > modFileSizeLimit) {
    throw new Error(`Mod download is larger than ${Math.floor(modFileSizeLimit / 1024 / 1024)} MiB`);
  }
  const response = await modrinthFetch(file.url);
  if (!response.ok) {
    throw new Error(`Mod download failed: ${response.statusText}`);
  }
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > modFileSizeLimit) {
    throw new Error(`Mod download is larger than ${Math.floor(modFileSizeLimit / 1024 / 1024)} MiB`);
  }
  const content = Buffer.from(await response.arrayBuffer());
  if (!content.length || content.length > modFileSizeLimit) {
    throw new Error(`Mod download must be between 1 byte and ${Math.floor(modFileSizeLimit / 1024 / 1024)} MiB`);
  }
  assertJarBuffer(content);
  const expectedSha1 = file.hashes?.sha1;
  if (expectedSha1 && createHash("sha1").update(content).digest("hex") !== expectedSha1) {
    throw new Error("Downloaded mod hash did not match Modrinth metadata");
  }
  const expectedSha512 = file.hashes?.sha512;
  if (expectedSha512 && createHash("sha512").update(content).digest("hex") !== expectedSha512) {
    throw new Error("Downloaded mod hash did not match Modrinth metadata");
  }
  return content;
}

function modsFromListResult(result: unknown) {
  if (!result || typeof result !== "object" || !Array.isArray((result as { mods?: unknown }).mods)) return [];
  return (result as { mods: Array<Record<string, unknown>> }).mods;
}

async function buildModUpdatePlan(server: ManagedServer, options: { forceRefresh?: boolean; channel?: ReleaseChannel } = {}): Promise<ModUpdatePlan> {
  const runtime = runtimeForServer(server);
  const listed = await enrichInstalledModUpdates(server, await runtime.listMods(server, { forceRefresh: options.forceRefresh }), { forceRefresh: options.forceRefresh });
  let mods = modsFromListResult(listed);
  if (options.channel) {
    mods = await Promise.all(mods.map(async (mod) => {
      const metadata = remoteModMetadata(mod.modrinth);
      if (!metadata) return { ...mod, preferredChannel: options.channel };
      try {
        const versionInfo = await lookupModrinthUpdateFromMetadata(server, metadata, options.channel!, { forceRefresh: options.forceRefresh });
        return { ...mod, preferredChannel: options.channel, versionInfo };
      } catch {
        return { ...mod, preferredChannel: options.channel, versionInfo: null };
      }
    }));
  }
  return createModUpdatePlan(server.id, mods);
}

async function updateModrinthMod(server: ManagedServer, input: unknown) {
  const startedAt = Date.now();
  const body = asObject(input, "mod update request");
  const filename = safeInstalledModFilename(requiredString(body.filename, "filename"));
  const selectedChannel = optionalReleaseChannel(body.channel);
  const runtime = runtimeForServer(server);
  try {
    const listResult = await enrichInstalledModUpdates(server, await runtime.listMods(server, { forceRefresh: true }), { forceRefresh: true });
    const mods = modsFromListResult(listResult);
    const currentMod = mods.find((mod) => mod.filename === filename);
    const metadata = remoteModMetadata(currentMod?.modrinth);
    if (!currentMod || !metadata) {
      throw new Error("Installed Modrinth metadata could not be found for that mod");
    }

    const targetRuntime = runtimeTarget(server);
    if (!targetRuntime.minecraftVersion || targetRuntime.loader !== "fabric") {
      throw new Error("A resolved Fabric runtime profile is required before updating mods");
    }
    const versionFilter = {
      loader: targetRuntime.loader,
      minecraftVersion: targetRuntime.minecraftVersion
    };
    const versions = await fetchProjectVersions(metadata.projectId, versionFilter, { forceRefresh: true });
    let latest = latestCompatibleProjectVersion(versions, { ...versionFilter, channel: selectedChannel });
    if (!latest) {
      latest = latestCompatibleProjectVersion(await fetchProjectVersions(metadata.projectId, undefined, { forceRefresh: true }), { ...versionFilter, channel: selectedChannel });
    }
    const file = modrinthJarFile(latest);
    if (!latest || !file) {
      throw new Error("No compatible installable update was found for that project");
    }
    if (metadata.versionId === latest.id) {
      return { ok: true, filename, version: latest.version_number, channel: versionChannel(latest.version_type), upToDate: true };
    }

    const targetFilename = safeModFilename(safeInstalledModFilename(file.filename));
    const existingTarget = mods.find((mod) => mod.filename === targetFilename || mod.filename === `${targetFilename}.disabled`);
    if (existingTarget && existingTarget.filename !== filename) {
      await runtime.removeMod(server, filename);
      logInfo({ ...serverLogFields(server), filename, targetFilename, versionId: latest.id, action: "update_mod", status: "deduplicated", durationMs: durationSince(startedAt) }, "Mod update removed older duplicate");
      return { ok: true, filename: existingTarget.filename, version: latest.version_number, channel: versionChannel(latest.version_type), replaced: filename };
    }

    const content = await downloadModrinthJar(file);
    if (targetFilename === filename) {
      await runtime.removeMod(server, filename);
      await runtime.uploadMod(server, targetFilename, content.toString("base64"));
    } else {
      await runtime.uploadMod(server, targetFilename, content.toString("base64"));
      await runtime.removeMod(server, filename);
    }

    logInfo({ ...serverLogFields(server), filename, targetFilename, versionId: latest.id, action: "update_mod", status: "succeeded", durationMs: durationSince(startedAt) }, "Mod update succeeded");
    return { ok: true, filename: targetFilename, version: latest.version_number, channel: versionChannel(latest.version_type), replaced: filename };
  } catch (error) {
    logOperationFailure({ ...serverLogFields(server), filename, action: "update_mod", status: "failed", durationMs: durationSince(startedAt) }, "Mod update failed", error);
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
    const matchesMinecraft = minecraftVersionsInclude(version.game_versions, input.minecraftVersion);
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
        dependencyVersion = await resolveSelectedProjectVersion({
          projectId: dependency.project_id,
          versionId: dependency.version_id
        });
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
      ? await resolveSelectedProjectVersion({
        projectId,
        project,
        versionId: install.versionId,
        versions
      }).catch((error) => {
        if ((error as Error).message === "The selected Modrinth version does not belong to that project") throw error;
        return undefined;
      })
      : versions.find((version) => (
        allowedForChannel(version, selectedChannel)
        && version.loaders.includes("fabric")
        && minecraftVersionsInclude(version.game_versions, minecraftVersion)
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
    const matchesMinecraft = minecraftVersionsInclude(selectedVersion.game_versions, minecraftVersion);
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
    const installedProjectIds = new Set(Object.values(prefs).map((pref) => pref.modrinth?.projectId).filter(Boolean));

    for (const planned of installPlan.installs) {
      if (planned.dependencyType === "required" && installedProjectIds.has(planned.projectId)) continue;
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
      installedProjectIds.add(planned.projectId);
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

app.get<{ Params: { id: string }; Querystring: { forceRefresh?: string } }>("/api/servers/:id/mods", async (request) => {
  await requireRequestPermission(request, "mods.view");
  const server = await getServer(request.params.id);
  const options = { forceRefresh: request.query.forceRefresh === "true" };
  const result = await runtimeForServer(server).listMods(server, options);
  return options.forceRefresh ? enrichInstalledModUpdates(server, result, options) : result;
});

app.get<{ Params: { id: string }; Querystring: { forceRefresh?: string; channel?: ReleaseChannel } }>("/api/servers/:id/mods/update-plan", async (request) => {
  await requireRequestPermission(request, "mods.view");
  const server = await getServer(request.params.id);
  return buildModUpdatePlan(server, { forceRefresh: request.query.forceRefresh === "true", channel: optionalReleaseChannel(request.query.channel) });
});

app.get<{ Params: { id: string }; Querystring: { filename?: string } }>("/api/servers/:id/mods/icon", async (request, reply) => {
  await requireRequestPermission(request, "mods.view");
  const server = await getServer(request.params.id);
  const icon = await runtimeForServer(server).modIcon(server, request.query.filename);
  if (!icon) {
    reply.code(404);
    return apiErrorResponse("ICON_NOT_FOUND", "Icon not found");
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
  const user = await requireRequestPermission(request, "mods.enableDisable");
  const server = await getServer(request.params.id);
  return recordOperation({
    type: "mod.toggle",
    serverId: server.id,
    nodeId: server.nodeId,
    createdBy: user.id,
    task: "Updating mod state",
    successTask: "Mod state updated",
    markRestartRequiredOnSuccess: true
  }, () => runtimeForServer(server).toggleMod(server, request.body.filename, request.body.enabled));
});


app.delete<{ Params: { id: string }; Querystring: { filename?: string } }>("/api/servers/:id/mods", modChangeRateLimit, async (request) => {
  const user = await requireRequestPermission(request, "mods.remove");
  const server = await getServer(request.params.id);
  return recordOperation({
    type: "mod.remove",
    serverId: server.id,
    nodeId: server.nodeId,
    createdBy: user.id,
    task: "Removing mod",
    successTask: "Mod removed",
    markRestartRequiredOnSuccess: true
  }, () => runtimeForServer(server).removeMod(server, request.query.filename));
});

app.post<{ Params: { id: string }; Body: { filename?: string; contentBase64?: string } }>("/api/servers/:id/mods/upload", modChangeRateLimit, async (request) => {
  const user = await requireRequestPermission(request, "mods.upload");
  const server = await getServer(request.params.id);
  return recordOperation({
    type: "mod.upload",
    serverId: server.id,
    nodeId: server.nodeId,
    createdBy: user.id,
    task: "Uploading mod",
    successTask: "Mod uploaded",
    markRestartRequiredOnSuccess: true
  }, () => runtimeForServer(server).uploadMod(server, request.body.filename, request.body.contentBase64));
});

type ModrinthInstallVersionStatus =
  | "recommended"
  | "compatible"
  | "version_mismatch"
  | "wrong_loader"
  | "no_installable_jar"
  | "client_only"
  | "server_support_unknown";

function classifyModrinthInstallVersion(input: {
  version: ModrinthVersion;
  minecraftVersion: string;
  projectSides: { server_side?: string; client_side?: string };
  recommended: boolean;
  dependencyProjects: Map<string, ModrinthProject>;
}) {
  const file = modrinthJarFile(input.version);
  const hasFabric = input.version.loaders.includes("fabric");
  const matchesMinecraft = minecraftVersionsInclude(input.version.game_versions, input.minecraftVersion);
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
      && minecraftVersionsInclude(version.game_versions, targetRuntime.minecraftVersion!)
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
    const parsedLimit = request.query.limit ? parseInt(request.query.limit, 10) : 20;
    const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 20) : 20;
    url.searchParams.set("limit", "100");
    let offset = 0;
    if (request.query.offset) {
      const parsedOffset = parseInt(request.query.offset, 10);
      if (Number.isFinite(parsedOffset) && parsedOffset > 0) {
        offset = parsedOffset;
      }
    }
    const response = await modrinthFetch(url.toString());
    let body = await response.json() as { hits?: ModrinthProject[]; total_hits?: number; offset?: number; limit?: number };
    const compatibility = (hit: ModrinthProject) => {
      const loaderMatches = hit.categories?.includes(targetRuntime.loader) === true;
      const versionMatches = minecraftVersionsInclude(hit.versions ?? [], minecraftVersion);
      const serverMatches = modrinthServerSideSupported(hit.server_side);
      return { loaderMatches, versionMatches, serverMatches, compatible: loaderMatches && versionMatches && serverMatches };
    };
    const filtered = (body.hits ?? []).filter((hit) => {
      if (hit.project_type && hit.project_type !== "mod") return false;
      const match = compatibility(hit);
      if (compatibilityFilter === "all") return true;
      if (compatibilityFilter === "compatible") return match.compatible;
      if (compatibilityFilter === "incompatible") return !match.compatible;
      return match.loaderMatches && match.versionMatches && hit.server_side !== "unsupported";
    });
    body = { ...body, hits: filtered.slice(offset, offset + limit), total_hits: filtered.length, offset, limit };
    const hits = (body.hits ?? []).map((hit) => {
      const projectId = hit.project_id || hit.id;
      const serverSide = hit.server_side;
      const loaderMatches = hit.categories?.includes(targetRuntime.loader) === true;
      const versionMatches = minecraftVersionsInclude(hit.versions ?? [], minecraftVersion);
      const serverSupported = modrinthServerSideSupported(serverSide);
      const compatible = loaderMatches && versionMatches && serverSupported;
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
        compatibility: compatible
          ? {
              status: "compatible",
              compatible: true,
              reason: "Matches this Fabric server search",
              matchedLoaders: [targetRuntime.loader],
              matchedGameVersions: [minecraftVersion],
              serverSide,
              clientSide: hit.client_side
            }
          : loaderMatches && versionMatches && serverSide === "unknown"
            ? {
                status: "unknown",
                compatible: false,
                reason: "Server-side support could not be verified",
                matchedLoaders: [targetRuntime.loader],
                matchedGameVersions: [minecraftVersion],
                serverSide,
                clientSide: hit.client_side
              }
            : {
                status: "incompatible",
                compatible: false,
                reason: !loaderMatches
                  ? "No Fabric release was found for this project"
                  : !versionMatches
                    ? `No release was found for Minecraft ${minecraftVersion}`
                    : "Client-only mod; server-side support is unsupported",
                matchedLoaders: [targetRuntime.loader],
                matchedGameVersions: [minecraftVersion],
                serverSide,
                clientSide: hit.client_side
              }
      };
    });
    logInfo({ ...serverLogFields(server), resultCount: hits.length, durationMs: durationSince(startedAt), action: "modrinth_search", status: hits.length > 0 ? "projects_found" : "no_project_found" }, "Modrinth search completed");
    return { ...body, hits, status: hits.length > 0 ? "projects_found" : "no_project_found" };
  } catch (error) {
    logError({ ...serverLogFields(server), durationMs: durationSince(startedAt), action: "modrinth_search", status: "failed", ...errorLogFields(error) }, "Modrinth search failed");
    throw error;
  }
});

app.post<{ Body: { serverId?: string; filename?: string; channel?: ReleaseChannel } }>("/api/modrinth/update", modChangeRateLimit, async (request) => {
  const user = await requireRequestPermission(request, "mods.update");
  const server = await getServer(request.body.serverId);
  return recordOperation({
    type: "mod.update",
    serverId: server.id,
    nodeId: server.nodeId,
    createdBy: user.id,
    task: "Updating mod",
    successTask: "Mod updated",
    markRestartRequiredOnSuccess: (result) => !((result as { upToDate?: unknown })?.upToDate === true)
  }, () => updateModrinthMod(server, request.body));
});

app.post<{ Body: { serverId?: string; filenames?: string[]; channel?: ReleaseChannel } }>("/api/modrinth/update-safe", modChangeRateLimit, async (request) => {
  const user = await requireRequestPermission(request, "mods.update");
  const server = await getServer(request.body.serverId);
  return recordOperation({
    type: "mod.batchUpdate",
    serverId: server.id,
    nodeId: server.nodeId,
    createdBy: user.id,
    task: "Updating mods",
    successTask: "Mod update batch complete",
    markRestartRequiredOnSuccess: (result) => ((result as SafeBatchUpdateResult).counts?.updated ?? 0) > 0
  }, async () => {
    await ensureServerStoppedForModChanges(server);
    const channel = optionalReleaseChannel(request.body.channel);
    const filenames = request.body.filenames === undefined
      ? undefined
      : asArray(request.body.filenames, "filenames").map((filename) => safeInstalledModFilename(requiredString(filename, "filename")));
    if (filenames && filenames.length > 100) throw new Error("A safe update batch is limited to 100 mods");
    const startedAt = Date.now();
    const plan = await buildModUpdatePlan(server, { forceRefresh: true, channel });
    const result = await executeSafeUpdatePlan(plan, filenames, (entry) => updateModrinthMod(server, { filename: entry.filename, channel }));
    for (const skipped of result.skipped) {
      logInfo({ ...serverLogFields(server), filename: skipped.filename, reason: skipped.reason, action: "update_mod_safe_batch_item", status: "skipped" }, "Safe batch mod update skipped item");
    }
    logInfo({
      ...serverLogFields(server),
      action: "update_mod_safe_batch",
      status: result.failed.length ? "partial" : "succeeded",
      updatedCount: result.counts.updated,
      skippedCount: result.counts.skipped,
      failedCount: result.counts.failed,
      durationMs: durationSince(startedAt)
    }, "Safe batch mod update completed");
    return result;
  });
});

function isSelectedModrinthVersionMissing(error: unknown) {
  return error instanceof Error && error.message === "The selected Modrinth version could not be found";
}

async function installModWithRemoteVersionFallback(server: ManagedServer, input: unknown) {
  const runtime = runtimeForServer(server);
  try {
    return await runtime.installMod(server, input);
  } catch (error) {
    if (!isSelectedModrinthVersionMissing(error) || !(runtime instanceof RemoteNodeRuntime)) {
      throw error;
    }

    const install = parseModrinthInstallRequest(input);
    if (!install.versionId) throw error;
    const targetRuntime = runtimeTarget(server);
    if (!targetRuntime.minecraftVersion || targetRuntime.loader !== "fabric") throw error;

    const [project, versions] = await Promise.all([
      fetchProject(install.projectId) as Promise<ModrinthProject>,
      fetchProjectVersions(install.projectId, {
        loader: targetRuntime.loader,
        minecraftVersion: targetRuntime.minecraftVersion
      }, { forceRefresh: true })
    ]);
    const selectedVersion = await resolveSelectedProjectVersion({
      projectId: install.projectId,
      project,
      versionId: install.versionId,
      versions
    });
    const latestCompatible = latestCompatibleProjectVersion(versions, {
      loader: targetRuntime.loader,
      minecraftVersion: targetRuntime.minecraftVersion,
      channel: install.channel
    });
    const selectedIsLatestCompatible = selectedVersion.id === latestCompatible?.id
      && allowedForChannel(selectedVersion, install.channel)
      && selectedVersion.loaders.includes(targetRuntime.loader)
      && minecraftVersionsInclude(selectedVersion.game_versions, targetRuntime.minecraftVersion)
      && modrinthJarFile(selectedVersion)
      && modrinthServerSideSupported(project.server_side);
    if (!selectedIsLatestCompatible) throw error;

    logWarn({
      ...serverLogFields(server),
      projectId: install.projectId,
      versionId: install.versionId,
      action: "modrinth_install",
      status: "panel_side_remote_install"
    }, "Installing selected Modrinth version from panel because remote node agent could not resolve it");

    const file = modrinthJarFile(selectedVersion);
    if (!file) throw error;
    const projectSides = { server_side: project.server_side, client_side: project.client_side };
    const compatibility = compatibilityFromSelectedVersion({
      version: selectedVersion,
      file,
      projectSides,
      minecraftVersion: targetRuntime.minecraftVersion,
      compatible: true,
      reason: "Compatible server-side Fabric mod"
    });
    const installPlan = await planRequiredModrinthInstalls({
      rootProjectId: install.projectId,
      rootProject: project,
      rootVersion: selectedVersion,
      minecraftVersion: targetRuntime.minecraftVersion,
      channel: install.channel
    });
    const listResult = await enrichInstalledModUpdates(server, await runtime.listMods(server, { forceRefresh: true }), { forceRefresh: true });
    const installedProjectIds = new Set(modsFromListResult(listResult).map((mod) => remoteModMetadata(mod.modrinth)?.projectId).filter(Boolean));
    const installedFilenames = new Set(modsFromListResult(listResult).map((mod) => typeof mod.filename === "string" ? mod.filename : undefined).filter(Boolean));
    const installed: Array<{ projectId: string; version: string; filename: string; dependencyType: "root" | "required"; path?: string }> = [];

    for (const planned of installPlan.installs) {
      if (planned.dependencyType === "required" && installedProjectIds.has(planned.projectId)) continue;
      const filename = safeModFilename(safeInstalledModFilename(planned.file.filename));
      if (installedFilenames.has(filename) || installedFilenames.has(`${filename}.disabled`)) {
        if (planned.dependencyType === "required") continue;
        throw new Error("A mod with that filename already exists");
      }
      const content = await downloadModrinthJar(planned.file);
      const written = await runtime.uploadMod(server, filename, content.toString("base64")) as { path?: string };
      installedProjectIds.add(planned.projectId);
      installedFilenames.add(filename);
      installed.push({
        projectId: planned.projectId,
        version: planned.version.version_number,
        filename,
        dependencyType: planned.dependencyType,
        path: written.path
      });
    }

    const rootInstall = installed.find((item) => item.dependencyType === "root");
    return {
      ok: true,
      projectId: install.projectId,
      version: selectedVersion.version_number,
      filename: rootInstall?.filename ?? file.filename,
      channel: versionChannel(selectedVersion.version_type),
      installed,
      optionalDependencies: installPlan.optionalDependencies,
      compatibility
    };
  }
}

app.post<{ Body: { serverId?: string; projectId?: string; versionId?: string; channel?: ReleaseChannel; forceIncompatible?: boolean; overrideMinecraftVersion?: boolean } }>("/api/modrinth/install", modChangeRateLimit, async (request) => {
  const user = await requireRequestPermission(request, "mods.install");
  const server = await getServer(request.body.serverId);
  return recordOperation({
    type: "mod.install",
    serverId: server.id,
    nodeId: server.nodeId,
    createdBy: user.id,
    task: "Installing mod",
    successTask: "Mod installed",
    markRestartRequiredOnSuccess: true
  }, () => installModWithRemoteVersionFallback(server, request.body));
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
  removeMod: localRemoveMod,
  uploadMod: localUploadMod,
  installMod: localInstallMod
}) : undefined;
runtimeRegistry = new NodeRuntimeRegistry(
  localRuntime,
  (nodeId) => new RemoteNodeRuntime(
    nodeId,
    async (id) => (await readNodes()).find((node) => node.id === id),
    panelNodeConnections,
    publicServer,
    async (server) => {
      serversRepository.create(server);
    },
    async (server) => {
      serversRepository.replaceMetadata(server);
    },
    async (serverId) => {
      serversRepository.delete(serverId);
    }
  )
);
resourceStatsCollector = new ResourceStatsCollector({
  pollMs: resourceStatsPollMs,
  historyWindowMs: resourceStatsHistoryWindowMs,
  readServers: listManagedServers,
  runtimeForServer,
  statsRepository: new ResourceStatsRepository(storageDatabase)
});
resourceStatsCollector.start();
app.addHook("onClose", async () => {
  resourceStatsCollector?.stop();
});

await registerStaticFrontend(app);

app.setErrorHandler((error, _request, reply) => {
  const expectedUserError = isExpectedUserError(error);
  const statusCode = errorStatusCode(error, reply, expectedUserError);
  const errorMessage = error instanceof Error ? error.message : String(error);
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
  reply.code(statusCode).send(publicApiError(error, statusCode));
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
const dockerSocketMounted = config.runtimeMode === "panel" ? false : dockerAvailable();
app.log.info({
  appVersion,
  dataDir: config.dataDir,
  databasePath: config.databasePath,
  managedServersDir: config.serversDir,
  backupsDir: config.backupsDir,
  importsDir: config.importsDir,
  exportsDir: config.exportsDir,
  tmpDir: config.tmpDir,
  nodeCount: startupNodes.length,
  dockerSocketMounted,
  modrinthApiConfigured: modrinthConfigured,
  authEnabled: startupUsers.length > 0,
  logLevel: config.logLevel,
  port: config.port
}, "ServerSentinel startup configuration");
if (config.runtimeMode !== "panel" && !dockerSocketMounted) {
  app.log.warn({ dockerSocket: config.dockerSocket }, "Docker socket is not mounted; runtime management is unavailable");
}

await app.listen({ host: "0.0.0.0", port: config.port });
app.log.info({ port: config.port }, "ServerSentinel web panel listening");
}
