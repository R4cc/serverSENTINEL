import { basename, dirname } from "node:path";
import { serverRuntimeDefinition } from "@serversentinel/contracts";
import { createZipArchiveStream, type FileArchiveEntry } from "../downloadArchive.js";
import type { ManagedNode, ManagedServer, Permission, PublicServer, ServerActivity, ServerEvent } from "../types.js";
import type { PlayerObservation } from "../playerSnapshots.js";
import type { PanelNodeConnections } from "./panelConnections.js";
import { assertNodeSupports, compactNodeServerSpec, nodeAdvertisesCapability, nodeAdvertisesFeature, nodeProtocolControlMessageMaxBytes, type ServerObservationSection } from "./protocol.js";
import type { RemoteObservationCoordinator } from "./observationCoordinator.js";
import type { ExportArchiveDownloadResult, FileDownloadResult, ModIconResult, NodeRuntime, RuntimeAction, RuntimeProgressReporter, RuntimeUploadSource } from "./types.js";
import type { ZipExtractionPlan, ZipExtractionResult } from "../zipArchive.js";
import { summarizeRuntimeExit } from "../runtimeErrors.js";
import { compactRecentEvents, parseLogEvent } from "../servers/logEvents.js";
import { parseServerProperties } from "../runtime/serverProperties.js";
import { configuredServerPort, normalizeJavaRuntime, validDockerTimestamp } from "../runtime/local/dockerContainers.js";
import { runtimeTarget } from "../runtime/profile.js";
import { config } from "../config.js";
import { validateServerId } from "../http/validation.js";
import type { ConsoleUpstream } from "../servers/consoleChannel.js";

type NodeLookup = (nodeId: string) => Promise<ManagedNode | undefined>;
type PublicServerFn = (server: ManagedServer, nodes?: ManagedNode[], servers?: ManagedServer[]) => Promise<PublicServer>;
type PersistServerFn = (server: ManagedServer) => Promise<void>;
type UpdateServerRecordFn = (server: ManagedServer) => Promise<void>;
type DeleteServerRecordFn = (serverId: string) => Promise<void>;

const defaultRemoteCommandTimeoutMs = 15_000;
const provisioningCommandTimeoutMs = 10 * 60 * 1000;
const transferCommandTimeoutMs = 2 * 60 * 1000;
const modsListCommandTimeoutMs = 30_000;
const modrinthCommandTimeoutMs = 5 * 60 * 1000;
const archiveCommandTimeoutMs = 30 * 60 * 1000;
const exportTransferTimeoutMs = 6 * 60 * 60 * 1000;
/**
 * A node does not answer `server.stop` or `server.restart` until Docker has taken the container
 * down, and Docker waits out the Minecraft stop timeout before it kills the JVM. The panel has to
 * outlast that whole window plus the node's own round trip, or it reports a timeout for a stop that
 * is still saving the world.
 */
