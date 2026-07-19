import { basename, dirname } from "node:path";
import { Readable } from "node:stream";
import { serverRuntimeDefinition } from "@serversentinel/contracts";
import { createZipArchiveStream, type FileArchiveEntry } from "../downloadArchive.js";
import type { ManagedNode, ManagedServer, Permission, PublicServer, ServerActivity, ServerEvent } from "../types.js";
import type { PlayerObservation } from "../playerSnapshots.js";
import type { PanelNodeConnections } from "./panelConnections.js";
import { assertNodeSupports, nodeAdvertisesCapability, nodeAdvertisesFeature, type ServerObservationSection } from "./protocol.js";
import type { RemoteObservationCoordinator } from "./observationCoordinator.js";
import type { FileDownloadResult, ModIconResult, NodeRuntime, RuntimeAction, RuntimeProgressReporter, RuntimeUploadSource } from "./types.js";
import type { ZipArchiveListing, ZipExtractionPlan, ZipExtractionResult } from "../zipArchive.js";
import { summarizeRuntimeExit } from "../runtimeErrors.js";
import { parseServerProperties } from "../runtime/serverProperties.js";
import { runtimeTarget } from "../runtime/profile.js";
import { config } from "../config.js";

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
const modsListCommandTimeoutMs = 30_000;
const modrinthCommandTimeoutMs = 5 * 60 * 1000;
const archiveCommandTimeoutMs = 30 * 60 * 1000;
const legacyTransferDecodedLimitBytes = 72 * 1024 * 1024;

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

