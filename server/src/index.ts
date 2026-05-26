import Fastify from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { fileURLToPath } from "node:url";
import { fetch } from "undici";
import { totalmem } from "node:os";

const config = {
  configDir: resolve(process.env.SERVERSENTINEL_CONFIG_DIR ?? "/config"),
  serversDir: resolve(process.env.SERVERSENTINEL_SERVERS_DIR ?? "/data/servers"),
  serversDockerVolume: process.env.SERVERSENTINEL_SERVERS_DOCKER_VOLUME?.trim() ?? "",
  dockerSocket: process.env.DOCKER_SOCKET ?? "/var/run/docker.sock",
  port: Number(process.env.PORT ?? "8080")
};

const legacyDefaultServersDockerVolume = "serversentinel-minecraft-servers";
const serversFile = join(config.configDir, "servers.json");
const settingsFile = join(config.configDir, "settings.json");
const usersFile = join(config.configDir, "users.json");
const minServerPort = 1000;
const maxServerPort = 65000;

type AppSettings = {
  modrinthApiKey?: string;
};

type UserRole = "admin" | "basic" | "expanded" | "manager";

type Permission = "basic" | "expanded" | "manager" | "admin";

type StoredUser = {
  id: string;
  username: string;
  passwordHash: string;
  salt: string;
  role: UserRole;
  createdAt: string;
  updatedAt: string;
};

type PublicUser = {
  id: string;
  username: string;
  role: UserRole;
  createdAt: string;
};

type Session = {
  id: string;
  userId: string;
  createdAt: string;
};

type ReleaseChannel = "release" | "beta" | "alpha";

type ModPreference = {
  channel: ReleaseChannel;
};

type AttachedServer = {
  id: string;
  displayName: string;
  serverDir: string;
  storageName?: string;
  minecraftVersion?: string;
  loaderVersion?: string;
  installerVersion?: string;
  serverJar?: string;
  dockerContainer?: string;
  dockerImage?: string;
  dockerMountSource?: string;
  dockerWorkingDir?: string;
  dockerPorts?: string;
  javaArgs?: string;
  schedules?: ScheduledExecution[];
  serverType: "fabric";
  createdAt: string;
  updatedAt: string;
};

type ScheduledExecution = {
  id: string;
  name: string;
  cron: string;
  commands: string[];
  onlyWhenNoPlayers: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  lastStatus?: string;
  lastMessage?: string;
};

type PublicServer = Omit<AttachedServer, "serverDir" | "dockerMountSource" | "dockerWorkingDir"> & {
  directoryLabel: string;
  hasDockerContainer: boolean;
};

type DockerState = "running" | "exited" | "created" | "paused" | "restarting" | "removing" | "dead" | "unknown";

type DockerExecCreate = {
  Id: string;
};

type DockerExecInspect = {
  ExitCode?: number | null;
};

