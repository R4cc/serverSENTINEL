import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import type { ManagedNode, ManagedServer, Permission, PublicServer, ReleaseChannel, ServerActivity, ServerEvent } from "../types.js";
import type { PanelNodeConnections } from "./panelConnections.js";
import { protocolCompatible } from "./protocol.js";
import type { FileDownloadResult, ModIconResult, NodeRuntime, RuntimeAction } from "./types.js";
import { summarizeRuntimeExit } from "../runtimeErrors.js";

type ConsoleClient = {
  send: (payload: string) => void;
  readyState: number;
};

type NodeLookup = (nodeId: string) => Promise<ManagedNode | undefined>;
type PublicServerFn = (server: ManagedServer, nodes?: ManagedNode[]) => Promise<PublicServer>;
type PersistServerFn = (server: ManagedServer) => Promise<void>;
type UpdateServerRecordFn = (server: ManagedServer) => Promise<void>;
type DeleteServerRecordFn = (serverId: string) => Promise<void>;

function normalizeRemotePath(path: string) {
  const value = (path || ".").replaceAll("\\", "/");
  if (value.includes("\0")) throw new Error("Path contains invalid characters");
  if (value.startsWith("/")) return value.replace(/^\/+/, "") || ".";
  return value || ".";
}

function publicRemotePath(path: string) {
  const normalized = normalizeRemotePath(path);
  return normalized === "." ? "/" : `/${normalized}`;
}

function parseProperties(text?: string) {
  const values: Record<string, string> = {};
  for (const rawLine of (text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator === -1) continue;
    values[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return values;
}

function parseOnlinePlayerCount(logText: string) {
  const matches = [...logText.matchAll(/There are\s+(\d+)\s+of a max(?:imum)? of\s+\d+\s+players online/gi)];
  const latest = matches.at(-1);
  return latest ? Number(latest[1]) : null;
}

function eventSignature(eventType: ServerEvent["eventType"], subject?: string) {
  const normalized = subject?.trim().toLowerCase().replace(/\s+/g, " ");
  return normalized ? `${eventType}:${normalized}` : eventType;
}

function parseRemoteLogEvent(line: string, source: ServerEvent["source"], index: number): ServerEvent | null {
  const stripped = line.replace(/\u001b\[[0-9;]*m/g, "").trim();
  if (!stripped) return null;
  const tsMatch = stripped.match(/^\[(?<time>\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?|\d{2}:\d{2}:\d{2})\]/);
  let timestamp: string | undefined;
  let rest = stripped;
  if (tsMatch) {
    const rawTime = tsMatch.groups!.time;
    if (/^\d{2}:\d{2}:\d{2}$/.test(rawTime)) timestamp = rawTime;
    else {
      const parsed = new Date(rawTime.replace(" ", "T"));
      if (!Number.isNaN(parsed.getTime())) timestamp = parsed.toISOString();
    }
    rest = stripped.slice(tsMatch[0].length).trim();
  }
  const message = rest.match(/^\[[^\]/]+\/[A-Z]+\]:\s*(?<message>.*)$/)?.groups?.message
    ?? rest.match(/^\[[^\]]+\]\s+\[[A-Z]+\]:\s*(?<message>.*)$/)?.groups?.message
    ?? rest.match(/^\[[A-Z]+\]:\s*(?<message>.*)$/)?.groups?.message
    ?? rest.match(/^[A-Z]+:\s*(?<message>.*)$/)?.groups?.message
    ?? rest;
  const playerJoin = message.match(/^(.+?) joined the game$/i);
  const playerLeft = message.match(/^(.+?) left the game$/i) ?? message.match(/^(.+?) lost connection:/i);
  const start = /Done \([^)]+\)! For help, type "help"/i.test(message) || /Starting minecraft server/i.test(message);
  const stop = /Stopping server|Stopping the server|ThreadedAnvilChunkStorage: All chunks are saved/i.test(message);
  const crash = /Encountered an unexpected exception|Minecraft Crash Report|server crashed|The game crashed/i.test(message);
  const eventType = playerJoin ? "player_joined" : playerLeft ? "player_left" : start ? "server_started" : stop ? "server_stopped" : crash ? "server_crashed" : null;
  if (!eventType) return null;
  const subject = playerJoin?.[1] ?? playerLeft?.[1];
  const text = eventType === "player_joined" ? `Player joined: ${subject?.trim()}`
    : eventType === "player_left" ? `Player left: ${subject?.trim()}`
    : eventType === "server_started" ? "Server started"
    : eventType === "server_stopped" ? "Server stopped"
    : "Server crashed";
  const severity = eventType === "server_crashed" ? "error" : eventType === "player_joined" || eventType === "server_started" ? "success" : "info";
  const signature = eventSignature(eventType, subject);
  return {
    id: `${source}-${index}-${timestamp ?? ""}-${signature}`,
    eventType,
    type: severity,
    severity,
    text,
    message: text,
    timestamp,
    signature,
    source
  };
}

