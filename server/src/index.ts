import Fastify from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { fileURLToPath } from "node:url";
import { fetch } from "undici";
import { totalmem } from "node:os";

const config = {
  configDir: resolve(process.env.SERVERSENTINEL_CONFIG_DIR ?? "/config"),
  serversDir: resolve(process.env.SERVERSENTINEL_SERVERS_DIR ?? "/data/servers"),
  serversDockerVolume: process.env.SERVERSENTINEL_SERVERS_DOCKER_VOLUME ?? "",
  dockerSocket: process.env.DOCKER_SOCKET ?? "/var/run/docker.sock",
  port: Number(process.env.PORT ?? "8080")
};

const serversFile = join(config.configDir, "servers.json");
const settingsFile = join(config.configDir, "settings.json");
const minServerPort = 1000;
const maxServerPort = 65000;

type AppSettings = {
  modrinthApiKey?: string;
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
  serverType: "fabric";
  createdAt: string;
  updatedAt: string;
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

function isValidServerPort(port: string) {
  if (!/^\d+$/.test(port)) return false;
  const value = Number(port);
  return value >= minServerPort && value <= maxServerPort;
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
  method: "GET" | "POST",
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

function dockerControlConfigured(server: AttachedServer) {
  return Boolean(server.dockerContainer || (server.dockerMountSource && server.serverJar));
}

function serverDockerMountSource(server: AttachedServer) {
  if (server.dockerMountSource && server.dockerMountSource !== server.serverDir) {
    return server.dockerMountSource;
  }
  return config.serversDockerVolume || server.dockerMountSource || server.serverDir;
}

function serverDockerWorkingDir(server: AttachedServer) {
  if (server.dockerWorkingDir) {
    return server.dockerWorkingDir;
  }
  if (config.serversDockerVolume && server.storageName) {
    return `/data/servers/${server.storageName}`;
  }
  return "/data/server";
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
    return await dockerRequest<{ State?: { Status?: DockerState; Running?: boolean }; Name?: string }>(
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
    return;
  }
  if (!serverDockerMountSource(server) || !server.serverJar) {
    throw new Error("Docker managed control requires Docker mount source and server jar filename");
  }

  const image = server.dockerImage || "eclipse-temurin:21-jre";
  await ensureDockerImage(image);
  const { exposedPorts, portBindings } = parseDockerPorts(server.dockerPorts || "25565:25565/tcp");
  const javaArgs = server.javaArgs || "-Xms2G -Xmx4G";
  const command = `exec java ${javaArgs} -jar ${server.serverJar} nogui`;
  const workingDir = serverDockerWorkingDir(server);
  const usesSharedServersVolume = workingDir.startsWith("/data/servers/");
  const bindTarget = usesSharedServersVolume ? "/data/servers" : "/data/server";

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
        Binds: [`${serverDockerMountSource(server)}:${bindTarget}`],
        PortBindings: portBindings
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
    dockerImage: input.dockerImage?.trim() || "eclipse-temurin:21-jre",
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

const app = Fastify({ logger: true });
await app.register(websocket);

app.get("/api/app", async () => {
  const servers = await readServers();
  return {
    servers: servers.map(publicServer),
    modrinthApiConfigured: Boolean(await modrinthApiKey()),
    dockerSocketMounted: dockerAvailable(),
    totalMemory: totalmem()
  };
});

app.put<{ Body: { modrinthApiKey?: string } }>("/api/settings/modrinth", async (request) => {
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
  const server = await createManagedServer(request.body);
  return publicServer(server);
});

app.post<{ Body: CreateServerInput }>("/api/servers/provision", async (request) => {
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
    dockerImage: request.body.dockerImage?.trim() || current.dockerImage || "eclipse-temurin:21-jre",
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
  const servers = await readServers();
  const index = servers.findIndex((candidate) => candidate.id === request.params.id);
  if (index === -1) {
    throw new Error("Server not found");
  }

  const server = servers[index];
  if (request.body.confirmName !== server.displayName) {
    throw new Error(`Type "${server.displayName}" to confirm deletion`);
  }

  let deletedFiles = false;
  if (request.body.deleteFiles) {
    const directory = ensureManagedServerDirectory(server);
    await rm(directory, { recursive: true, force: true });
    deletedFiles = true;
  }

  servers.splice(index, 1);
  await writeServers(servers);
  return { ok: true, deletedFiles };
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
  return dockerAction(await getServer(request.params.id), "start");
});

app.post<{ Params: { id: string } }>("/api/servers/:id/stop", async (request) => {
  return dockerAction(await getServer(request.params.id), "stop");
});

app.post<{ Params: { id: string } }>("/api/servers/:id/restart", async (request) => {
  return dockerAction(await getServer(request.params.id), "restart");
});

app.post<{ Params: { id: string }; Body: { command?: string } }>("/api/servers/:id/command", async (request) => {
  const server = await getServer(request.params.id);
  return sendDockerStdinCommand(server, request.body.command ?? "");
});

app.get("/ws/console", { websocket: true }, async (socket, request) => {
  const client = socket as unknown as Client;
  const url = new URL(request.url, "http://localhost");
  const serverId = url.searchParams.get("serverId") ?? undefined;
  try {
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

app.get<{ Querystring: { query?: string; gameVersion?: string } }>("/api/modrinth/search", async (request) => {
  const query = request.query.query?.trim();
  if (!query) {
    return { hits: [] };
  }

  const facets = [["project_type:mod"], ["categories:fabric"]];
  if (request.query.gameVersion?.trim()) {
    facets.push([`versions:${request.query.gameVersion.trim()}`]);
  }

  const url = new URL("https://api.modrinth.com/v2/search");
  url.searchParams.set("query", query);
  url.searchParams.set("limit", "20");
  url.searchParams.set("facets", JSON.stringify(facets));
  const response = await modrinthFetch(url.toString());
  return response.json();
});

app.post<{ Body: { serverId?: string; projectId?: string; gameVersion?: string } }>("/api/modrinth/install", async (request) => {
  const server = await getServer(request.body.serverId);
  const projectId = request.body.projectId?.trim();
  const gameVersion = request.body.gameVersion?.trim();
  if (!projectId || !gameVersion) {
    throw new Error("projectId and gameVersion are required for compatible Fabric installs");
  }

  const versionsUrl = new URL(`https://api.modrinth.com/v2/project/${encodeURIComponent(projectId)}/version`);
  versionsUrl.searchParams.set("loaders", JSON.stringify(["fabric"]));
  versionsUrl.searchParams.set("game_versions", JSON.stringify([gameVersion]));
  const versionsResponse = await modrinthFetch(versionsUrl.toString());
  const versions = (await versionsResponse.json()) as Array<{
    version_number: string;
    files: Array<{ url: string; filename: string; primary: boolean }>;
  }>;
  const version = versions[0];
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

  return {
    ok: true,
    projectId,
    version: version.version_number,
    filename: basename(destination),
    path: toPublicPath(server, destination)
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
  reply.code(400).send({ error: error instanceof Error ? error.message : "Request failed" });
});

await app.listen({ host: "0.0.0.0", port: config.port });
