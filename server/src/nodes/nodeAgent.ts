import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import WebSocket from "ws";
import { fetch } from "undici";
import { config } from "../config.js";
import { dockerAvailable, dockerBufferRequest, dockerErrorMessage, dockerJsonRequest, dockerRequest } from "../docker/dockerClient.js";
import { latestFabricVersion } from "../fabric/fabricClient.js";
import { fetchProject, resolveModrinthProjectCompatibility } from "../modrinth/compatibility.js";
import { modrinthFetch } from "../modrinth/modrinthClient.js";
import type { ManagedServer } from "../types.js";
import { nodeCapabilities, nodeProtocolVersion } from "./protocol.js";
import type { NodeHello, NodeRequestMessage, NodeResponseMessage, NodeStreamDataMessage, NodeStreamEndMessage, NodeStreamStartMessage, NodeStreamStopMessage, PanelWelcome } from "./protocol.js";

type NodeConfig = { nodeId: string; nodeSecret: string };
type CreateInput = {
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

const nodeConfigPath = join(config.nodeDataDir, "node", "config.json");
const serversRoot = resolve(config.nodeDataDir, "servers");
const editorFileSizeLimit = 2 * 1024 * 1024;
const uploadLimit = 128 * 1024 * 1024;
const reconnectDelayMs = 5000;

async function readNodeConfig() {
  try { return JSON.parse(await readFile(nodeConfigPath, "utf8")) as NodeConfig; } catch { return null; }
}

async function writeNodeConfig(nodeConfig: NodeConfig) {
  await mkdir(dirname(nodeConfigPath), { recursive: true });
  await writeFile(nodeConfigPath, `${JSON.stringify(nodeConfig, null, 2)}\n`, "utf8");
}

function panelWebSocketUrl() {
  if (!config.panelUrl) throw new Error("SS_PANEL_URL is required in SS_MODE=node");
  const url = new URL(config.panelUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/api/nodes/connect";
  url.search = "";
  return url.toString();
}

function slugify(input: string) {
  return input.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || randomUUID();
}

function safeName(value: unknown) {
  const name = basename(typeof value === "string" ? value.trim() : "");
  if (!name || name === "." || name === ".." || /[<>:"/\\|?*\u0000-\u001f]/.test(name)) throw new Error("A valid filename is required");
  return name;
}

function safeRelative(value: unknown) {
  const raw = typeof value === "string" ? value.replaceAll("\\", "/") : ".";
  if (raw.includes("\0") || raw.startsWith("/") || raw.split("/").includes("..")) throw new Error("Invalid relative path");
  return raw === "" ? "." : raw;
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
  const target = resolve(root, safeRelative(rel));
  if (target !== root && !target.startsWith(root + sep)) throw new Error("Path escapes server directory");
  if (mustExist) {
    const realRoot = resolve(root);
    const realTarget = resolve(target);
    const st = await lstat(realTarget);
    if (st.isSymbolicLink()) throw new Error("Symlink paths are not allowed");
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) throw new Error("Path escapes server directory");
  }
  return target;
}

function publicPath(root: string, target: string) {
  const rel = relative(root, target).replaceAll("\\", "/");
  return rel ? `/${rel}` : "/";
}

function defaultContainerName(displayName: string) {
  return `serversentinel-${slugify(displayName)}`;
}

function containerName(server: ManagedServer) {
  return server.dockerContainer?.trim() || defaultContainerName(server.displayName);
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
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
  if (major === 1 && Number.isFinite(minor) && minor >= 20 && (minor > 20 || (patch ?? 0) >= 5)) return "eclipse-temurin:21-jre";
  return "eclipse-temurin:17-jre";
}

async function pullImage(image: string) {
  const [fromImage, tag] = image.includes(":") ? image.split(/:(.*)/, 2) : [image, "latest"];
  await dockerBufferRequest("POST", `/images/create?fromImage=${encodeURIComponent(fromImage)}&tag=${encodeURIComponent(tag || "latest")}`, [200, 201]);
}

async function createContainer(server: ManagedServer) {
  const image = server.dockerImage || dockerImage(server.minecraftVersion);
  await pullImage(image);
  const root = await dockerServerRoot(server);
  const binds = [`${root}:/data`];
  const exposedPorts: Record<string, unknown> = {};
  const portBindings: Record<string, Array<{ HostPort: string }>> = {};
  for (const part of (server.dockerPorts ?? "25565:25565/tcp").split(",")) {
    const [host, containerProto] = part.trim().split(":");
    if (!host || !containerProto) continue;
    const key = containerProto.includes("/") ? containerProto : `${containerProto}/tcp`;
    exposedPorts[key] = {};
    portBindings[key] = [{ HostPort: host }];
  }
  const serverJar = server.serverJar ?? "fabric-server-launch.jar";
  const quotedServerJar = shellQuote(serverJar);
  const javaArgs = server.javaArgs ?? "-Xms2G -Xmx4G";
  const command = `test -f ${quotedServerJar} || { echo "ServerSentinel could not find ${serverJar} in $(pwd)" >&2; ls -la >&2; exit 66; }; exec java ${javaArgs} -jar ${quotedServerJar} nogui`;
  await dockerJsonRequest("POST", `/containers/create?name=${encodeURIComponent(containerName(server))}`, {
    Image: image,
    WorkingDir: "/data",
    Cmd: ["sh", "-lc", command],
    OpenStdin: true,
    AttachStdin: true,
    Tty: false,
    ExposedPorts: exposedPorts,
    HostConfig: { Binds: binds, PortBindings: portBindings, RestartPolicy: { Name: "unless-stopped" } },
    Labels: { "serversentinel.managed": "true", "serversentinel.serverId": server.id }
  }, [201, 409]);
}

async function downloadFabricJar(server: ManagedServer) {
  const loader = server.loaderVersion || await latestFabricVersion("loader");
  const installer = server.installerVersion || await latestFabricVersion("installer");
  const url = `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(server.minecraftVersion ?? "")}/${encodeURIComponent(loader)}/${encodeURIComponent(installer)}/server/jar`;
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Fabric server download failed: ${res.statusText}`);
  const target = await inside(server, server.serverJar ?? "fabric-server-launch.jar", false);
  await writeFile(target, Buffer.from(await res.arrayBuffer()));
}

async function createServer(input: CreateInput) {
  const displayName = input.displayName?.trim();
  if (!displayName || !input.minecraftVersion) throw new Error("Display name and Minecraft version are required");
  if (input.acceptEula !== true) throw new Error("Minecraft EULA acceptance is required");
  const now = new Date().toISOString();
  const storageName = slugify(displayName);
  const server: ManagedServer = {
    id: randomUUID(),
    nodeId: input.nodeId || "",
    displayName,
    serverDir: resolve(serversRoot, storageName),
    storageName,
    minecraftVersion: input.minecraftVersion.trim(),
    loaderVersion: input.loaderVersion?.trim() || await latestFabricVersion("loader"),
    installerVersion: input.installerVersion?.trim() || await latestFabricVersion("installer"),
    serverJar: input.serverJar?.trim() || "fabric-server-launch.jar",
    dockerContainer: input.dockerContainer?.trim() || defaultContainerName(displayName),
    dockerImage: input.dockerImage?.trim() || dockerImage(input.minecraftVersion),
    dockerPorts: input.dockerPorts?.trim() || `${input.serverPort?.trim() || "25565"}:${input.serverPort?.trim() || "25565"}/tcp`,
    javaArgs: input.javaArgs?.trim() || "-Xms2G -Xmx4G",
    serverType: "fabric",
    createdAt: now,
    updatedAt: now
  };
  await mkdir(await serverRoot(server), { recursive: true });
  await mkdir(await inside(server, "logs", false), { recursive: true });
  await writeFile(await inside(server, "server.properties", false), `server-port=${input.serverPort?.trim() || "25565"}\n`, { flag: "wx" }).catch((e: any) => { if (e.code !== "EEXIST") throw e; });
  await writeFile(await inside(server, "eula.txt", false), `eula=${input.acceptEula ? "true" : "false"}\n`, "utf8");
  await writeFile(await inside(server, "logs/latest.log", false), "", { flag: "a" });
  await downloadFabricJar(server);
  if (dockerAvailable()) await createContainer(server);
  return server;
}

async function inspect(server: ManagedServer) {
  return dockerRequest("GET", `/containers/${encodeURIComponent(containerName(server))}/json`);
}

async function runtimeStatus(server: ManagedServer) {
  const details = await inspect(server).catch(() => null) as any;
  const running = Boolean(details?.State?.Running);
  return {
    server,
    docker: {
      configured: Boolean(server.dockerContainer),
      available: dockerAvailable(),
      controllable: Boolean(details),
      state: details?.State?.Status ?? "unknown",
      running,
      container: containerName(server),
      message: details ? "" : "Container not found on remote node"
    },
    fileLogsAvailable: existsSync(await inside(server, "logs/latest.log", false)),
    controlAvailable: Boolean(details),
    commandInputAvailable: running,
    commandInputMessage: running ? "" : "Start the server before sending console commands."
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

      response.on("data", (chunk: Buffer) => {
        const text = stripDockerLogHeaders(chunk).toString("utf8");
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
      return { name: entry.name, path: publicPath(root, entryPath), type: entry.isDirectory() ? "directory" : "file", size: entryStat.size, modifiedAt: entryStat.mtime.toISOString(), permissions: `0${(entryStat.mode & 0o777).toString(8)}`, status: "managed" };
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
  const target = await inside(server, path, false);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
  return { ok: true, path: publicPath(root, target), size: Buffer.byteLength(content) };
}

async function modsList(server: ManagedServer) {
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
          preferredChannel: "release",
          compatibility: { status: "unknown", compatible: false, reason: "Remote mod metadata sync pending" }
        };
        try {
          const target = await inside(server, join("mods", filename));
          const hash = createHash("sha1").update(await readFile(target)).digest("hex");
          const versionResponse = await modrinthFetch(`https://api.modrinth.com/v2/version_file/${hash}?algorithm=sha1`);
          const version = await versionResponse.json() as any;
          if (!version?.project_id) return base;
          const project = await fetchProject(version.project_id);
          const primaryFile = version.files?.find((file: any) => file.hashes?.sha1 === hash || file.primary);
          return {
            ...base,
            iconUrl: project.icon_url,
            compatibility: { status: "unknown", compatible: false, reason: "Remote compatibility metadata is available after panel sync", serverSide: project.server_side, clientSide: project.client_side },
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
  const name = safeName(filename);
  if (!name.endsWith(".jar")) throw new Error("Mod uploads must be .jar files");
  if (typeof contentBase64 !== "string") throw new Error("Mod content is required");
  const content = Buffer.from(contentBase64, "base64");
  if (!content.length || content.length > uploadLimit || content[0] !== 0x50 || content[1] !== 0x4b) throw new Error("Uploaded mod must be a valid jar");
  return writeRelativeFile(server, join("mods", name), content);
}

async function modInstall(server: ManagedServer, projectId: unknown, forceIncompatible: unknown, channel: unknown) {
  if (typeof projectId !== "string" || !server.minecraftVersion || !server.loaderVersion) throw new Error("projectId, Minecraft version, and Fabric loader version are required");
  const compatibility = await resolveModrinthProjectCompatibility({ projectId, minecraftVersion: server.minecraftVersion, loader: "fabric", channel: channel === "alpha" || channel === "beta" ? channel : "release" });
  if (!compatibility.compatible && forceIncompatible !== true) throw new Error(`${compatibility.reason}. Set forceIncompatible to true to install anyway.`);
  const file = compatibility.file;
  if (!file?.url || !file.filename) throw new Error("No installable jar found");
  const response = await modrinthFetch(file.url);
  if (!response.ok) throw new Error(`Mod download failed: ${response.statusText}`);
  const content = Buffer.from(await response.arrayBuffer());
  const written = await modUpload(server, file.filename, content.toString("base64"));
  return { ...written, filename: file.filename, projectId, version: compatibility.matchedVersionNumber, compatibility };
}

async function handleCommand(command: string, payload: any) {
  const server = payload?.server as ManagedServer | undefined;
  if (command === "node.health") return { ok: true, dockerAvailable: dockerAvailable(), dataPath: config.nodeDataDir };
  if (command === "docker.info") return dockerInfo();
  if (command === "server.create") return createServer(payload?.input as CreateInput);
  if (!server) throw new Error("server payload is required");
  const name = encodeURIComponent(containerName(server));
  if (command === "server.delete") {
    const status = await inspect(server).catch(() => null) as any;
    if (status?.State?.Running) throw new Error("Stop the server before deleting it");
    await dockerRequest("DELETE", `/containers/${name}?v=1`, [204, 404]).catch(() => {});
    if (payload?.input?.deleteFiles) await rm(await serverRoot(server), { recursive: true, force: true });
    return { ok: true, deletedContainer: true, deletedFiles: Boolean(payload?.input?.deleteFiles) };
  }
  if (command === "server.inspect") return runtimeStatus(server);
  if (command === "server.start") { await dockerRequest("POST", `/containers/${name}/start`, [204, 304]); return runtimeStatus(server); }
  if (command === "server.stop") { await dockerRequest("POST", `/containers/${name}/stop?t=10`, [204, 304]); return runtimeStatus(server); }
  if (command === "server.restart") { await dockerRequest("POST", `/containers/${name}/restart?t=10`, 204); return runtimeStatus(server); }
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
  if (command === "server.logs.recent") return { text: (await dockerBufferRequest("GET", `/containers/${name}/logs?stdout=1&stderr=1&tail=300`)).toString("utf8"), source: "docker" };
  if (command === "server.console.send") {
    const commandText = typeof payload?.command === "string" ? payload.command.trim() : "";
    if (!commandText) throw new Error("Console command is required");
    const exec = await dockerJsonRequest<{ Id: string }>("POST", `/containers/${name}/exec`, { AttachStdin: false, AttachStdout: true, AttachStderr: true, Cmd: ["sh", "-lc", `printf '%s\\n' "$SS_CMD" > /proc/1/fd/0`], Env: [`SS_CMD=${commandText}`] }, 201);
    await dockerJsonRequest("POST", `/exec/${encodeURIComponent(exec.Id)}/start`, { Detach: false, Tty: false }, 200);
    return { ok: true };
  }
  if (command === "files.list") return fileList(server, payload?.path);
  if (command === "files.read") return fileRead(server, payload?.path, Boolean(payload?.preview));
  if (command === "files.download") return fileDownload(server, payload?.path);
  if (command === "files.write") return writeRelativeFile(server, payload?.path, String(payload?.content ?? ""));
  if (command === "files.upload") {
    if (typeof payload?.contentBase64 !== "string") throw new Error("File content is required");
    return writeRelativeFile(server, join(safeRelative(payload?.parent), safeName(payload?.filename)), Buffer.from(payload.contentBase64, "base64"));
  }
  if (command === "files.mkdir") {
    const root = await serverRoot(server);
    const target = await inside(server, join(safeRelative(payload?.parent), safeName(payload?.name)), false);
    await mkdir(target, { recursive: false });
    return { ok: true, path: publicPath(root, target) };
  }
  if (command === "files.rename") {
    const root = await serverRoot(server);
    const source = await inside(server, payload?.path);
    const target = await inside(server, join(dirname(safeRelative(payload?.path)), safeName(payload?.name)), false);
    await rename(source, target);
    return { ok: true, path: publicPath(root, target) };
  }
  if (command === "files.copy") {
    const root = await serverRoot(server);
    const source = await inside(server, payload?.path);
    const target = await inside(server, join(safeRelative(payload?.parent), safeName(payload?.name)), false);
    await copyFile(source, target);
    return { ok: true, path: publicPath(root, target) };
  }
  if (command === "files.delete") {
    const target = await inside(server, payload?.path);
    const st = await stat(target);
    if (st.isDirectory()) await rm(target, { recursive: payload?.recursive === "true", force: false });
    else await rm(target, { force: false });
    return { ok: true };
  }
  if (command === "mods.list") return modsList(server);
  if (command === "mods.upload") return modUpload(server, payload?.filename, payload?.contentBase64);
  if (command === "mods.install") return modInstall(server, payload?.projectId, payload?.forceIncompatible, payload?.channel);
  if (command === "mods.enableDisable") {
    const filename = safeName(payload?.filename);
    const source = await inside(server, join("mods", filename));
    const targetName = payload?.enabled === true ? filename.replace(/\.jar\.disabled$/, ".jar") : filename.endsWith(".jar.disabled") ? filename : `${filename}.disabled`;
    const target = await inside(server, join("mods", safeName(targetName)), false);
    if (source !== target) await rename(source, target);
    return { ok: true, filename: basename(target), enabled: payload?.enabled === true };
  }
  if (command === "mods.remove") {
    const filename = safeName(payload?.filename);
    await rm(await inside(server, join("mods", filename)), { force: true });
    return { ok: true, filename };
  }
  throw new Error(`Unsupported node command ${command}`);
}

export async function startNodeAgent() {
  await mkdir(config.nodeDataDir, { recursive: true });
  let persisted = await readNodeConfig();
  if (!persisted && !config.joinToken) throw new Error("SS_JOIN_TOKEN is required for first node registration");
  console.info(`ServerSentinel node agent starting. Panel: ${config.panelUrl}. Data: ${config.nodeDataDir}.`);

  const connect = async () => {
    persisted = await readNodeConfig();
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
    socket.on("open", () => {
      const hello: NodeHello = { type: "hello", nodeId: persisted?.nodeId, nodeSecret: persisted?.nodeSecret, joinToken: persisted ? undefined : config.joinToken, nodeName: config.nodeName || "Remote Node", agentVersion: process.env.npm_package_version ?? "0.2.0", protocolVersion: nodeProtocolVersion, capabilities: [...nodeCapabilities], dockerStatus: dockerAvailable() ? "available" : "unavailable", dataPathStatus: existsSync(config.nodeDataDir) ? "ready" : "missing" };
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
          await writeNodeConfig({ nodeId: message.nodeId, nodeSecret: message.nodeSecret });
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
        catch (error) { return { type: "response", id: message.id, ok: false, error: { code: "command_failed", message: (error as Error).message } }; }
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