function cleanModName(value: string) {
  return value.trim().replace(/^["']|["']$/g, "").replace(/\s+/g, " ");
}

function conciseEventDetails(value: string) {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length > 220 ? `${normalized.slice(0, 217)}...` : normalized;
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
  let level = "";
  let message = rest;
  const parsedLine = rest.match(/^\[[^\]/]+\/(?<level>[A-Z]+)\]:\s*(?<message>.*)$/)
    ?? rest.match(/^\[[^\]]+\]\s+\[(?<level>[A-Z]+)\]:\s*(?<message>.*)$/)
    ?? rest.match(/^\[(?<level>[A-Z]+)\]:\s*(?<message>.*)$/)
    ?? rest.match(/^(?<level>[A-Z]+):\s*(?<message>.*)$/);
  if (parsedLine?.groups) {
    level = parsedLine.groups.level;
    message = parsedLine.groups.message;
  }

  const makeEvent = (eventType: ServerEvent["eventType"], severity: ServerEvent["severity"], text: string, subject?: string, details?: string): ServerEvent => {
    const signature = eventSignature(eventType, subject);
    return {
      id: `${source}-${index}-${timestamp ?? ""}-${signature}`,
      eventType,
      type: severity,
      severity,
      text,
      message: text,
      details,
      timestamp,
      signature,
      source,
      subject
    };
  };

  const playerJoin = message.match(/^(.+?) joined the game$/i);
  if (playerJoin) {
    const player = cleanPlayerName(playerJoin[1]);
    return makeEvent("player_joined", "success", `${player} joined`, player);
  }

  const playerLeft = message.match(/^(.+?) left the game$/i)
    ?? message.match(/^(.+?) lost connection:/i)
    ?? message.match(/^Disconnecting\s+(.+?)(?:\s*\(|:|$)/i);
  if (playerLeft) {
    const player = cleanPlayerName(playerLeft[1]);
    const severity = /lost connection|^Disconnecting/i.test(message) ? "warning" : "info";
    return makeEvent("player_left", severity, `${player} left`, player);
  }

  if (/Done \([^)]+\)! For help, type "help"/i.test(message) || /Starting minecraft server/i.test(message)) {
    return makeEvent("server_started", "success", "Server started");
  }
  if (/Stopping server|Stopping the server|ThreadedAnvilChunkStorage: All chunks are saved/i.test(message)) {
    return makeEvent("server_stopped", "info", "Server stopped");
  }

  const disabledJar = message.match(/\b([\w .+@()[\]-]+?\.jar(?:\.disabled)?)\b.*\b(?:disabled|disabling)\b/i)
    ?? message.match(/\b(?:disabled|disabling)\b.*\b([\w .+@()[\]-]+?\.jar(?:\.disabled)?)\b/i);
  const disabledMod = disabledJar
    ?? message.match(/\bmod\s+["']?([^"',:]+?)["']?\s+(?:was\s+)?disabled\b/i)
    ?? message.match(/\b(?:disabled|disabling)\s+mod\s+["']?([^"',:]+?)["']?\b/i);
  if (disabledMod) {
    const modName = cleanModName(disabledMod[1]);
    return makeEvent("mod_disabled", "warning", `Mod disabled: ${modName}`, modName);
  }

  const overloaded = message.match(/Can't keep up! Is the server overloaded\?\s*(.*)/i);
  if (overloaded) {
    return makeEvent("server_overloaded", "warning", "Server is falling behind", undefined, conciseEventDetails(overloaded[1] || message));
  }

  if (
    /Encountered an unexpected exception|This crash report has been saved to:|Minecraft Crash Report|A crash report has been generated|The game crashed|server crashed|Failed to start the minecraft server|OutOfMemoryError/i.test(message)
    || (level === "FATAL" && /\b(exception|crash|crashed)\b/i.test(message))
  ) {
    return makeEvent("server_crashed", "error", "Server crashed", undefined, conciseEventDetails(message));
  }

  const exception = message.match(/\b((?:[A-Za-z_$][\w$]*\.)*([A-Za-z_$][\w$]*(?:Exception|Error)))\b(?::\s*(.*))?/i);
  const exceptionContext = /\b(?:caught|caused by|uncaught|unhandled)\b/i.test(message) || ["WARN", "ERROR", "FATAL"].includes(level);
  if (exception && exceptionContext) {
    const exceptionName = exception[2];
    return makeEvent("exception_caught", level === "WARN" ? "warning" : "error", `Exception caught: ${exceptionName}`, exceptionName, conciseEventDetails(message));
  }

  return null;
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
    private readonly deleteServerRecord: DeleteServerRecordFn,
    private readonly observations?: RemoteObservationCoordinator
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

  private async supportsObservations(server: ManagedServer) {
    const node = await this.lookupNode(server.nodeId);
    return Boolean(node && this.connections.isConnected(node.id) && nodeAdvertisesCapability(node, "server.observe"));
  }

  private invalidateObservations(server: ManagedServer, sections?: ServerObservationSection[]) {
    this.observations?.invalidate(server.id, sections);
  }

  private async binaryTransferNode(server: ManagedServer) {
    const node = await this.lookupNode(server.nodeId);
    return node && nodeAdvertisesFeature(node, "binary-transfer") && this.connections.isConnected(node.id) ? node : undefined;
  }

  private legacyUploadBuffer(contentBase64: unknown) {
    if (typeof contentBase64 !== "string" || contentBase64.length % 4 !== 0 || !/^[a-zA-Z0-9+/]*={0,2}$/.test(contentBase64)) throw new Error("Uploaded content must be valid base64");
    const estimatedBytes = Math.floor(contentBase64.length * 3 / 4);
    if (estimatedBytes > legacyTransferDecodedLimitBytes) {
      throw new Error("This upload is too large for a protocol 3.0 node. Update the node to protocol 3.1 to use streamed transfers.");
    }
    return Buffer.from(contentBase64, "base64");
  }

  private isUploadSource(value: unknown): value is RuntimeUploadSource {
    return Boolean(value && typeof value === "object" && "stream" in value && (value as RuntimeUploadSource).stream);
  }

  private async bufferUploadSource(source: RuntimeUploadSource, limit: number) {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const raw of source.stream) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      size += chunk.byteLength;
      if (size > limit) throw new Error("This upload is too large for a protocol 3.0 node. Update the node to protocol 3.1 to use streamed transfers.");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
  }

  private async mutation<T>(server: ManagedServer, sections: ServerObservationSection[], operation: Promise<T>) {
    try {
      return await operation;
    } finally {
      this.invalidateObservations(server, sections);
    }
  }

  async createServer(input: unknown): Promise<ManagedServer> {
    const result = await this.command({ id: "pending", nodeId: this.nodeId } as ManagedServer, "server.create", { input }, provisioningCommandTimeoutMs) as ManagedServer;
    await this.persistServer(result);
    return result;
  }

  async updateServer(server: ManagedServer, input: unknown): Promise<ManagedServer> {
    const result = await this.command(server, "server.update", { input }, provisioningCommandTimeoutMs) as ManagedServer;
    this.invalidateObservations(server);
    await this.updateServerRecord(result);
    return result;
  }

  async deleteServer(server: ManagedServer, input: unknown) {
    const result = await this.command(server, "server.delete", { input });
    await this.deleteServerRecord(server.id);
    return result;
  }

  async serverStatus(server: ManagedServer) {
    if (this.observations && await this.supportsObservations(server)) {
      return this.observations.read(server, "status", 6_000);
    }
    return this.command(server, "server.inspect");
  }

  async lifecycle(server: ManagedServer, action: RuntimeAction) {
    const command = action === "start" ? "server.start" : action === "stop" ? "server.stop" : "server.restart";
    this.invalidateObservations(server, ["status", "stats", "players", "logs"]);
    const result = await this.command(server, command);
    this.invalidateObservations(server, ["status", "stats", "players", "logs"]);
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

  async serverLogs(server: ManagedServer, lineLimit?: number) {
    if (this.observations && lineLimit === undefined && await this.supportsObservations(server)) {
      return this.observations.read(server, "logs", 11_000);
    }
    return this.command(server, "server.logs.recent", lineLimit === undefined ? undefined : { limit: lineLimit });
  }

  async readPlayerObservation(server: ManagedServer) {
    if (this.observations && await this.supportsObservations(server)) {
      return this.observations.read(server, "players", 11_000) as Promise<PlayerObservation>;
    }
    return this.command(server, "server.players.read") as Promise<PlayerObservation>;
  }

  async serverStats(server: ManagedServer) {
    if (this.observations && await this.supportsObservations(server)) {
      return this.observations.read(server, "stats", 6_000);
    }
    return this.command(server, "server.stats");
  }

  async serverOverview(server: ManagedServer) {
    if (this.observations && await this.supportsObservations(server)) {
      const observed = await this.observations.readMany(server, ["logs", "status", "overviewFiles"], 11_000);
      const logs = (observed.logs ?? { text: "", source: "docker" }) as { text?: string; source?: ServerEvent["source"] };
      const status = (observed.status ?? {}) as { docker?: { running?: boolean; startedAt?: string; finishedAt?: string } };
      const files = (observed.overviewFiles ?? {}) as { properties?: string; eula?: string };
      return this.buildOverview(server, logs, status, files.properties ?? "", files.eula ?? "", observed.logs !== undefined);
    }
    const [logsResult, statusResult, propertiesResult, eulaResult] = await Promise.allSettled([
      this.serverLogs(server) as Promise<{ text?: string; source?: ServerEvent["source"] }>,
      this.serverStatus(server) as Promise<{ docker?: { running?: boolean; startedAt?: string; finishedAt?: string } }>,
      this.readFile(server, "server.properties") as Promise<{ content?: string }>,
      this.readFile(server, "eula.txt") as Promise<{ content?: string }>
    ]);
    const logs = logsResult.status === "fulfilled" ? logsResult.value : { text: "", source: "docker" as const };
    const status = statusResult.status === "fulfilled" ? statusResult.value : {};
    return this.buildOverview(
      server,
      logs,
      status,
      propertiesResult.status === "fulfilled" ? propertiesResult.value.content ?? "" : "",
      eulaResult.status === "fulfilled" ? eulaResult.value.content ?? "" : "",
      logsResult.status === "fulfilled"
    );
  }

  private buildOverview(
    server: ManagedServer,
    logs: { text?: string; source?: ServerEvent["source"] },
    status: { docker?: { running?: boolean; startedAt?: string; finishedAt?: string } },
    propertiesText: string,
    eulaText: string,
    eventsAvailable: boolean
  ) {
    let logText = logs.text ?? "";
    const source = logs.source === "logs/latest.log" ? "logs/latest.log" : "docker";
    const parsedEvents = logText
      .split(/\r?\n/)
      .map((line, index) => parseRemoteLogEvent(line, source, index))
      .filter((event): event is ServerEvent => Boolean(event));
    const reversedEvents = [...parsedEvents].reverse();
    const props = parseServerProperties(propertiesText);
    const eulaAccepted = eulaText ? /^eula\s*=\s*true\s*$/im.test(eulaText) : undefined;
    const activity: ServerActivity = {
      lastStartedAt: validDockerTimestamp(status.docker?.startedAt) ?? reversedEvents.find((event) => event.eventType === "server_started")?.timestamp,
      lastStoppedAt: validDockerTimestamp(status.docker?.finishedAt) ?? reversedEvents.find((event) => event.eventType === "server_stopped")?.timestamp,
      currentWorld: props["level-name"],
      serverPort: configuredServerPort(server, props),
      eulaAccepted,
      javaRuntime: javaRuntimeLabel(server)
    };
    return {
      events: compactRecentEvents(parsedEvents, 20),
      eventsStatus: eventsAvailable ? "ok" : "unavailable",
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

  isModsPath(server: ManagedServer, absolutePath: string) {
    const path = publicRemotePath(absolutePath);
    const directory = serverRuntimeDefinition(runtimeTarget(server).runtimeType).contentDirectory;
    return path === `/${directory}` || path.startsWith(`/${directory}/`);
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
    const binaryNode = await this.binaryTransferNode(server);
    if (binaryNode) return this.connections.download(binaryNode, "files.download", { server, path: normalizeRemotePath(target) }, config.fileDownloadMaxBytes, transferCommandTimeoutMs);
    const result = await this.command(server, "files.download", { path: normalizeRemotePath(target) }, transferCommandTimeoutMs) as { filename: string; size: number; contentBase64: string };
    if (result.size > legacyTransferDecodedLimitBytes) throw new Error("This download is too large for a protocol 3.0 node. Update the node to protocol 3.1 to use streamed transfers.");
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
    const binaryNode = await this.binaryTransferNode(server);
    if (binaryNode) return this.connections.download(binaryNode, "files.archive.download", { server, path: normalizeRemotePath(archivePath), entryPath }, config.fileDownloadMaxBytes, transferCommandTimeoutMs);
    const result = await this.command(server, "files.archive.download", { path: normalizeRemotePath(archivePath), entryPath }, transferCommandTimeoutMs) as { filename: string; size: number; contentBase64: string };
    if (result.size > legacyTransferDecodedLimitBytes) throw new Error("This archive entry is too large for a protocol 3.0 node. Update the node to protocol 3.1 to use streamed transfers.");
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
    return this.mutation(server, ["overviewFiles", "logs"], this.command(server, "files.write", { path: normalizeRemotePath(target), content }));
  }

  createFolder(server: ManagedServer, parent: string, name: unknown) {
    return this.mutation(server, ["overviewFiles"], this.command(server, "files.mkdir", { parent: normalizeRemotePath(parent), name }));
  }

  async uploadFile(server: ManagedServer, parent: string, filename: unknown, contentBase64: unknown | RuntimeUploadSource) {
    const binaryNode = await this.binaryTransferNode(server);
    if (binaryNode) {
      const decoded = this.isUploadSource(contentBase64) ? undefined : this.legacyUploadBuffer(contentBase64);
      const content = this.isUploadSource(contentBase64) ? contentBase64 : { stream: Readable.from(decoded!), size: decoded!.byteLength };
      if (content.size === undefined) throw new Error("Streamed uploads require a declared size");
      const result = await this.connections.upload(binaryNode, "files.upload", { server, parent: normalizeRemotePath(parent), filename }, content.stream, content.size, transferCommandTimeoutMs);
      this.invalidateObservations(server, ["overviewFiles", "logs"]);
      return result;
    }
    const legacyBase64 = this.isUploadSource(contentBase64)
      ? (await this.bufferUploadSource(contentBase64, legacyTransferDecodedLimitBytes)).toString("base64")
      : (this.legacyUploadBuffer(contentBase64), contentBase64);
    const result = await this.command(server, "files.upload", { parent: normalizeRemotePath(parent), filename, contentBase64: legacyBase64 }, transferCommandTimeoutMs);
    this.invalidateObservations(server, ["overviewFiles", "logs"]);
    return result;
  }

  renameFile(server: ManagedServer, source: string, name: unknown) {
    return this.mutation(server, ["overviewFiles", "logs"], this.command(server, "files.rename", { path: normalizeRemotePath(source), name }));
  }

  moveFile(server: ManagedServer, source: string, destinationParent: string) {
    return this.mutation(server, ["overviewFiles", "logs"], this.command(server, "files.move", { path: normalizeRemotePath(source), destinationPath: normalizeRemotePath(destinationParent) }));
  }

  duplicateFile(server: ManagedServer, source: string, name: unknown) {
    return this.mutation(server, ["overviewFiles", "logs"], this.command(server, "files.copy", { path: normalizeRemotePath(source), name, parent: normalizeRemotePath(dirname(source)) }));
  }

  deleteFile(server: ManagedServer, target: string, recursive: unknown) {
    return this.mutation(server, ["overviewFiles", "logs"], this.command(server, "files.delete", { path: normalizeRemotePath(target), recursive }));
  }

  listMods(server: ManagedServer, options?: { forceRefresh?: boolean }) {
    const prefix = runtimeTarget(server).runtimeType === "fabric" ? "mods" : "content";
    return this.command(server, `${prefix}.list`, options?.forceRefresh ? { forceRefresh: true } : undefined, modsListCommandTimeoutMs);
  }

  async modIcon(): Promise<ModIconResult | null> {
    return null;
  }

  toggleMod(server: ManagedServer, filename: unknown, enabled: unknown) {
    const prefix = runtimeTarget(server).runtimeType === "fabric" ? "mods" : "content";
    return this.mutation(server, ["logs"], this.command(server, `${prefix}.enableDisable`, { filename, enabled }));
  }

  removeMod(server: ManagedServer, filename: unknown) {
    const prefix = runtimeTarget(server).runtimeType === "fabric" ? "mods" : "content";
    return this.mutation(server, ["logs"], this.command(server, `${prefix}.remove`, { filename }));
  }

  async uploadMod(server: ManagedServer, filename: unknown, contentBase64: unknown | RuntimeUploadSource) {
    const prefix = runtimeTarget(server).runtimeType === "fabric" ? "mods" : "content";
    const binaryNode = await this.binaryTransferNode(server);
    if (binaryNode) {
      const decoded = this.isUploadSource(contentBase64) ? undefined : this.legacyUploadBuffer(contentBase64);
      const content = this.isUploadSource(contentBase64) ? contentBase64 : { stream: Readable.from(decoded!), size: decoded!.byteLength };
      if (content.size === undefined) throw new Error("Streamed uploads require a declared size");
      return this.mutation(server, ["logs"], this.connections.upload(binaryNode, `${prefix}.upload`, { server, filename }, content.stream, content.size, transferCommandTimeoutMs));
    }
    const legacyBase64 = this.isUploadSource(contentBase64)
      ? (await this.bufferUploadSource(contentBase64, legacyTransferDecodedLimitBytes)).toString("base64")
      : (this.legacyUploadBuffer(contentBase64), contentBase64);
    return this.mutation(server, ["logs"], this.command(server, `${prefix}.upload`, { filename, contentBase64: legacyBase64 }, transferCommandTimeoutMs));
  }

  installMod(server: ManagedServer, input: unknown) {
    const prefix = runtimeTarget(server).runtimeType === "fabric" ? "mods" : "content";
    return this.mutation(server, ["logs"], this.command(server, `${prefix}.install`, input, modrinthCommandTimeoutMs));
  }
}
