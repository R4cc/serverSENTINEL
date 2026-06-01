import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import type { ManagedNode, ManagedServer, Permission, PublicServer, ReleaseChannel } from "../types.js";
import type { PanelNodeConnections } from "./panelConnections.js";
import type { FileDownloadResult, ModIconResult, NodeRuntime, RuntimeAction } from "./types.js";

type NodeLookup = (nodeId: string) => Promise<ManagedNode | undefined>;
type PublicServerFn = (server: ManagedServer, nodes?: ManagedNode[]) => Promise<PublicServer>;
type PersistServerFn = (server: ManagedServer) => Promise<void>;
type DeleteServerRecordFn = (serverId: string) => Promise<void>;

function unsupported(command: string): never {
  const error = new Error(`${command} is not implemented for remote nodes yet`) as Error & { statusCode?: number; code?: string };
  error.statusCode = 400;
  error.code = "missing_capability";
  throw error;
}

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

export class RemoteNodeRuntime implements NodeRuntime {
  readonly nodeId: string;

  constructor(
    nodeId: string,
    private readonly lookupNode: NodeLookup,
    private readonly connections: PanelNodeConnections,
    private readonly publicServerFn: PublicServerFn,
    private readonly persistServer: PersistServerFn,
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

  async updateServer(): Promise<ManagedServer> { unsupported("updateServer"); }

  async deleteServer(server: ManagedServer, input: unknown) {
    const result = await this.command(server, "server.delete", { input });
    await this.deleteServerRecord(server.id);
    return result;
  }

  serverStatus(server: ManagedServer) {
    return this.command(server, "server.inspect");
  }

  lifecycle(server: ManagedServer, action: RuntimeAction) {
    const command = action === "start" ? "server.start" : action === "stop" ? "server.stop" : "server.restart";
    return this.command(server, command);
  }

  sendConsoleCommand(server: ManagedServer, command: unknown) {
    return this.command(server, "server.console.send", { command });
  }

  async streamConsole() {
    unsupported("streamConsole");
  }

  serverLogs(server: ManagedServer) {
    return this.command(server, "server.logs.recent");
  }

  serverStats(server: ManagedServer) {
    return this.command(server, "server.stats");
  }

  async serverOverview(server: ManagedServer) {
    const logs = await this.serverLogs(server) as { text?: string; source?: string };
    return { events: [], activity: {}, logSources: logs.text ? [{ source: logs.source ?? "remote", text: logs.text }] : [] };
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

  installMod(server: ManagedServer, projectId: unknown, forceIncompatible: unknown, channel: ReleaseChannel | undefined) {
    return this.command(server, "mods.install", { projectId, forceIncompatible, channel });
  }
}
