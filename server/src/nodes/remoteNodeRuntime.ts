import { basename, dirname } from "node:path";
import { Readable } from "node:stream";
import { createZipArchiveStream, type FileArchiveEntry } from "../downloadArchive.js";
import type { ManagedNode, ManagedServer, Permission, PublicServer, ServerActivity, ServerEvent } from "../types.js";
import type { PanelNodeConnections } from "./panelConnections.js";
import { assertNodeSupports } from "./protocol.js";
import type { FileDownloadResult, ModIconResult, NodeRuntime, RuntimeAction, RuntimeProgressReporter } from "./types.js";
import type { ZipArchiveListing, ZipExtractionPlan, ZipExtractionResult } from "../zipArchive.js";
import { summarizeRuntimeExit } from "../runtimeErrors.js";
import { normalizePlayerNames } from "../minecraftQuery.js";
import { parseServerProperties } from "../runtime/serverProperties.js";

type ConsoleClient = {
  send: (payload: string) => void;
  readyState: number;
};

type NodeLookup = (nodeId: string) => Promise<ManagedNode | undefined>;
type PublicServerFn = (server: ManagedServer, nodes?: ManagedNode[]) => Promise<PublicServer>;
type PersistServerFn = (server: ManagedServer) => Promise<void>;
type UpdateServerRecordFn = (server: ManagedServer) => Promise<void>;
type DeleteServerRecordFn = (serverId: string) => Promise<void>;

const defaultRemoteCommandTimeoutMs = 15_000;
const provisioningCommandTimeoutMs = 10 * 60 * 1000;
const transferCommandTimeoutMs = 2 * 60 * 1000;
const modrinthCommandTimeoutMs = 5 * 60 * 1000;
const archiveCommandTimeoutMs = 30 * 60 * 1000;

function normalizeRemotePath(path: string) {
  const value = path || ".";
  if (value.includes("\0") || value.includes("\\") || /[\r\n]/.test(value)) throw new Error("Path contains invalid characters");
  const trimmed = value.startsWith("/") ? value.replace(/^\/+/, "") : value;
  if (!trimmed || trimmed === ".") return ".";
  const segments = trimmed.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Path must be normalized");
  }
  return segments.join("/");
}

function publicRemotePath(path: string) {
  const normalized = normalizeRemotePath(path);
  return normalized === "." ? "/" : `/${normalized}`;
}

function eventSignature(eventType: ServerEvent["eventType"], subject?: string) {
  const normalized = subject?.trim().toLowerCase().replace(/\s+/g, " ");
  return normalized ? `${eventType}:${normalized}` : eventType;
}

function cleanPlayerName(value: string) {
  return value
    .trim()
    .replace(/^"|"$/g, "")
    .replace(/\s+\(\/?[^)]+:\d+\)$/g, "");
}

function eventTimestampSecond(timestamp?: string) {
  if (!timestamp) return "";
  if (/^\d{2}:\d{2}:\d{2}$/.test(timestamp)) return timestamp;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return date.toISOString().slice(0, 19);
}