function configuredServerPort(server: ManagedServer, props: Record<string, string>) {
  if (props["server-port"]) return props["server-port"];
  const firstTcp = (server.dockerPorts || "25565:25565/tcp").split(",").map((part) => part.trim()).find((part) => /\/tcp$|^\d+:\d+$|^\d+$/.test(part));
  return firstTcp?.split(":")[0]?.replace(/\/tcp$/, "") || "25565";
}

function javaRuntimeLabel(server: ManagedServer) {
  if (/temurin/i.test(server.dockerImage || "")) {
    const version = server.dockerImage?.match(/temurin:([^,\s]+)/i)?.[1];
    return version ? `Temurin ${version.replace(/-jre$/i, "")}` : "Temurin";
  }
  return server.runtimeProfile?.javaMajorVersion ? `Java ${server.runtimeProfile.javaMajorVersion}` : undefined;
}

function validDockerTimestamp(value?: string) {
  return value && !value.startsWith("0001-") ? value : undefined;
}

export class RemoteNodeRuntime implements NodeRuntime {
  readonly nodeId: string;

  constructor(
    nodeId: string,
    private readonly lookupNode: NodeLookup,
    private readonly connections: PanelNodeConnections,
    private readonly publicServerFn: PublicServerFn,
    private readonly persistServer: PersistServerFn,
    private readonly updateServerRecord: UpdateServerRecordFn,
    private readonly deleteServerRecord: DeleteServerRecordFn
  ) {
    this.nodeId = nodeId;
  }

  publicServer(server: ManagedServer, nodes?: ManagedNode[]) {
    return this.publicServerFn(server, nodes);
  }

  async command(server: ManagedServer, command: Parameters<PanelNodeConnections["request"]>[1], payload?: unknown) {
    const node = await this.lookupNode(server.nodeId);
    if (!node) throw new Error(`Node ${server.nodeId} not found`);
    return this.connections.request(node, command, { server, ...(payload as Record<string, unknown> | undefined) });
  }

  async createServer(input: unknown): Promise<ManagedServer> {
    const result = await this.command({ id: "pending", nodeId: this.nodeId } as ManagedServer, "server.create", { input }) as ManagedServer;
    await this.persistServer(result);
    return result;
  }

  async updateServer(server: ManagedServer, input: unknown): Promise<ManagedServer> {
    const result = await this.command(server, "server.update", { input }) as ManagedServer;
    await this.updateServerRecord(result);
    return result;
  }

  async deleteServer(server: ManagedServer, input: unknown) {
    const result = await this.command(server, "server.delete", { input });
    await this.deleteServerRecord(server.id);
    return result;
  }

  serverStatus(server: ManagedServer) {
    return this.command(server, "server.inspect");
  }

  async lifecycle(server: ManagedServer, action: RuntimeAction) {
    const command = action === "start" ? "server.start" : action === "stop" ? "server.stop" : "server.restart";
    const result = await this.command(server, command);
    if (action !== "start" && action !== "restart") return result;

    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const status = await this.serverStatus(server) as { docker?: { running?: boolean } };
    if (status.docker?.running) return status;

    const logs = await this.serverLogs(server).catch(() => ({ text: "" })) as { text?: string };
    throw new Error(summarizeRuntimeExit(action, logs.text ?? ""));
  }

  sendConsoleCommand(server: ManagedServer, command: unknown) {
    return this.command(server, "server.console.send", { command });
  }

