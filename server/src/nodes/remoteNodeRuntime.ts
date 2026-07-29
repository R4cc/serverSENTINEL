import { basename, dirname } from "node:path";
import { serverRuntimeDefinition } from "@serversentinel/contracts";
import { createZipArchiveStream, type FileArchiveEntry } from "../downloadArchive.js";
import type { ManagedNode, ManagedServer, Permission, PublicServer, ServerActivity, ServerEvent } from "../types.js";
import type { PlayerObservation } from "../playerSnapshots.js";
import type { PanelNodeConnections } from "./panelConnections.js";
import { assertNodeSupports, compactNodeServerSpec, nodeAdvertisesCapability, nodeAdvertisesFeature, type ServerObservationSection } from "./protocol.js";
import type { RemoteObservationCoordinator } from "./observationCoordinator.js";
import type { FileDownloadResult, ModIconResult, NodeRuntime, RuntimeAction, RuntimeProgressReporter, RuntimeUploadSource } from "./types.js";
import type { ZipExtractionPlan, ZipExtractionResult } from "../zipArchive.js";
import { summarizeRuntimeExit } from "../runtimeErrors.js";
import { compactRecentEvents, parseLogEvent } from "../servers/logEvents.js";
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
    return this.connections.request(node, command, { server: compactNodeServerSpec(server), ...(payload as Record<string, unknown> | undefined) }, timeoutMs);
  }

  private async supportsObservations(server: ManagedServer) {
    const node = await this.lookupNode(server.nodeId);
    return Boolean(node && this.connections.isConnected(node.id) && nodeAdvertisesCapability(node, "server.observe"));
  }

  private invalidateObservations(server: ManagedServer, sections?: ServerObservationSection[]) {
    this.observations?.invalidate(server.id, sections);
  }

  private async binaryTransferNode(server: ManagedServer) {
    const node = this.connections.connectedNode(server.nodeId);
    if (!node) throw new Error(`Node ${server.nodeId} is not connected`);
    if (!nodeAdvertisesFeature(node, "binary-transfer")) throw new Error(`Node ${node.name} does not advertise binary-transfer`);
    return node;
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
        { server: compactNodeServerSpec(server) },
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
      .map((line, index) => parseLogEvent(line, source, index))
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
    return this.connections.download(binaryNode, "files.download", { server: compactNodeServerSpec(server), path: normalizeRemotePath(target) }, config.fileDownloadMaxBytes, transferCommandTimeoutMs);
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
        { server: compactNodeServerSpec(server), path: normalizeRemotePath(archivePath), destinationPath: normalizeRemotePath(destinationPath), conflictPolicy },
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

  async uploadFile(server: ManagedServer, parent: string, filename: unknown, content: RuntimeUploadSource) {
    const binaryNode = await this.binaryTransferNode(server);
    if (content.size === undefined) throw new Error("Streamed uploads require a declared size");
    const result = await this.connections.upload(binaryNode, "files.upload", { server: compactNodeServerSpec(server), parent: normalizeRemotePath(parent), filename }, content.stream, content.size, transferCommandTimeoutMs);
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

  async uploadMod(server: ManagedServer, filename: unknown, content: RuntimeUploadSource) {
    const prefix = runtimeTarget(server).runtimeType === "fabric" ? "mods" : "content";
    const binaryNode = await this.binaryTransferNode(server);
    if (content.size === undefined) throw new Error("Streamed uploads require a declared size");
    return this.mutation(server, ["logs"], this.connections.upload(binaryNode, `${prefix}.upload`, { server: compactNodeServerSpec(server), filename }, content.stream, content.size, transferCommandTimeoutMs));
  }

  installMod(server: ManagedServer, input: unknown) {
    const prefix = runtimeTarget(server).runtimeType === "fabric" ? "mods" : "content";
    return this.mutation(server, ["logs"], this.command(server, `${prefix}.install`, input, modrinthCommandTimeoutMs));
  }
}