function compactRecentEvents(events: ServerEvent[], limit: number) {
  const seen = new Set<string>();
  const compacted: ServerEvent[] = [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const key = `${event.eventType}:${event.signature}:${eventTimestampSecond(event.timestamp)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    compacted.push(event);
    if (compacted.length >= limit) break;
  }
  return compacted;
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
  const subject = playerJoin || playerLeft ? cleanPlayerName((playerJoin?.[1] ?? playerLeft?.[1])!) : undefined;
  const text = eventType === "player_joined" ? `${subject?.trim()} joined`
    : eventType === "player_left" ? `${subject?.trim()} left`
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

  async command(
    server: ManagedServer,
    command: Parameters<PanelNodeConnections["request"]>[1],
    payload?: unknown,
    timeoutMs = defaultRemoteCommandTimeoutMs
  ) {
    const node = await this.lookupNode(server.nodeId);
    if (!node) throw new Error(`Node ${server.nodeId} not found`);
    return this.connections.request(node, command, { server, ...(payload as Record<string, unknown> | undefined) }, timeoutMs);
  }

  async createServer(input: unknown): Promise<ManagedServer> {
    const result = await this.command({ id: "pending", nodeId: this.nodeId } as ManagedServer, "server.create", { input }, provisioningCommandTimeoutMs) as ManagedServer;
    await this.persistServer(result);
    return result;
  }

  async updateServer(server: ManagedServer, input: unknown): Promise<ManagedServer> {
    const result = await this.command(server, "server.update", { input }, provisioningCommandTimeoutMs) as ManagedServer;
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
      send({ type: "unavailable", message: `Node ${server.nodeId} not found`, code: "NODE_NOT_FOUND", retryable: false });
      return;
    }
    if (!this.connections.isConnected(node.id)) {
      send({ type: "unavailable", message: `Node ${node.name} is offline`, code: "NODE_OFFLINE", retryable: true });
      return;
    }
    try {
      assertNodeSupports(node, "server.console.stream");
    } catch (error) {
      const protocolError = error as Error & { code?: string };
      send({ type: "unavailable", message: protocolError.message, code: protocolError.code?.toUpperCase(), retryable: false });
      return;
    }

    try {
      const status = await this.serverStatus(server) as { docker?: unknown };
      send({ type: "status", status: { docker: status.docker } });
    } catch (error) {
      const statusError = error as Error & { code?: string };
      send({
        type: "unavailable",
        message: statusError.message,
        code: statusError.code?.toUpperCase(),
        retryable: statusError.code === "node_offline" || statusError.code === "command_timeout"
      });
    }

    try {
      const cleanup = await this.connections.stream(
        node,
        "server.console.stream",
        { server },
        (event) => send(event),
        (error) => {
          if (error) {
            const streamError = error as Error & { code?: string };
            send({
              type: "unavailable",
              message: streamError.message,
              code: streamError.code?.toUpperCase(),
              retryable: streamError.code === "node_offline" || streamError.code === "command_timeout"
            });
          }
        }
      );
      onClose(cleanup);
    } catch (error) {
      const streamError = error as Error & { code?: string };
      send({
        type: "unavailable",
        message: streamError.message,
        code: streamError.code?.toUpperCase(),
        retryable: streamError.code === "node_offline" || streamError.code === "command_timeout"
      });
    }
  }

  serverLogs(server: ManagedServer) {
    return this.command(server, "server.logs.recent");
  }

  async onlinePlayerCount(server: ManagedServer) {
    const metrics = await this.command(server, "server.queryMetrics") as { playersOnline?: number | null };
    return metrics.playersOnline ?? null;
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
    const props = parseServerProperties(propertiesResult.status === "fulfilled" ? propertiesResult.value.content : "");
    const queryMetrics = status.docker?.running
      ? await this.command(server, "server.queryMetrics").catch(() => ({ playersOnline: null, maxPlayers: null, playerNames: undefined })) as { playersOnline?: number | null; maxPlayers?: number | null; playerNames?: string[] }
      : { playersOnline: null, maxPlayers: null, playerNames: undefined };
    const eulaText = eulaResult.status === "fulfilled" ? eulaResult.value.content ?? "" : "";
    const eulaAccepted = eulaText ? /^eula\s*=\s*true\s*$/im.test(eulaText) : undefined;
    const activity: ServerActivity = {
      lastStartedAt: validDockerTimestamp(status.docker?.startedAt) ?? reversedEvents.find((event) => event.eventType === "server_started")?.timestamp,
      lastStoppedAt: validDockerTimestamp(status.docker?.finishedAt) ?? reversedEvents.find((event) => event.eventType === "server_stopped")?.timestamp,
      currentWorld: props["level-name"],
      serverPort: configuredServerPort(server, props),
      eulaAccepted,
      javaRuntime: javaRuntimeLabel(server),
      playersOnline: queryMetrics.playersOnline ?? null,
      maxPlayers: queryMetrics.maxPlayers ?? (props["max-players"] ? Number(props["max-players"]) : null),
      playerNames: normalizePlayerNames(queryMetrics.playerNames)
    };
    return {
      events: compactRecentEvents(parsedEvents, 10),
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
    const result = await this.command(server, "files.download", { path: normalizeRemotePath(target) }, transferCommandTimeoutMs) as { filename: string; size: number; contentBase64: string };
    return { filename: result.filename, size: result.size, stream: Readable.from(Buffer.from(result.contentBase64, "base64")) };
  }

  async downloadArchive(server: ManagedServer, entries: FileArchiveEntry[], filename: string): Promise<FileDownloadResult> {
    const size = entries.reduce((total, entry) => total + (entry.type === "file" ? entry.size : 0), 0);
    return {
      filename,
      size,
      stream: createZipArchiveStream(entries, async (entry) => {
        const download = await this.downloadFile(server, entry.sourcePath);
        return download.stream;
      })
    };
  }

  listArchive(server: ManagedServer, archivePath: string, entryPath: string) {
    return this.command(server, "files.archive.list", { path: normalizeRemotePath(archivePath), entryPath }) as Promise<ZipArchiveListing>;
  }

  previewArchiveEntry(server: ManagedServer, archivePath: string, entryPath: string) {
    return this.command(server, "files.archive.read", { path: normalizeRemotePath(archivePath), entryPath, preview: true });
  }

  async downloadArchiveEntry(server: ManagedServer, archivePath: string, entryPath: string): Promise<FileDownloadResult> {
    const result = await this.command(server, "files.archive.download", { path: normalizeRemotePath(archivePath), entryPath }, transferCommandTimeoutMs) as { filename: string; size: number; contentBase64: string };
    return { filename: result.filename, size: result.size, stream: Readable.from(Buffer.from(result.contentBase64, "base64")) };
  }

  planArchiveExtraction(server: ManagedServer, archivePath: string, destinationPath: string) {
    return this.command(server, "files.archive.plan", { path: normalizeRemotePath(archivePath), destinationPath: normalizeRemotePath(destinationPath) }, archiveCommandTimeoutMs) as Promise<ZipExtractionPlan>;
  }

  async extractArchive(server: ManagedServer, archivePath: string, destinationPath: string, conflictPolicy: "replace" | "skip", report?: RuntimeProgressReporter): Promise<ZipExtractionResult> {
    const node = await this.lookupNode(server.nodeId);
    if (!node) throw new Error(`Node ${server.nodeId} not found`);
    return new Promise<ZipExtractionResult>((resolvePromise, reject) => {
      let result: ZipExtractionResult | undefined;
      void this.connections.stream(
        node,
        "files.archive.extract",
        { server, path: normalizeRemotePath(archivePath), destinationPath: normalizeRemotePath(destinationPath), conflictPolicy },
        (event) => {
          if (event.type === "progress") report?.(event.progress, event.task);
          if (event.type === "result") result = event.result as ZipExtractionResult;
        },
        (error) => error ? reject(error) : result ? resolvePromise(result) : reject(new Error("Remote ZIP extraction completed without a result"))
      ).catch(reject);
    });
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
    return this.command(server, "files.upload", { parent: normalizeRemotePath(parent), filename, contentBase64 }, transferCommandTimeoutMs);
  }

  renameFile(server: ManagedServer, source: string, name: unknown) {
    return this.command(server, "files.rename", { path: normalizeRemotePath(source), name });
  }

  moveFile(server: ManagedServer, source: string, destinationParent: string) {
    return this.command(server, "files.move", { path: normalizeRemotePath(source), destinationPath: normalizeRemotePath(destinationParent) });
  }

  duplicateFile(server: ManagedServer, source: string, name: unknown) {
    return this.command(server, "files.copy", { path: normalizeRemotePath(source), name, parent: normalizeRemotePath(dirname(source)) });
  }

  deleteFile(server: ManagedServer, target: string, recursive: unknown) {
    return this.command(server, "files.delete", { path: normalizeRemotePath(target), recursive });
  }

  listMods(server: ManagedServer, options?: { forceRefresh?: boolean }) {
    return this.command(server, "mods.list", options?.forceRefresh ? { forceRefresh: true } : undefined, modrinthCommandTimeoutMs);
  }

  async modIcon(): Promise<ModIconResult | null> {
    return null;
  }

  toggleMod(server: ManagedServer, filename: unknown, enabled: unknown) {
    return this.command(server, "mods.enableDisable", { filename, enabled });
  }

  removeMod(server: ManagedServer, filename: unknown) {
    return this.command(server, "mods.remove", { filename });
  }

  uploadMod(server: ManagedServer, filename: unknown, contentBase64: unknown) {
    return this.command(server, "mods.upload", { filename, contentBase64 }, transferCommandTimeoutMs);
  }

  installMod(server: ManagedServer, input: unknown) {
    return this.command(server, "mods.install", input, modrinthCommandTimeoutMs);
  }
}