  async streamConsole(server: ManagedServer, client: unknown, onClose: (cleanup: () => void) => void) {
    const consoleClient = client as ConsoleClient;
    const send = (event: unknown) => {
      if (consoleClient.readyState === 1) {
        consoleClient.send(JSON.stringify(event));
      }
    };

    const node = await this.lookupNode(server.nodeId);
    if (!node) {
      send({ type: "unavailable", message: `Node ${server.nodeId} not found` });
      return;
    }
    if (!this.connections.isConnected(node.id)) {
      send({ type: "unavailable", message: `Node ${node.name} is offline` });
      return;
    }
    if (!protocolCompatible(node.protocolVersion)) {
      send({ type: "unavailable", message: `Node ${node.name} uses unsupported protocol ${node.protocolVersion ?? "unknown"}` });
      return;
    }
    if (!node.capabilities?.includes("server.console.stream")) {
      send({ type: "unavailable", message: "Remote node does not support live console streaming. Update the node agent." });
      return;
    }

    try {
      const status = await this.serverStatus(server);
      send({ type: "status", status });
    } catch (error) {
      send({ type: "unavailable", message: (error as Error).message });
    }

    try {
      const cleanup = await this.connections.stream(
        node,
        "server.console.stream",
        { server },
        (event) => send(event),
        (error) => {
          if (error) send({ type: "unavailable", message: error.message });
        }
      );
      onClose(cleanup);
    } catch (error) {
      send({ type: "unavailable", message: (error as Error).message });
    }
  }

  serverLogs(server: ManagedServer) {
    return this.command(server, "server.logs.recent");
  }

  async onlinePlayerCount(server: ManagedServer) {
    await this.sendConsoleCommand(server, "list");
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const logs = await this.serverLogs(server) as { text?: string };
    const matches = [...(logs.text ?? "").matchAll(/There are\s+(\d+)\s+of a max(?:imum)? of\s+\d+\s+players online/gi)];
    const latest = matches.at(-1);
    return latest ? Number(latest[1]) : null;
  }

  serverStats(server: ManagedServer) {
    return this.command(server, "server.stats");
  }

  async serverOverview(server: ManagedServer) {
    const [logsResult, statusResult, propertiesResult, eulaResult] = await Promise.allSettled([
      this.serverLogs(server) as Promise<{ text?: string; source?: ServerEvent["source"] }>,
      this.serverStatus(server) as Promise<{ docker?: { running?: boolean; startedAt?: string; finishedAt?: string } }>,
      this.readFile(server, "server.properties") as Promise<{ content?: string }>,
      this.readFile(server, "eula.txt") as Promise<{ content?: string }>
    ]);
    const logs = logsResult.status === "fulfilled" ? logsResult.value : { text: "", source: "docker" as const };
    let logText = logs.text ?? "";
    const source = logs.source === "logs/latest.log" ? "logs/latest.log" : "docker";
    const parsedEvents = logText
      .split(/\r?\n/)
      .map((line, index) => parseRemoteLogEvent(line, source, index))
      .filter((event): event is ServerEvent => Boolean(event));
    const reversedEvents = [...parsedEvents].reverse();
    const status = statusResult.status === "fulfilled" ? statusResult.value : {};
    let playersOnline = parseOnlinePlayerCount(logText);
    if (playersOnline === null && status.docker?.running) {
      playersOnline = await this.onlinePlayerCount(server).catch(() => null);
      if (playersOnline !== null) {
        const refreshedLogs = await this.serverLogs(server).catch(() => logs) as { text?: string };
        logText = refreshedLogs.text ?? logText;
      }
    }
    const props = parseProperties(propertiesResult.status === "fulfilled" ? propertiesResult.value.content : "");
    const eulaText = eulaResult.status === "fulfilled" ? eulaResult.value.content ?? "" : "";
    const eulaAccepted = eulaText ? /^eula\s*=\s*true\s*$/im.test(eulaText) : undefined;
    const activity: ServerActivity = {
      lastStartedAt: validDockerTimestamp(status.docker?.startedAt) ?? reversedEvents.find((event) => event.eventType === "server_started")?.timestamp,
      lastStoppedAt: validDockerTimestamp(status.docker?.finishedAt) ?? reversedEvents.find((event) => event.eventType === "server_stopped")?.timestamp,
      currentWorld: props["level-name"],
      serverPort: configuredServerPort(server, props),
      eulaAccepted,
      javaRuntime: javaRuntimeLabel(server),
      playersOnline,
      maxPlayers: props["max-players"] ? Number(props["max-players"]) : null
    };
    return {
      events: parsedEvents.slice(-10).reverse(),
      eventsStatus: logsResult.status === "fulfilled" ? "ok" : "unavailable",
      activity,
      logSources: logText ? [{ source, text: logText }] : []
    };
  }