type DockerContainerInspect = {
  Id?: string;
  State?: { Status?: DockerState; Running?: boolean; StartedAt?: string; FinishedAt?: string };
  Name?: string;
  Config?: { Labels?: Record<string, string> };
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

type ServerEvent = {
  id: string;
  type: "info" | "success" | "warning" | "error";
  text: string;
  timestamp?: string;
  source: "logs/latest.log" | "docker";
};

type ServerActivity = {
  lastStartedAt?: string;
  lastStoppedAt?: string;
  lastRestartAt?: string;
  currentWorld?: string;
  serverPort?: string;
  eulaAccepted?: boolean;
  javaRuntime?: string;
  autosaveStatus?: string;
  playersOnline?: number | null;
  maxPlayers?: number | null;
};

type CreateServerInput = {
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
const sessionCookieName = "serversentinel_session";
const passwordHashKeyLength = 64;
const roleRanks: Record<UserRole, number> = {
  basic: 1,
  expanded: 2,
  manager: 3,
  admin: 4
};

function publicUser(user: StoredUser): PublicUser {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    createdAt: user.createdAt
  };
}

function normalizeRole(role?: string): UserRole {
  return role === "basic" || role === "expanded" || role === "manager" || role === "admin" ? role : "basic";
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

function hashPassword(password: string, salt = randomBytes(16).toString("hex")) {
  const hash = scryptSync(password, salt, passwordHashKeyLength).toString("hex");
  return { salt, passwordHash: hash };
}

function verifyPassword(password: string, user: StoredUser) {
  const attempted = Buffer.from(hashPassword(password, user.salt).passwordHash, "hex");
  const stored = Buffer.from(user.passwordHash, "hex");
  return attempted.length === stored.length && timingSafeEqual(attempted, stored);
}

async function readUsers() {
  await mkdir(config.configDir, { recursive: true });
  if (!existsSync(usersFile)) {
    await writeFile(usersFile, "[]\n", "utf8");
  }
  return JSON.parse(await readFile(usersFile, "utf8")) as StoredUser[];
}

async function writeUsers(users: StoredUser[]) {
  await mkdir(config.configDir, { recursive: true });
  await writeFile(usersFile, `${JSON.stringify(users, null, 2)}\n`, "utf8");
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

function sessionCookie(sessionId: string, maxAgeSeconds: number) {
  return `${sessionCookieName}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

async function currentUserFromCookie(cookieHeader?: string) {
  const sessionId = parseCookies(cookieHeader).get(sessionCookieName);
  if (!sessionId) return null;
  const session = sessions.get(sessionId);
  if (!session) return null;
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

function requirePermission(user: StoredUser, permission: Permission) {
  const requiredRank = permission === "admin" ? roleRanks.admin : roleRanks[permission];
  if (roleRanks[user.role] < requiredRank) {
    const error = new Error("You do not have permission to perform this action") as Error & { statusCode?: number };
    error.statusCode = 403;
    throw error;
  }
}

async function requireRequestPermission(request: { headers: { cookie?: string } }, permission?: Permission) {
  const user = await requireAuthenticated(request.headers.cookie);
  if (permission) {
    requirePermission(user, permission);
  }
  return user;
}

function publicServer(server: AttachedServer): PublicServer {
  return {
    id: server.id,
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
    hasDockerContainer: Boolean(server.dockerContainer)
  };
}

async function readServers() {
  await mkdir(config.configDir, { recursive: true });
  if (!existsSync(serversFile)) {
    await writeFile(serversFile, "[]\n", "utf8");
  }
  const parsed = JSON.parse(await readFile(serversFile, "utf8")) as AttachedServer[];
  return parsed;
}

async function writeServers(servers: AttachedServer[]) {
  await mkdir(config.configDir, { recursive: true });
  await writeFile(serversFile, `${JSON.stringify(servers, null, 2)}\n`, "utf8");
}

async function readSettings() {
  await mkdir(config.configDir, { recursive: true });
  if (!existsSync(settingsFile)) {
    const initial: AppSettings = {
      modrinthApiKey: process.env.MODRINTH_API_KEY || undefined
    };
    await writeFile(settingsFile, `${JSON.stringify(initial, null, 2)}\n`, "utf8");
    return initial;
  }
  return JSON.parse(await readFile(settingsFile, "utf8")) as AppSettings;
}

async function writeSettings(settings: AppSettings) {
  await mkdir(config.configDir, { recursive: true });
  await writeFile(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

async function modrinthApiKey() {
  const settings = await readSettings();
  return settings.modrinthApiKey || process.env.MODRINTH_API_KEY || "";
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
  const servers = await readServers();
  const server = serverId ? servers.find((candidate) => candidate.id === serverId) : servers[0];
  if (!server) {
    throw new Error("No attached server is registered");
  }
  return server;
}

function ensureInsideServer(server: AttachedServer, userPath = ".") {
  const serverDir = resolve(server.serverDir);
  const trimmed = userPath.replace(/^[/\\]+/, "");
  const target = resolve(serverDir, trimmed || ".");
  if (target !== serverDir && !target.startsWith(serverDir + sep)) {
    throw new Error("Path escapes the registered server directory");
  }
  return target;
}

function ensureManagedServerDirectory(server: AttachedServer) {
  const serversDir = resolve(config.serversDir);
  const serverDir = resolve(server.serverDir);
  if (serverDir !== serversDir && !serverDir.startsWith(serversDir + sep)) {
    throw new Error("Server files can only be deleted when the directory is inside the managed servers directory");
  }
  return serverDir;
}

function toPublicPath(server: AttachedServer, absolutePath: string) {
  const rel = relative(resolve(server.serverDir), absolutePath).replaceAll("\\", "/");
  return rel ? `/${rel}` : "/";
}

function safeModFilename(name: string) {
  return basename(name).replace(/[^a-zA-Z0-9._ -]/g, "_");
}

function safeInstalledModFilename(name?: string) {
  const filename = basename(name ?? "").trim();
  if (!filename || filename !== name || (!filename.endsWith(".jar") && !filename.endsWith(".jar.disabled"))) {
    throw new Error("A valid mod filename is required");
  }
  return filename;
}

function modIconKey(filename: string) {
  return Buffer.from(filename.replace(/\.jar\.disabled$/, ".jar"), "utf8").toString("base64url");
}

async function modIconUrl(server: AttachedServer, filename: string) {
  const iconsDir = ensureInsideServer(server, "mods/.serversentinel-icons");
  if (!existsSync(iconsDir)) return undefined;
  const key = modIconKey(filename);
  const icon = (await readdir(iconsDir)).find((entry) => entry.startsWith(`${key}.`));
  return icon ? `/api/servers/${encodeURIComponent(server.id)}/mods/icon?filename=${encodeURIComponent(filename)}` : undefined;
}

async function deleteModIcon(server: AttachedServer, filename: string) {
  const iconsDir = ensureInsideServer(server, "mods/.serversentinel-icons");
  if (!existsSync(iconsDir)) return;
  const key = modIconKey(filename);
  const icons = await readdir(iconsDir);
  await Promise.all(icons.filter((entry) => entry.startsWith(`${key}.`)).map((entry) => rm(join(iconsDir, entry), { force: true })));
}

function iconExtension(iconUrl: string, contentType: string | null) {
  if (contentType?.includes("webp")) return ".webp";
  if (contentType?.includes("jpeg")) return ".jpg";
  if (contentType?.includes("png")) return ".png";
  const extension = extname(new URL(iconUrl).pathname).toLowerCase();
  return [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(extension) ? extension : ".png";
}

async function saveModIcon(server: AttachedServer, filename: string, iconUrl?: string | null) {
  if (!iconUrl || !iconUrl.startsWith("https://")) return;
  const response = await fetch(iconUrl, {
    headers: { "User-Agent": "ServerSentinel/0.3.0 (Fabric mod manager)" }
  });
  if (!response.ok || !response.body) return;
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 1024 * 1024) return;
  const iconsDir = ensureInsideServer(server, "mods/.serversentinel-icons");
  await mkdir(iconsDir, { recursive: true });
  await deleteModIcon(server, filename);
  await writeFile(join(iconsDir, `${modIconKey(filename)}${iconExtension(iconUrl, response.headers.get("content-type"))}`), bytes);
}

async function ensureModrinthIconForFile(server: AttachedServer, filename: string, filePath: string) {
  if (await modIconUrl(server, filename)) return;
  try {
    const hash = createHash("sha1").update(await readFile(filePath)).digest("hex");
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

function parseCronField(field: string, min: number, max: number) {
  const values = new Set<number>();
  for (const rawPart of field.split(",")) {
    const part = rawPart.trim();
    if (!part) return null;
    const [rangePart, stepPart] = part.split("/", 2);
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) return null;

    let start = min;
    let end = max;
    if (rangePart !== "*") {
      if (rangePart.includes("-")) {
        const [rawStart, rawEnd] = rangePart.split("-", 2).map(Number);
        if (!Number.isInteger(rawStart) || !Number.isInteger(rawEnd)) return null;
        start = rawStart;
        end = rawEnd;
      } else {
        const exact = Number(rangePart);
        if (!Number.isInteger(exact)) return null;
        start = exact;
        end = exact;
      }
    }

    if (start < min || end > max || start > end) return null;
    for (let value = start; value <= end; value += step) {
      values.add(value);
    }
  }
  return values;
}

function validateCron(cron: string) {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error("Cron schedule must use five fields: minute hour day month weekday");
  }
  const valid = [
    parseCronField(parts[0], 0, 59),
    parseCronField(parts[1], 0, 23),
    parseCronField(parts[2], 1, 31),
    parseCronField(parts[3], 1, 12),
    parseCronField(parts[4], 0, 7)
  ].every(Boolean);
  if (!valid) {
    throw new Error("Cron schedule contains an invalid field");
  }
}

function cronMatches(cron: string, date: Date) {
  validateCron(cron);
  const [minute, hour, dayOfMonth, month, dayOfWeek] = cron.trim().split(/\s+/);
  const normalizedDay = date.getDay();
  const days = parseCronField(dayOfWeek, 0, 7)!;
  return parseCronField(minute, 0, 59)!.has(date.getMinutes())
    && parseCronField(hour, 0, 23)!.has(date.getHours())
    && parseCronField(dayOfMonth, 1, 31)!.has(date.getDate())
    && parseCronField(month, 1, 12)!.has(date.getMonth() + 1)
    && (days.has(normalizedDay) || (normalizedDay === 0 && days.has(7)));
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

function dockerAvailable() {
  return existsSync(config.dockerSocket);
}

function dockerErrorMessage(body: string, statusCode?: number) {
  if (body) {
    try {
      const parsed = JSON.parse(body) as { message?: string };
      if (parsed.message) {
        return parsed.message;
      }
    } catch {
      return body;
    }
  }
  return `Docker API returned ${statusCode ?? "an error"}`;
}

async function dockerRequest<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  expectedStatus: number | number[] = [200, 204, 304]
): Promise<T> {
  if (!dockerAvailable()) {
    throw new Error("Docker integration is not configured; mount /var/run/docker.sock to enable it");
  }

  const okStatuses = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
  return new Promise<T>((resolveRequest, rejectRequest) => {
    const request = http.request(
      {
        socketPath: config.dockerSocket,
        path,
        method
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (!okStatuses.includes(response.statusCode ?? 0)) {
            rejectRequest(new Error(dockerErrorMessage(body, response.statusCode)));
            return;
          }
          resolveRequest(body ? (JSON.parse(body) as T) : ({} as T));
        });
      }
    );
    request.on("error", rejectRequest);
    request.end();
  });
}

async function dockerBufferRequest(method: "GET" | "POST", path: string, expectedStatus: number | number[] = 200) {
  if (!dockerAvailable()) {
    throw new Error("Docker integration is not configured; mount /var/run/docker.sock to enable it");
  }

  const okStatuses = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
  return new Promise<Buffer>((resolveRequest, rejectRequest) => {
    const request = http.request(
      {
        socketPath: config.dockerSocket,
        path,
        method
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const body = Buffer.concat(chunks);
          if (!okStatuses.includes(response.statusCode ?? 0)) {
            rejectRequest(new Error(dockerErrorMessage(body.toString("utf8"), response.statusCode)));
            return;
          }
          resolveRequest(body);
        });
      }
    );
    request.on("error", rejectRequest);
    request.end();
  });
}

async function dockerJsonRequest<T>(
  method: "GET" | "POST",
  path: string,
  body: unknown,
  expectedStatus: number | number[] = [200, 201, 204, 304]
): Promise<T> {
  if (!dockerAvailable()) {
    throw new Error("Docker integration is not configured; mount /var/run/docker.sock to enable it");
  }

  const payload = JSON.stringify(body);
  const okStatuses = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
  return new Promise<T>((resolveRequest, rejectRequest) => {
    const request = http.request(
      {
        socketPath: config.dockerSocket,
        path,
        method,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload)
        }
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const responseBody = Buffer.concat(chunks).toString("utf8");
          if (!okStatuses.includes(response.statusCode ?? 0)) {
            rejectRequest(new Error(dockerErrorMessage(responseBody, response.statusCode)));
            return;
          }
          resolveRequest(responseBody ? (JSON.parse(responseBody) as T) : ({} as T));
        });
      }
    );
    request.on("error", rejectRequest);
    request.write(payload);
    request.end();
  });
}

function dockerContainerName(server: AttachedServer) {
  if (server.dockerContainer?.trim()) {
    return server.dockerContainer.trim();
  }
  return defaultContainerName(server.displayName);
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function dockerControlConfigured(server: AttachedServer) {
  return Boolean(server.dockerContainer || (server.dockerMountSource && server.serverJar));
}

function usesLegacyUnconfiguredServersVolume(server: AttachedServer) {
  return !config.serversDockerVolume && server.dockerMountSource === legacyDefaultServersDockerVolume;
}

function serverDockerMountSource(server: AttachedServer) {
  if (usesLegacyUnconfiguredServersVolume(server)) {
    return server.serverDir;
  }
  if (server.dockerMountSource && server.dockerMountSource !== server.serverDir) {
    return server.dockerMountSource;
  }
  return config.serversDockerVolume || server.dockerMountSource || server.serverDir;
}

function serverDockerWorkingDir(server: AttachedServer) {
  if (usesLegacyUnconfiguredServersVolume(server)) {
    return "/data/server";
  }
  if (server.dockerWorkingDir) {
    return server.dockerWorkingDir;
  }
  if (config.serversDockerVolume && server.storageName) {
    return `/data/servers/${server.storageName}`;
  }
  return "/data/server";
}

function serverDockerBindTarget(server: AttachedServer) {
  return serverDockerWorkingDir(server).startsWith("/data/servers/") ? "/data/servers" : "/data/server";
}

function dockerContainerMountValid(server: AttachedServer, details: DockerContainerInspect) {
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

async function removeDockerContainer(server: AttachedServer) {
  await dockerRequest("DELETE", `/containers/${encodeURIComponent(dockerContainerName(server))}?force=1`, 204);
}

async function removeManagedDockerContainer(server: AttachedServer) {
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
    const { fromImage, tag } = splitImage(image);
    await dockerBufferRequest(
      "POST",
      `/images/create?fromImage=${encodeURIComponent(fromImage)}&tag=${encodeURIComponent(tag)}`,
      200
    );
  }
}

function parseDockerPorts(ports?: string) {
  const exposedPorts: Record<string, Record<string, never>> = {};
  const portBindings: Record<string, Array<{ HostPort: string }>> = {};
  for (const rawPort of ports?.split(",") ?? []) {
    const port = rawPort.trim();
    if (!port) continue;
    const [hostPort, containerPortWithProtocol] = port.includes(":") ? port.split(":", 2) : [port, port];
    const containerPort = containerPortWithProtocol.includes("/")
      ? containerPortWithProtocol
      : `${containerPortWithProtocol}/tcp`;
    exposedPorts[containerPort] = {};
    portBindings[containerPort] = [{ HostPort: hostPort }];
  }
  return { exposedPorts, portBindings };
}

async function inspectDockerContainer(server: AttachedServer) {
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

async function ensureDockerContainer(server: AttachedServer) {
  const existing = await inspectDockerContainer(server);
  if (existing) {
    if (dockerContainerMountValid(server, existing)) {
      return;
    }
    if (existing.Config?.Labels?.["serversentinel.managed"] !== "true") {
      throw new Error(`Container ${dockerContainerName(server)} exists but is not managed by ServerSentinel and has an incompatible server volume mount`);
    }
    await removeDockerContainer(server);
  }
  if (!serverDockerMountSource(server) || !server.serverJar) {
    throw new Error("Docker managed control requires Docker mount source and server jar filename");
  }

  const image = server.dockerImage || defaultDockerImageForMinecraftVersion(server.minecraftVersion);
  await ensureDockerImage(image);
  const { exposedPorts, portBindings } = parseDockerPorts(server.dockerPorts || "25565:25565/tcp");
  const javaArgs = server.javaArgs || "-Xms2G -Xmx4G";
  const quotedServerJar = shellQuote(server.serverJar);
  const command = `test -f ${quotedServerJar} || { echo "ServerSentinel could not find ${server.serverJar} in $(pwd)" >&2; ls -la >&2; exit 66; }; exec java ${javaArgs} -jar ${quotedServerJar} nogui`;
  const workingDir = serverDockerWorkingDir(server);
  const bindTarget = serverDockerBindTarget(server);

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
}

async function dockerStatus(server: AttachedServer) {
  if (!dockerControlConfigured(server)) {
    return {
      configured: false,
      available: dockerAvailable(),
      controllable: false,
      state: "unknown" as DockerState,
      message: "No Docker control is configured for this attached server"
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
  return {
    configured: true,
    available: true,
    controllable: true,
    state: details.State?.Status ?? "unknown",
    running: Boolean(details.State?.Running),
    container: dockerContainerName(server),
    name: details.Name?.replace(/^\//, "")
  };
}

async function dockerAction(server: AttachedServer, action: "start" | "stop" | "restart") {
  if (!dockerControlConfigured(server)) {
    throw new Error("Control is not configured for this attached server");
  }
  if (action === "start") {
    await ensureDockerContainer(server);
  }
  await dockerRequest("POST", `/containers/${encodeURIComponent(dockerContainerName(server))}/${action}`, [200, 204, 304]);
  if (action === "start" || action === "restart") {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const status = await dockerStatus(server);
    if (!status.running) {
      const logs = await dockerRecentLogs(server).catch(() => "");
      throw new Error(`Minecraft runtime container exited after ${action}${logs.trim() ? `: ${logs.trim().slice(-800)}` : ""}`);
    }
    return status;
  }
  return dockerStatus(server);
}

async function sendDockerStdinCommand(server: AttachedServer, command: string) {
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
      AttachStdout: false,
      AttachStderr: false,
      Tty: false,
      Cmd: ["sh", "-lc", shellCommand]
    },
    201
  );
  await dockerJsonRequest("POST", `/exec/${encodeURIComponent(exec.Id)}/start`, { Detach: false, Tty: false }, 200);
  const inspect = await dockerRequest<DockerExecInspect>("GET", `/exec/${encodeURIComponent(exec.Id)}/json`, 200);
  if (inspect.ExitCode) {
    throw new Error("Docker could not write to the Minecraft console stdin");
  }
  return { ok: true };
}

async function dockerRecentLogs(server: AttachedServer) {
  if (!dockerControlConfigured(server)) {
    throw new Error("Console logs are not configured for this attached server");
  }
  const response = await dockerBufferRequest(
    "GET",
    `/containers/${encodeURIComponent(dockerContainerName(server))}/logs?stdout=1&stderr=1&tail=200`,
    200
  );
  return stripDockerLogHeaders(response).toString("utf8");
}

async function dockerResourceStats(server: AttachedServer) {
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

async function readLatestServerLog(server: AttachedServer) {
  const logPath = ensureInsideServer(server, "logs/latest.log");
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

function normalizeJavaRuntime(server: AttachedServer) {
  const image = server.dockerImage || "";
  if (/temurin/i.test(image)) {
    const version = image.match(/temurin:([^,\s]+)/i)?.[1];
    return version ? `Temurin ${version.replace(/-jre$/i, "")}` : "Temurin";
  }
  if (/java/i.test(image) || /jdk|jre/i.test(image)) return image;
  return undefined;
}

function parseLogEvent(line: string, source: ServerEvent["source"], index: number): ServerEvent | null {
  const ansiStripped = line.replace(/\u001b\[[0-9;]*m/g, "").trim();
  if (!ansiStripped) return null;
  const parsed = ansiStripped.match(/^\[(?<time>\d{2}:\d{2}:\d{2})\]\s+\[[^\]]+\]\s+\[(?<level>[A-Z]+)\]:\s*(?<message>.*)$/);
  const timestamp = parsed?.groups?.time;
  const level = parsed?.groups?.level ?? "";
  const message = parsed?.groups?.message ?? ansiStripped;
  const id = `${source}-${index}-${timestamp ?? ""}-${createHash("sha1").update(message).digest("hex").slice(0, 8)}`;

  const playerJoin = message.match(/^(.+?) joined the game$/i);
  if (playerJoin) return { id, type: "success", text: `Player joined: ${playerJoin[1]}`, timestamp, source };

  const playerLeft = message.match(/^(.+?) left the game$/i);
  if (playerLeft) return { id, type: "info", text: `Player left: ${playerLeft[1]}`, timestamp, source };

  const playerDisconnected = message.match(/^(.+?) lost connection:/i);
  if (playerDisconnected) return { id, type: "warning", text: `Player disconnected: ${playerDisconnected[1]}`, timestamp, source };

  if (/Done \([^)]+\)! For help, type "help"/i.test(message) || /Starting minecraft server/i.test(message)) {
    return { id, type: "success", text: "Server started", timestamp, source };
  }
  if (/Stopping server|Stopping the server/i.test(message)) {
    return { id, type: "info", text: "Server stopped", timestamp, source };
  }
  if (/Saved the game|Saved the world|Automatic saving is now enabled|ThreadedAnvilChunkStorage.*All chunks are saved/i.test(message)) {
    return { id, type: "success", text: "Server saved", timestamp, source };
  }
  if (/out of memory|heap space|memory/i.test(message) && (/warn/i.test(level) || /warn|error|fatal/i.test(message))) {
    return { id, type: "warning", text: "Memory-related warning detected", timestamp, source };
  }
  if (/fatal|crash|exception|error/i.test(message) || level === "ERROR" || level === "FATAL") {
    return { id, type: "error", text: message.slice(0, 140), timestamp, source };
  }
  if (level === "WARN") {
    return { id, type: "warning", text: message.slice(0, 140), timestamp, source };
  }
  return null;
}

async function serverOverviewData(server: AttachedServer) {
  const [fileLog, dockerLog, properties, eula, dockerInspect] = await Promise.allSettled([
    readLatestServerLog(server),
    dockerRecentLogs(server),
    readFile(ensureInsideServer(server, "server.properties"), "utf8"),
    readFile(ensureInsideServer(server, "eula.txt"), "utf8"),
    dockerControlConfigured(server) ? dockerRequest<DockerContainerInspect>("GET", `/containers/${encodeURIComponent(dockerContainerName(server))}/json`, 200) : Promise.resolve(null)
  ]);
  const logSources: Array<{ source: ServerEvent["source"]; text: string }> = [];
  if (fileLog.status === "fulfilled") logSources.push({ source: "logs/latest.log", text: fileLog.value });
  if (dockerLog.status === "fulfilled") logSources.push({ source: "docker", text: dockerLog.value });
  const events = logSources
    .flatMap(({ source, text }) => text.split(/\r?\n/).map((line, index) => parseLogEvent(line, source, index)).filter((event): event is ServerEvent => Boolean(event)))
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
      : events.find((event) => event.text === "Server started")?.timestamp,
    lastStoppedAt: dockerInspect.status === "fulfilled" && dockerInspect.value?.State?.FinishedAt && !dockerInspect.value.State.FinishedAt.startsWith("0001-")
      ? dockerInspect.value.State.FinishedAt
      : events.find((event) => event.text === "Server stopped")?.timestamp,
    lastRestartAt: events.find((event) => /restart/i.test(event.text))?.timestamp,
    currentWorld: props["level-name"],
    serverPort: props["server-port"],
    eulaAccepted,
    javaRuntime: normalizeJavaRuntime(server),
    autosaveStatus: events.some((event) => event.text === "Server saved") ? "Recently saved" : undefined,
    playersOnline: parseOnlinePlayerCount(logText),
    maxPlayers: props["max-players"] ? Number(props["max-players"]) : null
  };
  return { events, activity };
}

async function onlinePlayerCount(server: AttachedServer) {
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

function streamLatestServerLog(server: AttachedServer, client: Client) {
  const logPath = ensureInsideServer(server, "logs/latest.log");
  let offset = 0;
  let closed = false;
  let announcedEmpty = false;

  const send = (text: string) => {
    if (text && client.readyState === 1) {
      client.send(JSON.stringify({ type: "log", source: "latest.log", text, at: new Date().toISOString() }));
    }
  };

  const poll = async () => {
    if (closed) return;
    try {
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

function streamDockerLogs(server: AttachedServer, client: Client) {
  if (!dockerControlConfigured(server) || !dockerAvailable()) {
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
    if (client.readyState === 1) {
      client.send(JSON.stringify({ type: "unavailable", message: error.message }));
    }
  });
  request.end();
  return request;
}

async function modrinthFetch(url: string) {
  const apiKey = await modrinthApiKey();
  if (!apiKey) {
    throw new Error("MODRINTH_API_KEY is not configured; Modrinth search and install are disabled");
  }
  const response = await fetch(url, {
    headers: {
      "User-Agent": "ServerSentinel/0.2.0 (attached Fabric server admin)",
      Authorization: apiKey
    }
  });
  if (!response.ok) {
    throw new Error(`Modrinth request failed: ${response.status} ${response.statusText}`);
  }
  return response;
}

async function fabricMeta<T>(path: string) {
  const response = await fetch(`https://meta.fabricmc.net${path}`, {
    headers: {
      "User-Agent": "ServerSentinel/0.3.0 (Fabric server creator)"
    }
  });
  if (!response.ok) {
    throw new Error(`Fabric metadata request failed: ${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

async function latestFabricVersion(kind: "loader" | "installer") {
  const versions = await fabricMeta<Array<{ version: string; stable: boolean }>>(`/v2/versions/${kind}`);
  const version = versions.find((candidate) => candidate.stable) ?? versions[0];
  if (!version) {
    throw new Error(`No Fabric ${kind} versions are available`);
  }
  return version.version;
}

async function downloadFabricServerJar(server: AttachedServer) {
  if (!server.minecraftVersion || !server.loaderVersion || !server.installerVersion || !server.serverJar) {
    throw new Error("Minecraft, loader, installer, and server jar versions are required");
  }

  const target = ensureInsideServer(server, server.serverJar);
  const url = `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(server.minecraftVersion)}/${encodeURIComponent(server.loaderVersion)}/${encodeURIComponent(server.installerVersion)}/server/jar`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": "ServerSentinel/0.3.0 (Fabric server creator)"
    }
  });
  if (!response.ok || !response.body) {
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
}

async function ensureServerStoppedForModChanges(server: AttachedServer) {
  const status = await dockerStatus(server);
  if (status.running) {
    throw new Error("Stop the server before enabling, disabling, or removing mods");
  }
}

async function createServerFiles(
  server: AttachedServer,
  acceptEula: boolean,
  serverPort: string,
  report?: (progress: number, task: string) => void
) {
  report?.(35, "Creating server folders");
  await mkdir(server.serverDir, { recursive: true });
  await mkdir(ensureInsideServer(server, "mods"), { recursive: true });
  await mkdir(ensureInsideServer(server, "logs"), { recursive: true });
  report?.(45, "Downloading Fabric server launcher");
  await downloadFabricServerJar(server);
  report?.(65, "Writing Minecraft configuration");
  await writeFile(ensureInsideServer(server, "server.properties"), `server-port=${serverPort}\n`, { flag: "wx" }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
  await writeFile(ensureInsideServer(server, "eula.txt"), `# Managed by ServerSentinel\n# Only set true if you accept the Minecraft EULA.\neula=${acceptEula ? "true" : "false"}\n`, "utf8");
  await writeFile(ensureInsideServer(server, "logs/latest.log"), "", { flag: "a" });
}

async function createManagedServer(input: CreateServerInput, report?: (progress: number, task: string) => void) {
  report?.(5, "Validating server settings");
  const displayName = input.displayName?.trim();
  const minecraftVersion = input.minecraftVersion?.trim();
  if (!displayName || !minecraftVersion) {
    throw new Error("Display name and Minecraft version are required");
  }
  if (!input.acceptEula) {
    throw new Error("You must confirm Minecraft EULA acceptance to create a runnable server");
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
  const serverJar = input.serverJar?.trim() || "fabric-server-launch.jar";
  const serverPort = input.serverPort?.trim() || "25565";
  if (!isValidServerPort(serverPort)) {
    throw new Error(`Server port must be between ${minServerPort} and ${maxServerPort}`);
  }

  const now = new Date().toISOString();
  const server: AttachedServer = {
    id: randomUUID(),
    displayName,
    serverDir: resolvedServerDir,
    storageName,
    minecraftVersion,
    loaderVersion,
    installerVersion,
    serverJar,
    dockerContainer: input.dockerContainer?.trim() || defaultContainerName(displayName),
    dockerImage: input.dockerImage?.trim() || defaultDockerImageForMinecraftVersion(minecraftVersion),
    dockerMountSource: config.serversDockerVolume || resolvedServerDir,
    dockerWorkingDir: config.serversDockerVolume ? `/data/servers/${storageName}` : undefined,
    dockerPorts: input.dockerPorts?.trim() || `${serverPort}:${serverPort}/tcp`,
    javaArgs: input.javaArgs?.trim() || "-Xms2G -Xmx4G",
    serverType: "fabric",
    createdAt: now,
    updatedAt: now
  };

  await createServerFiles(server, input.acceptEula, serverPort, report);
  if (dockerAvailable()) {
    report?.(78, "Pulling runtime image and creating Docker container");
    await ensureDockerContainer(server);
  } else {
    report?.(78, "Skipping Docker container creation; Docker socket is not mounted");
  }

  report?.(92, "Saving server registration");
  const servers = await readServers();
  servers.push(server);
  await writeServers(servers);
  report?.(100, "Server setup complete");
  return server;
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

  void createManagedServer(input, (progress, task) => {
    updateProvisionJob(id, { progress, task });
  }).then((server) => {
    updateProvisionJob(id, {
      status: "succeeded",
      progress: 100,
      task: "Server setup complete",
      server: publicServer(server)
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
    onlyWhenNoPlayers: Boolean(body.onlyWhenNoPlayers),
    enabled: body.enabled ?? existing?.enabled ?? true,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastRunAt: existing?.lastRunAt,
    lastStatus: existing?.lastStatus,
    lastMessage: existing?.lastMessage
  };
}

async function runScheduledExecution(server: AttachedServer, schedule: ScheduledExecution) {
  try {
    if (schedule.onlyWhenNoPlayers) {
      const count = await onlinePlayerCount(server);
      if (count === null) {
        return { status: "skipped", message: "Skipped because online player count could not be determined" };
      }
      if (count > 0) {
        return { status: "skipped", message: `Skipped because ${count} player${count === 1 ? "" : "s"} are online` };
      }
    }

    for (const command of schedule.commands) {
      await sendDockerStdinCommand(server, command);
    }
    return { status: "success", message: `Sent ${schedule.commands.length} command${schedule.commands.length === 1 ? "" : "s"}` };
  } catch (error) {
    return { status: "failed", message: error instanceof Error ? error.message : "Scheduled execution failed" };
  }
}

const runningSchedules = new Set<string>();

async function tickSchedules() {
  const now = new Date();
  const runKey = now.toISOString().slice(0, 16);
  const servers = await readServers();
  let changed = false;

  for (const server of servers) {
    for (const schedule of server.schedules ?? []) {
      if (!schedule.enabled) continue;
      const key = `${server.id}:${schedule.id}:${runKey}`;
      if (runningSchedules.has(key) || schedule.lastRunAt?.startsWith(runKey)) continue;
      try {
        if (!cronMatches(schedule.cron, now)) continue;
      } catch {
        continue;
      }

      runningSchedules.add(key);
      const result = await runScheduledExecution(server, schedule);
      schedule.lastRunAt = new Date().toISOString();
      schedule.lastStatus = result.status;
      schedule.lastMessage = result.message;
      schedule.updatedAt = schedule.lastRunAt;
      runningSchedules.delete(key);
      changed = true;
    }
  }

  if (changed) {
    await writeServers(servers);
  }
}

const app = Fastify({ logger: true, bodyLimit: 180 * 1024 * 1024 });
await app.register(websocket);

app.get("/api/auth/session", async (request) => {
  const users = await readUsers();
  const user = await currentUserFromCookie(request.headers.cookie);
  return {
    authenticated: Boolean(user),
    setupRequired: users.length === 0,
    user: user ? publicUser(user) : null
  };
});

app.post<{ Body: { username?: string; password?: string } }>("/api/auth/register-first", async (request, reply) => {
  const users = await readUsers();
  if (users.length > 0) {
    const error = new Error("Initial registration is already complete") as Error & { statusCode?: number };
    error.statusCode = 403;
    throw error;
  }
  const username = validateUsername(request.body.username);
  const password = validatePassword(request.body.password);
  const now = new Date().toISOString();
  const passwordData = hashPassword(password);
  const user: StoredUser = {
    id: randomUUID(),
    username,
    role: "admin",
    createdAt: now,
    updatedAt: now,
    ...passwordData
  };
  await writeUsers([user]);
  const sessionId = randomBytes(32).toString("base64url");
  sessions.set(sessionId, { id: sessionId, userId: user.id, createdAt: now });
  reply.header("Set-Cookie", sessionCookie(sessionId, 60 * 60 * 24 * 14));
  return { authenticated: true, setupRequired: false, user: publicUser(user) };
});

app.post<{ Body: { username?: string; password?: string } }>("/api/auth/login", async (request, reply) => {
  const username = request.body.username?.trim() ?? "";
  const password = request.body.password ?? "";
  if (username === "demo" && password === "demo") {
    return { authenticated: false, setupRequired: (await readUsers()).length === 0, demo: true, user: null };
  }
  const users = await readUsers();
  const user = users.find((candidate) => candidate.username.toLowerCase() === username.toLowerCase());
  if (!user || !verifyPassword(password, user)) {
    const error = new Error("Invalid username or password") as Error & { statusCode?: number };
    error.statusCode = 401;
    throw error;
  }
  const sessionId = randomBytes(32).toString("base64url");
  const now = new Date().toISOString();
  sessions.set(sessionId, { id: sessionId, userId: user.id, createdAt: now });
  reply.header("Set-Cookie", sessionCookie(sessionId, 60 * 60 * 24 * 14));
  return { authenticated: true, setupRequired: false, user: publicUser(user) };
});

app.post("/api/auth/logout", async (request, reply) => {
  const sessionId = parseCookies(request.headers.cookie).get(sessionCookieName);
  if (sessionId) {
    sessions.delete(sessionId);
  }
  reply.header("Set-Cookie", sessionCookie("", 0));
  return { ok: true };
});

app.get("/api/users", async (request) => {
  await requireRequestPermission(request, "admin");
  return { users: (await readUsers()).map(publicUser) };
});

app.post<{ Body: { username?: string; password?: string; role?: UserRole } }>("/api/users", async (request) => {
  await requireRequestPermission(request, "admin");
  const username = validateUsername(request.body.username);
  const password = validatePassword(request.body.password);
  const role = normalizeRole(request.body.role);
  const users = await readUsers();
  if (users.some((user) => user.username.toLowerCase() === username.toLowerCase())) {
    const error = new Error("A user with that username already exists") as Error & { statusCode?: number };
    error.statusCode = 400;
    throw error;
  }
  const now = new Date().toISOString();
  const user: StoredUser = {
    id: randomUUID(),
    username,
    role,
    createdAt: now,
    updatedAt: now,
    ...hashPassword(password)
  };
  users.push(user);
  await writeUsers(users);
  return publicUser(user);
});

app.put<{ Params: { id: string }; Body: { username?: string; password?: string; role?: UserRole } }>("/api/users/:id", async (request) => {
  await requireRequestPermission(request, "admin");
  const users = await readUsers();
  const index = users.findIndex((user) => user.id === request.params.id);
  if (index === -1) {
    const error = new Error("User not found") as Error & { statusCode?: number };
    error.statusCode = 404;
    throw error;
  }
  const current = users[index];
  const username = request.body.username === undefined ? current.username : validateUsername(request.body.username);
  const role = request.body.role === undefined ? current.role : normalizeRole(request.body.role);
  const password = request.body.password?.trim() ? validatePassword(request.body.password) : undefined;
  if (users.some((user) => user.id !== current.id && user.username.toLowerCase() === username.toLowerCase())) {
    const error = new Error("A user with that username already exists") as Error & { statusCode?: number };
    error.statusCode = 400;
    throw error;
  }
  const adminCount = users.filter((user) => user.role === "admin").length;
  if (current.role === "admin" && role !== "admin" && adminCount <= 1) {
    const error = new Error("At least one admin user is required") as Error & { statusCode?: number };
    error.statusCode = 400;
    throw error;
  }
  users[index] = {
    ...current,
    username,
    role,
    updatedAt: new Date().toISOString(),
    ...(password ? hashPassword(password) : {})
  };
  await writeUsers(users);
  return publicUser(users[index]);
});

app.delete<{ Params: { id: string } }>("/api/users/:id", async (request) => {
  await requireRequestPermission(request, "admin");
  const users = await readUsers();
  const user = users.find((candidate) => candidate.id === request.params.id);
  if (!user) {
    const error = new Error("User not found") as Error & { statusCode?: number };
    error.statusCode = 404;
    throw error;
  }
  if (user.role === "admin" && users.filter((candidate) => candidate.role === "admin").length <= 1) {
    const error = new Error("At least one admin user is required") as Error & { statusCode?: number };
    error.statusCode = 400;
    throw error;
  }
  await writeUsers(users.filter((candidate) => candidate.id !== request.params.id));
  for (const [sessionId, session] of sessions) {
    if (session.userId === request.params.id) {
      sessions.delete(sessionId);
    }
  }
  return { ok: true };
});

app.addHook("preHandler", async (request) => {
  if (!request.raw.url?.startsWith("/api/") || request.raw.url.startsWith("/api/auth/")) {
    return;
  }
  await requireRequestPermission(request);
});

app.get("/api/app", async (request) => {
  const user = await requireRequestPermission(request);
  const servers = await readServers();
  return {
    servers: servers.map(publicServer),
    modrinthApiConfigured: Boolean(await modrinthApiKey()),
    dockerSocketMounted: dockerAvailable(),
    totalMemory: totalmem(),
    currentUser: publicUser(user)
  };
});

app.put<{ Body: { modrinthApiKey?: string } }>("/api/settings/modrinth", async (request) => {
  await requireRequestPermission(request, "manager");
  const key = request.body.modrinthApiKey?.trim();
  if (!key) {
    throw new Error("Modrinth API key is required");
  }
  const settings = await readSettings();
  settings.modrinthApiKey = key;
  await writeSettings(settings);
  return { ok: true, modrinthApiConfigured: true };
});

app.get("/api/fabric/versions", async () => {
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
}>("/api/servers", async (request) => {
  await requireRequestPermission(request, "manager");
  const server = await createManagedServer(request.body);
  return publicServer(server);
});

app.post<{ Body: CreateServerInput }>("/api/servers/provision", async (request) => {
  await requireRequestPermission(request, "manager");
  const job = startProvisionJob(request.body);
  return job;
});

app.get<{ Params: { id: string } }>("/api/provision/:id", async (request, reply) => {
  const job = provisionJobs.get(request.params.id);
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
}>("/api/servers/:id", async (request) => {
  await requireRequestPermission(request, "manager");
  const servers = await readServers();
  const index = servers.findIndex((candidate) => candidate.id === request.params.id);
  if (index === -1) {
    throw new Error("Server not found");
  }

  const current = servers[index];
  const minecraftVersion = request.body.minecraftVersion?.trim() || current.minecraftVersion;
  const loaderVersion = request.body.loaderVersion?.trim() || current.loaderVersion || await latestFabricVersion("loader");
  const installerVersion = request.body.installerVersion?.trim() || current.installerVersion || await latestFabricVersion("installer");
  const serverJar = request.body.serverJar?.trim() || current.serverJar || "fabric-server-launch.jar";
  const serverPort = request.body.serverPort?.trim();
  if (serverPort && !isValidServerPort(serverPort)) {
    throw new Error(`Server port must be between ${minServerPort} and ${maxServerPort}`);
  }

  const jarChanged = current.minecraftVersion !== minecraftVersion
    || current.loaderVersion !== loaderVersion
    || current.installerVersion !== installerVersion
    || current.serverJar !== serverJar;

  const updated: AttachedServer = {
    ...current,
    displayName: request.body.displayName?.trim() || current.displayName,
    minecraftVersion,
    loaderVersion,
    installerVersion,
    serverJar,
    dockerContainer: request.body.dockerContainer?.trim() || current.dockerContainer,
    dockerImage: request.body.dockerImage?.trim() || current.dockerImage || defaultDockerImageForMinecraftVersion(minecraftVersion),
    dockerPorts: request.body.dockerPorts?.trim() || (serverPort ? `${serverPort}:${serverPort}/tcp` : current.dockerPorts),
    javaArgs: request.body.javaArgs?.trim() || current.javaArgs,
    updatedAt: new Date().toISOString()
  };

  if (jarChanged) {
    await downloadFabricServerJar(updated);
  }
  if (serverPort) {
    await writeFile(ensureInsideServer(updated, "server.properties"), `server-port=${serverPort}\n`, { flag: "wx" }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
  }

  servers[index] = updated;
  await writeServers(servers);
  return publicServer(updated);
});

app.delete<{
  Params: { id: string };
  Body: {
    confirmName?: string;
    deleteFiles?: boolean;
  };
}>("/api/servers/:id", async (request) => {
  await requireRequestPermission(request, "manager");
  const servers = await readServers();
  const index = servers.findIndex((candidate) => candidate.id === request.params.id);
  if (index === -1) {
    throw new Error("Server not found");
  }

  const server = servers[index];
  if (request.body.confirmName !== server.displayName) {
    throw new Error(`Type "${server.displayName}" to confirm deletion`);
  }

  const deletedContainer = dockerAvailable() ? await removeManagedDockerContainer(server) : false;
  let deletedFiles = false;
  if (request.body.deleteFiles) {
    const directory = ensureManagedServerDirectory(server);
    await rm(directory, { recursive: true, force: true });
    deletedFiles = true;
  }

  servers.splice(index, 1);
  await writeServers(servers);
  return { ok: true, deletedFiles, deletedContainer };
});

app.get<{ Params: { id: string } }>("/api/servers/:id/status", async (request) => {
  const server = await getServer(request.params.id);
  const latestLogPath = ensureInsideServer(server, "logs/latest.log");
  const docker = await dockerStatus(server);
  return {
    server: publicServer(server),
    docker: docker,
    fileLogsAvailable: existsSync(latestLogPath),
    controlAvailable: Boolean(dockerControlConfigured(server) && dockerAvailable()),
    commandInputAvailable: Boolean(dockerControlConfigured(server) && dockerAvailable() && docker.running),
    commandInputMessage: dockerControlConfigured(server) && dockerAvailable()
      ? docker.running
        ? "Console command input is enabled for the running Docker runtime container"
        : "Start the runtime container before sending console commands"
      : "Console command input requires Docker control and a mounted Docker socket"
  };
});

app.post<{ Params: { id: string } }>("/api/servers/:id/start", async (request) => {
  await requireRequestPermission(request, "basic");
  return dockerAction(await getServer(request.params.id), "start");
});

app.post<{ Params: { id: string } }>("/api/servers/:id/stop", async (request) => {
  await requireRequestPermission(request, "basic");
  return dockerAction(await getServer(request.params.id), "stop");
});

app.post<{ Params: { id: string } }>("/api/servers/:id/restart", async (request) => {
  await requireRequestPermission(request, "basic");
  return dockerAction(await getServer(request.params.id), "restart");
});

app.post<{ Params: { id: string }; Body: { command?: string } }>("/api/servers/:id/command", async (request) => {
  await requireRequestPermission(request, "expanded");
  const server = await getServer(request.params.id);
  return sendDockerStdinCommand(server, request.body.command ?? "");
});

app.get<{ Params: { id: string } }>("/api/servers/:id/schedules", async (request) => {
  const server = await getServer(request.params.id);
  return { schedules: server.schedules ?? [] };
});

app.post<{
  Params: { id: string };
  Body: { name?: string; cron?: string; commands?: unknown; onlyWhenNoPlayers?: boolean; enabled?: boolean };
}>("/api/servers/:id/schedules", async (request) => {
  await requireRequestPermission(request, "expanded");
  const servers = await readServers();
  const index = servers.findIndex((candidate) => candidate.id === request.params.id);
  if (index === -1) {
    throw new Error("Server not found");
  }
  const schedule = scheduleFromBody(request.body);
  servers[index].schedules = [...(servers[index].schedules ?? []), schedule];
  servers[index].updatedAt = new Date().toISOString();
  await writeServers(servers);
  return schedule;
});

app.put<{
  Params: { id: string; scheduleId: string };
  Body: { name?: string; cron?: string; commands?: unknown; onlyWhenNoPlayers?: boolean; enabled?: boolean };
}>("/api/servers/:id/schedules/:scheduleId", async (request) => {
  await requireRequestPermission(request, "expanded");
  const servers = await readServers();
  const serverIndex = servers.findIndex((candidate) => candidate.id === request.params.id);
  if (serverIndex === -1) {
    throw new Error("Server not found");
  }
  const schedules = servers[serverIndex].schedules ?? [];
  const scheduleIndex = schedules.findIndex((candidate) => candidate.id === request.params.scheduleId);
  if (scheduleIndex === -1) {
    throw new Error("Schedule not found");
  }
  schedules[scheduleIndex] = scheduleFromBody(request.body, schedules[scheduleIndex]);
  servers[serverIndex].schedules = schedules;
  servers[serverIndex].updatedAt = new Date().toISOString();
  await writeServers(servers);
  return schedules[scheduleIndex];
});

app.delete<{ Params: { id: string; scheduleId: string } }>("/api/servers/:id/schedules/:scheduleId", async (request) => {
  await requireRequestPermission(request, "expanded");
  const servers = await readServers();
  const serverIndex = servers.findIndex((candidate) => candidate.id === request.params.id);
  if (serverIndex === -1) {
    throw new Error("Server not found");
  }
  servers[serverIndex].schedules = (servers[serverIndex].schedules ?? []).filter((schedule) => schedule.id !== request.params.scheduleId);
  servers[serverIndex].updatedAt = new Date().toISOString();
  await writeServers(servers);
  return { ok: true };
});

app.get("/ws/console", { websocket: true }, async (socket, request) => {
  const client = socket as unknown as Client;
  const url = new URL(request.url, "http://localhost");
  const serverId = url.searchParams.get("serverId") ?? undefined;
  try {
    await requireAuthenticated(request.headers.cookie);
    const server = await getServer(serverId);
    client.send(JSON.stringify({ type: "status", status: await dockerStatus(server) }));
    if (dockerControlConfigured(server) && dockerAvailable()) {
      const logRequest = streamDockerLogs(server, client);
      socket.on("close", () => logRequest?.destroy());
      return;
    }

    const stopFileLogs = streamLatestServerLog(server, client);
    socket.on("close", stopFileLogs);
  } catch (error) {
    client.send(JSON.stringify({ type: "unavailable", message: (error as Error).message }));
  }
});

app.get<{ Params: { id: string } }>("/api/servers/:id/logs", async (request) => {
  const server = await getServer(request.params.id);
  if (dockerControlConfigured(server) && dockerAvailable()) {
    return { text: await dockerRecentLogs(server), source: "docker" };
  }
  return { text: await readLatestServerLog(server), source: "logs/latest.log" };
});

app.get<{ Params: { id: string } }>("/api/servers/:id/stats", async (request) => {
  return dockerResourceStats(await getServer(request.params.id));
});

app.get<{ Params: { id: string } }>("/api/servers/:id/events", async (request) => {
  return serverOverviewData(await getServer(request.params.id));
});

app.get<{ Params: { id: string }; Querystring: { path?: string } }>("/api/servers/:id/files", async (request) => {
  const server = await getServer(request.params.id);
  const target = ensureInsideServer(server, request.query.path ?? ".");
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
          const entryStat = await stat(absolutePath);
          return {
            name: entry.name,
            path: toPublicPath(server, absolutePath),
            type: entry.isDirectory() ? "directory" : "file",
            size: entryStat.size,
            modifiedAt: entryStat.mtime.toISOString()
          };
        })
    )
  };
});

app.get<{ Params: { id: string }; Querystring: { path?: string } }>("/api/servers/:id/file", async (request) => {
  const server = await getServer(request.params.id);
  const target = ensureInsideServer(server, request.query.path ?? "");
  const targetStat = await stat(target);
  if (!targetStat.isFile()) {
    throw new Error("Path is not a file");
  }
  if (targetStat.size > 2 * 1024 * 1024) {
    throw new Error("File is larger than the 2 MiB editor limit");
  }
  const buffer = await readFile(target);
  if (buffer.includes(0)) {
    throw new Error("Binary files cannot be edited in the browser editor");
  }
  return {
    path: toPublicPath(server, target),
    content: buffer.toString("utf8"),
    modifiedAt: targetStat.mtime.toISOString()
  };
});

app.put<{ Params: { id: string }; Body: { path?: string; content?: string } }>("/api/servers/:id/file", async (request) => {
  await requireRequestPermission(request, "manager");
  const server = await getServer(request.params.id);
  const target = ensureInsideServer(server, request.body.path ?? "");
  if (typeof request.body.content !== "string") {
    throw new Error("Content is required");
  }
  const targetStat = await stat(target);
  if (!targetStat.isFile()) {
    throw new Error("Path is not a file");
  }
  await writeFile(target, request.body.content, "utf8");
  return { ok: true, path: toPublicPath(server, target) };
});

app.delete<{ Params: { id: string }; Querystring: { path?: string } }>("/api/servers/:id/file", async (request) => {
  await requireRequestPermission(request, "manager");
  const server = await getServer(request.params.id);
  const target = ensureInsideServer(server, request.query.path ?? "");
  if (resolve(target) === resolve(server.serverDir)) {
    throw new Error("Refusing to delete the server root directory");
  }
  const publicPath = toPublicPath(server, target);
  await rm(target, { recursive: true, force: true });
  if (publicPath.startsWith("/mods/") && (publicPath.endsWith(".jar") || publicPath.endsWith(".jar.disabled"))) {
    await deleteModIcon(server, basename(publicPath));
  }
  return { ok: true, path: publicPath };
});



function normalizeReleaseChannel(channel?: string): ReleaseChannel {
  return channel === "alpha" || channel === "beta" ? channel : "release";
}

async function readModPreferences(server: AttachedServer): Promise<Record<string, ModPreference>> {
  const path = ensureInsideServer(server, "mods/.serversentinel-mods.json");
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, ModPreference>;
  } catch {
    return {};
  }
}

async function writeModPreferences(server: AttachedServer, data: Record<string, ModPreference>) {
  const path = ensureInsideServer(server, "mods/.serversentinel-mods.json");
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function versionChannel(versionType?: string): ReleaseChannel {
  return normalizeReleaseChannel(versionType);
}

async function lookupModrinthUpdate(server: AttachedServer, modPath: string, preferredChannel: ReleaseChannel) {
  if (!server.minecraftVersion) return null;
  const hash = createHash("sha1").update(await readFile(modPath)).digest("hex");
  const currentRes = await modrinthFetch(`https://api.modrinth.com/v2/version_file/${hash}?algorithm=sha1`);
  const current = await currentRes.json() as { project_id?: string; version_number?: string; version_type?: string };
  if (!current.project_id) return null;
  const versionsUrl = new URL(`https://api.modrinth.com/v2/project/${encodeURIComponent(current.project_id)}/version`);
  versionsUrl.searchParams.set("loaders", JSON.stringify(["fabric"]));
  versionsUrl.searchParams.set("game_versions", JSON.stringify([server.minecraftVersion]));
  const versionsRes = await modrinthFetch(versionsUrl.toString());
  const versions = await versionsRes.json() as Array<{ version_number: string; version_type: string }>;
  const channelRank: Record<ReleaseChannel, number> = { release: 0, beta: 1, alpha: 2 };
  const target = versions.find((v) => channelRank[versionChannel(v.version_type)] <= channelRank[preferredChannel]);
  return {
    projectId: current.project_id,
    currentVersion: current.version_number,
    currentChannel: versionChannel(current.version_type),
    latestVersion: target?.version_number,
    latestChannel: target ? versionChannel(target.version_type) : undefined,
    upToDate: Boolean(target && current.version_number === target.version_number)
  };
}
app.get<{ Params: { id: string } }>("/api/servers/:id/mods", async (request) => {
  const server = await getServer(request.params.id);
  const modsDir = ensureInsideServer(server, "mods");
  await mkdir(modsDir, { recursive: true });
  const entries = await readdir(modsDir, { withFileTypes: true });
  const prefs = await readModPreferences(server);
  return {
    mods: await Promise.all(
      entries
        .filter((entry) => entry.isFile() && (entry.name.endsWith(".jar") || entry.name.endsWith(".jar.disabled")))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(async (entry) => {
          const modPath = join(modsDir, entry.name);
          await ensureModrinthIconForFile(server, entry.name, modPath);
          const modStat = await stat(modPath);
          const preferredChannel = normalizeReleaseChannel(prefs[entry.name]?.channel);
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
            versionInfo
          };
        })
    )
  };
});

app.get<{ Params: { id: string }; Querystring: { filename?: string } }>("/api/servers/:id/mods/icon", async (request, reply) => {
  const server = await getServer(request.params.id);
  const filename = safeInstalledModFilename(request.query.filename);
  const iconsDir = ensureInsideServer(server, "mods/.serversentinel-icons");
  const key = modIconKey(filename);
  const icon = existsSync(iconsDir) ? (await readdir(iconsDir)).find((entry) => entry.startsWith(`${key}.`)) : undefined;
  if (!icon) {
    reply.code(404);
    return { error: "Icon not found" };
  }
  const extension = extname(icon).toLowerCase();
  const contentType = extension === ".webp" ? "image/webp" : extension === ".jpg" || extension === ".jpeg" ? "image/jpeg" : "image/png";
  reply.header("Content-Type", contentType);
  return reply.send(createReadStream(join(iconsDir, icon)));
});

app.patch<{ Params: { id: string }; Body: { filename?: string; enabled?: boolean } }>("/api/servers/:id/mods", async (request) => {
  await requireRequestPermission(request, "manager");
  const server = await getServer(request.params.id);
  await ensureServerStoppedForModChanges(server);
  const filename = safeInstalledModFilename(request.body.filename);
  const enabled = Boolean(request.body.enabled);
  const source = ensureInsideServer(server, join("mods", filename));
  const targetName = enabled
    ? filename.replace(/\.jar\.disabled$/, ".jar")
    : filename.endsWith(".jar.disabled")
      ? filename
      : `${filename}.disabled`;
  if (filename === targetName) {
    return { ok: true, filename: targetName, enabled };
  }
  const target = ensureInsideServer(server, join("mods", safeInstalledModFilename(targetName)));
  await rename(source, target);
  return { ok: true, filename: basename(target), enabled };
});


app.put<{ Params: { id: string }; Body: { filename?: string; channel?: ReleaseChannel } }>("/api/servers/:id/mods/channel", async (request) => {
  await requireRequestPermission(request, "manager");
  const server = await getServer(request.params.id);
  const filename = safeInstalledModFilename(request.body.filename);
  const channel = normalizeReleaseChannel(request.body.channel);
  const prefs = await readModPreferences(server);
  prefs[filename] = { channel };
  await writeModPreferences(server, prefs);
  return { ok: true, filename, channel };
});

app.delete<{ Params: { id: string }; Querystring: { filename?: string } }>("/api/servers/:id/mods", async (request) => {
  await requireRequestPermission(request, "manager");
  const server = await getServer(request.params.id);
  await ensureServerStoppedForModChanges(server);
  const filename = safeInstalledModFilename(request.query.filename);
  const target = ensureInsideServer(server, join("mods", filename));
  await rm(target, { force: true });
  await deleteModIcon(server, filename);
  return { ok: true, filename };
});

app.post<{ Params: { id: string }; Body: { filename?: string; contentBase64?: string } }>("/api/servers/:id/mods/upload", async (request) => {
  await requireRequestPermission(request, "manager");
  const server = await getServer(request.params.id);
  await ensureServerStoppedForModChanges(server);
  const filename = safeModFilename(safeInstalledModFilename(request.body.filename));
  if (!request.body.contentBase64) {
    throw new Error("Uploaded mod content is required");
  }
  const content = Buffer.from(request.body.contentBase64, "base64");
  if (!content.length || content.length > 128 * 1024 * 1024) {
    throw new Error("Uploaded mod must be between 1 byte and 128 MiB");
  }
  const modsDir = ensureInsideServer(server, "mods");
  await mkdir(modsDir, { recursive: true });
  const destination = ensureInsideServer(server, join("mods", filename));
  await writeFile(destination, content);
  await deleteModIcon(server, filename);
  return { ok: true, filename: basename(destination), path: toPublicPath(server, destination) };
});

app.get<{ Querystring: { query?: string; serverId?: string } }>("/api/modrinth/search", async (request) => {
  const query = request.query.query?.trim();
  if (!query) {
    return { hits: [] };
  }
  const server = await getServer(request.query.serverId);
  if (!server.minecraftVersion || !server.loaderVersion) {
    throw new Error("Minecraft and Fabric loader versions are required before searching compatible mods");
  }

  const facets = [["project_type:mod"], ["categories:fabric"]];
  facets.push([`versions:${server.minecraftVersion}`]);

  const url = new URL("https://api.modrinth.com/v2/search");
  url.searchParams.set("query", query);
  url.searchParams.set("limit", "20");
  url.searchParams.set("facets", JSON.stringify(facets));
  const response = await modrinthFetch(url.toString());
  return response.json();
});

app.post<{ Body: { serverId?: string; projectId?: string; channel?: ReleaseChannel } }>("/api/modrinth/install", async (request) => {
  await requireRequestPermission(request, "manager");
  const server = await getServer(request.body.serverId);
  await ensureServerStoppedForModChanges(server);
  const projectId = request.body.projectId?.trim();
  if (!projectId || !server.minecraftVersion || !server.loaderVersion) {
    throw new Error("projectId, Minecraft version, and Fabric loader version are required for compatible Fabric installs");
  }

  const versionsUrl = new URL(`https://api.modrinth.com/v2/project/${encodeURIComponent(projectId)}/version`);
  const projectUrl = new URL(`https://api.modrinth.com/v2/project/${encodeURIComponent(projectId)}`);
  versionsUrl.searchParams.set("loaders", JSON.stringify(["fabric"]));
  versionsUrl.searchParams.set("game_versions", JSON.stringify([server.minecraftVersion]));
  const [versionsResponse, projectResponse] = await Promise.all([modrinthFetch(versionsUrl.toString()), modrinthFetch(projectUrl.toString())]);
  const project = await projectResponse.json() as { icon_url?: string | null };
  const versions = (await versionsResponse.json()) as Array<{
    version_number: string;
    version_type: string;
    files: Array<{ url: string; filename: string; primary: boolean }>;
  }>;
  const selectedChannel = normalizeReleaseChannel(request.body.channel);
  const channelRank: Record<ReleaseChannel, number> = { release: 0, beta: 1, alpha: 2 };
  const version = versions.find((candidate) => channelRank[versionChannel(candidate.version_type)] <= channelRank[selectedChannel]);
  const file = version?.files.find((candidate) => candidate.primary && candidate.filename.endsWith(".jar"))
    ?? version?.files.find((candidate) => candidate.filename.endsWith(".jar"));
  if (!version || !file) {
    throw new Error("No compatible Fabric .jar file was found for that Minecraft version");
  }
  if (!file.url.startsWith("https://")) {
    throw new Error("Refusing to download a non-HTTPS mod file");
  }

  const modsDir = ensureInsideServer(server, "mods");
  await mkdir(modsDir, { recursive: true });
  const destination = ensureInsideServer(server, join("mods", safeModFilename(file.filename)));
  const downloadResponse = await modrinthFetch(file.url);
  if (!downloadResponse.body) {
    throw new Error("Mod download returned no body");
  }
  await pipeline(
    Readable.fromWeb(downloadResponse.body as unknown as NodeReadableStream<Uint8Array>),
    createWriteStream(destination)
  );
  await saveModIcon(server, basename(destination), project.icon_url);

  return {
    ok: true,
    projectId,
    version: version.version_number,
    filename: basename(destination),
    path: toPublicPath(server, destination),
    channel: versionChannel(version.version_type)
  };
});

const webDist = resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
if (existsSync(webDist)) {
  await app.register(fastifyStatic, {
    root: webDist,
    prefix: "/",
    wildcard: false
  });
  app.setNotFoundHandler((request, reply) => {
    if (request.raw.url?.startsWith("/api/") || request.raw.url?.startsWith("/ws/")) {
      reply.code(404).send({ error: "Not found" });
      return;
    }
    reply.sendFile("index.html");
  });
}

app.setErrorHandler((error, _request, reply) => {
  app.log.error(error);
  const statusCode = error instanceof Error && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 400;
  reply.code(statusCode).send({ error: error instanceof Error ? error.message : "Request failed" });
});

setInterval(() => {
  void tickSchedules().catch((error: unknown) => app.log.error(error));
}, 30_000).unref();

await app.listen({ host: "0.0.0.0", port: config.port });