const lifecycleCommandTimeoutMs = Math.max(defaultRemoteCommandTimeoutMs, (config.minecraftStopTimeoutSeconds + 30) * 1_000);

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

  publicServer(server: ManagedServer, nodes?: ManagedNode[], servers?: ManagedServer[]) {
    return this.publicServerFn(server, nodes, servers);
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

  /**
   * A node answers server.create and server.update with a whole server record, and the panel persists
   * it. Ownership therefore cannot come from the response: a compromised node that returns another
   * node's server id would have the panel rewrite that record -- including its nodeId -- and hand the
   * sibling's server to the attacker, because replaceMetadata only checks that the id exists.
   *
   * Identity is rebound to what the panel already knows: the node the command was sent to, and for an
   * update the server that was addressed. A mismatched id is rejected rather than rebound, because a
   * node returning a different server than the one asked about is not a case worth papering over.
   *
   * Node-local fields (serverDir, storageName, docker mount and working directories) stay as returned.
   * Those describe the node's own filesystem, which the threat model leaves under node authority.
   */
  private bindServerIdentity(result: ManagedServer, expectedId?: string): ManagedServer {
    if (!result || typeof result !== "object") {
      throw new Error(`Node ${this.nodeId} returned a malformed server record`);
    }
    const id = validateServerId(result.id);
    if (expectedId !== undefined && id !== expectedId) {
      throw new Error(`Node ${this.nodeId} returned server ${id} for a request about server ${expectedId}`);
    }
    return { ...result, id, nodeId: this.nodeId };
  }

  async createServer(input: unknown): Promise<ManagedServer> {
    const result = await this.command({ id: "pending", nodeId: this.nodeId } as ManagedServer, "server.create", { input }, provisioningCommandTimeoutMs) as ManagedServer;
    const server = this.bindServerIdentity(result);
    await this.persistServer(server);
    return server;
  }

  /**
   * A node answers `server.update` by spreading the compact spec it was sent, so its reply can only
   * describe the fields in that projection. Everything the panel keeps to itself -- when the server
   * was created, its schedules, crash history, restart-required tracking, the unresolved port
   * conflict flag -- never reached the node and cannot come back. Persisting the reply as the whole
   * record dropped all of it, and since `createdAt` is required the store rejected the write outright:
   * renaming a server on a node failed with "server.createdAt must be a non-empty string".
   *
   * So the stored record is the base and only what a node owns is taken from its reply. Running the
   * reply back through `compactNodeServerSpec` ties that set to the same projection the request was
   * built from, so a field added to one side cannot be forgotten on the other. `startOnNodeStart` is
   * outside the projection but is resolved from the update input, so the node's answer stands.
   */
  private applyNodeServerUpdate(stored: ManagedServer, result: ManagedServer): ManagedServer {
    const bound = this.bindServerIdentity(result, stored.id);
    return {
      ...stored,
      ...compactNodeServerSpec(bound),
      startOnNodeStart: bound.startOnNodeStart ?? stored.startOnNodeStart,
      updatedAt: bound.updatedAt || new Date().toISOString()
    };
  }

  async updateServer(server: ManagedServer, input: unknown): Promise<ManagedServer> {
    const result = await this.command(server, "server.update", { input }, provisioningCommandTimeoutMs) as ManagedServer;
    this.invalidateObservations(server);
    const updated = this.applyNodeServerUpdate(server, result);
    await this.updateServerRecord(updated);
    return updated;
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

  serverStorage(server: ManagedServer) {
    return this.command(server, "server.storage");
  }

  async lifecycle(server: ManagedServer, action: RuntimeAction) {
    const command = action === "start" ? "server.start" : action === "stop" ? "server.stop" : "server.restart";
    this.invalidateObservations(server, ["status", "stats", "players", "logs"]);
    const result = await this.command(server, command, undefined, action === "start" ? defaultRemoteCommandTimeoutMs : lifecycleCommandTimeoutMs);
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

  /**
   * Forwards a node's console output into the server's buffer. Sequencing stays on the panel, so
   * nothing here depends on the node agent's protocol version and an older node keeps working.
   */
  async streamConsole(server: ManagedServer, upstream: ConsoleUpstream) {
    const reportUnavailable = (error: unknown) => {
      const failure = error as Error & { code?: string };
      upstream.unavailable(failure.message, {
        code: failure.code?.toUpperCase(),
        retryable: failure.code === "node_offline" || failure.code === "command_timeout"
      });
    };

    // Nothing was attached, so the caller must not hold this as a live stream: the next viewer has
    // to ask again rather than watch a console no node is feeding.
    const nothingAttached = () => {
      upstream.ended?.();
      return () => {};
    };

    const node = await this.lookupNode(server.nodeId);
    if (!node) {
      upstream.unavailable(`Node ${server.nodeId} not found`, { code: "NODE_NOT_FOUND", retryable: false });
      return nothingAttached();
    }
    if (!this.connections.isConnected(node.id)) {
      upstream.unavailable(`Node ${node.name} is offline`, { code: "NODE_OFFLINE", retryable: true });
      return nothingAttached();
    }
    try {
      assertNodeSupports(node, "server.console.stream");
    } catch (error) {
      const protocolError = error as Error & { code?: string };
      upstream.unavailable(protocolError.message, { code: protocolError.code?.toUpperCase(), retryable: false });
      return nothingAttached();
    }

    return this.connections.stream(
      node,
      "server.console.stream",
      { server: compactNodeServerSpec(server) },
      (event) => {
        const frame = event as { type?: string; text?: string; message?: string; code?: string; retryable?: boolean };
        if (frame.type === "log") upstream.write(frame.text ?? "");
        else if (frame.type === "empty") upstream.empty(frame.message);
        else if (frame.type === "unavailable") {
          upstream.unavailable(frame.message ?? "Console stream is unavailable.", {
            code: frame.code?.toUpperCase(),
            retryable: frame.retryable
          });
        }
      },
      (error) => {
        if (error) reportUnavailable(error);
        // The node stopped sending, whether it ended the stream or dropped off the panel. This is
        // the only place that is known, so it is where the console has to be released.
        upstream.ended?.();
      }
    );
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
    const props = parseServerProperties(propertiesText);
    const eulaAccepted = eulaText ? /^eula\s*=\s*true\s*$/im.test(eulaText) : undefined;
    const activity: ServerActivity = {
      lastStartedAt: validDockerTimestamp(status.docker?.startedAt) ?? parsedEvents.findLast((event) => event.eventType === "server_started")?.timestamp,
      lastStoppedAt: validDockerTimestamp(status.docker?.finishedAt) ?? parsedEvents.findLast((event) => event.eventType === "server_stopped")?.timestamp,
      currentWorld: props["level-name"],
      serverPort: configuredServerPort(server, props),
      eulaAccepted,
      javaRuntime: normalizeJavaRuntime(server)
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
    const download = await this.connections.download(binaryNode, "files.download", { server: compactNodeServerSpec(server), path: normalizeRemotePath(target) }, config.fileDownloadMaxBytes, transferCommandTimeoutMs);
    if (download.size === undefined) throw new Error("Node omitted file download size");
    return { ...download, size: download.size };
  }

  async downloadExportArchive(server: ManagedServer, manifest: unknown, filename: string, maxBytes: number): Promise<ExportArchiveDownloadResult | undefined> {
    const node = this.connections.connectedNode(server.nodeId);
    if (!node || !nodeAdvertisesFeature(node, "binary-transfer") || !nodeAdvertisesCapability(node, "exports.download")) return undefined;
    const payload = { server: compactNodeServerSpec(server), filename, manifest };
    // Leave room for transfer metadata added by PanelNodeConnections around this payload.
    if (Buffer.byteLength(JSON.stringify(payload)) > nodeProtocolControlMessageMaxBytes - 1024) return undefined;
    return this.connections.download(node, "exports.download", payload, maxBytes, exportTransferTimeoutMs, false);
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