  async resolveExistingPath(_server: ManagedServer, path: string): Promise<string> {
    return normalizeRemotePath(path);
  }

  async resolveWritablePath(_server: ManagedServer, path: string): Promise<string> {
    return normalizeRemotePath(path);
  }

  async resolveWritableResolvedPath(_server: ManagedServer, path: string): Promise<string> {
    return normalizeRemotePath(path);
  }

  publicPath(_server: ManagedServer, absolutePath: string) {
    return publicRemotePath(absolutePath);
  }

  isModsPath(_server: ManagedServer, absolutePath: string) {
    const path = publicRemotePath(absolutePath);
    return path === "/mods" || path.startsWith("/mods/");
  }

  isServerSettingsFile(_server: ManagedServer, absolutePath: string) {
    return basename(absolutePath) === "server.properties";
  }

  fileRenamePermission(server: ManagedServer, source: string, target: string): Permission {
    if (this.isModsPath(server, source) || this.isModsPath(server, target)) return "mods.enableDisable";
    return "files.edit";
  }

  listFiles(server: ManagedServer, target: string) {
    return this.command(server, "files.list", { path: normalizeRemotePath(target) });
  }

  previewFile(server: ManagedServer, target: string) {
    return this.command(server, "files.read", { path: normalizeRemotePath(target), preview: true });
  }

  async downloadFile(server: ManagedServer, target: string): Promise<FileDownloadResult> {
    const result = await this.command(server, "files.download", { path: normalizeRemotePath(target) }) as { filename: string; size: number; contentBase64: string };
    return { filename: result.filename, size: result.size, stream: Readable.from(Buffer.from(result.contentBase64, "base64")) };
  }

  readFile(server: ManagedServer, target: string) {
    return this.command(server, "files.read", { path: normalizeRemotePath(target) });
  }

  writeFile(server: ManagedServer, target: string, content: unknown) {
    return this.command(server, "files.write", { path: normalizeRemotePath(target), content });
  }

  createFolder(server: ManagedServer, parent: string, name: unknown) {
    return this.command(server, "files.mkdir", { parent: normalizeRemotePath(parent), name });
  }

  uploadFile(server: ManagedServer, parent: string, filename: unknown, contentBase64: unknown) {
    return this.command(server, "files.upload", { parent: normalizeRemotePath(parent), filename, contentBase64 });
  }

  renameFile(server: ManagedServer, source: string, name: unknown) {
    return this.command(server, "files.rename", { path: normalizeRemotePath(source), name });
  }

  duplicateFile(server: ManagedServer, source: string, name: unknown) {
    return this.command(server, "files.copy", { path: normalizeRemotePath(source), name, parent: normalizeRemotePath(dirname(source)) });
  }

  deleteFile(server: ManagedServer, target: string, recursive: unknown) {
    return this.command(server, "files.delete", { path: normalizeRemotePath(target), recursive });
  }

  listMods(server: ManagedServer) {
    return this.command(server, "mods.list");
  }

  async modIcon(): Promise<ModIconResult | null> {
    return null;
  }

  toggleMod(server: ManagedServer, filename: unknown, enabled: unknown) {
    return this.command(server, "mods.enableDisable", { filename, enabled });
  }

  async setModChannel(_server: ManagedServer, _filename: unknown, _channel: ReleaseChannel | undefined) {
    return { ok: true };
  }

  removeMod(server: ManagedServer, filename: unknown) {
    return this.command(server, "mods.remove", { filename });
  }

  uploadMod(server: ManagedServer, filename: unknown, contentBase64: unknown) {
    return this.command(server, "mods.upload", { filename, contentBase64 });
  }

  installMod(server: ManagedServer, input: unknown) {
    return this.command(server, "mods.install", input);
  }
}
