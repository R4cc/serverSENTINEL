import type { ManagedNode, ManagedServer, PublicServer, ReleaseChannel } from "../types.js";
import type { PanelNodeConnections } from "./panelConnections.js";
import type { FileDownloadResult, ModIconResult, NodeRuntime, RuntimeAction } from "./types.js";

type NodeLookup = (nodeId: string) => Promise<ManagedNode | undefined>;
type PublicServerFn = (server: ManagedServer, nodes?: ManagedNode[]) => Promise<PublicServer>;

function unsupported(command: string): never {
  const error = new Error(`${command} is not implemented for remote nodes yet`) as Error & { statusCode?: number; code?: string };
  error.statusCode = 400;
  error.code = "missing_capability";
  throw error;
}

export class RemoteNodeRuntime implements NodeRuntime {
  readonly nodeId: string;

  constructor(
    nodeId: string,
    private readonly lookupNode: NodeLookup,
    private readonly connections: PanelNodeConnections,
    private readonly publicServerFn: PublicServerFn
  ) {
    this.nodeId = nodeId;
  }

  publicServer(server: ManagedServer, nodes?: ManagedNode[]) {
    return this.publicServerFn(server, nodes);
  }

  async command(server: ManagedServer, command: Parameters<PanelNodeConnections["request"]>[1], payload?: unknown) {
    const node = await this.lookupNode(server.nodeId);
    if (!node) throw new Error(`Node ${server.nodeId} not found`);
    return this.connections.request(node, command, { server, ...payload as Record<string, unknown> });
  }

  createServer(): Promise<ManagedServer> { unsupported("createServer"); }
  updateServer(): Promise<ManagedServer> { unsupported("updateServer"); }
  async deleteServer() { unsupported("deleteServer"); }

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

  async serverOverview() { unsupported("serverOverview"); }
  async resolveExistingPath(): Promise<string> { unsupported("resolveExistingPath"); }
  async resolveWritablePath(): Promise<string> { unsupported("resolveWritablePath"); }
  async resolveWritableResolvedPath(): Promise<string> { unsupported("resolveWritableResolvedPath"); }
  publicPath(_server: ManagedServer, absolutePath: string) { return absolutePath; }
  isModsPath() { return false; }
  isServerSettingsFile() { return false; }
  fileRenamePermission(): never { unsupported("fileRenamePermission"); }
  async listFiles() { unsupported("listFiles"); }
  async previewFile() { unsupported("previewFile"); }
  async downloadFile(): Promise<FileDownloadResult> { unsupported("downloadFile"); }
  async readFile() { unsupported("readFile"); }
  async writeFile() { unsupported("writeFile"); }
  async createFolder() { unsupported("createFolder"); }
  async uploadFile() { unsupported("uploadFile"); }
  async renameFile() { unsupported("renameFile"); }
  async duplicateFile() { unsupported("duplicateFile"); }
  async deleteFile() { unsupported("deleteFile"); }
  async listMods() { unsupported("listMods"); }
  async modIcon(): Promise<ModIconResult | null> { unsupported("modIcon"); }
  async toggleMod() { unsupported("toggleMod"); }
  async setModChannel(_server: ManagedServer, _filename: unknown, _channel: ReleaseChannel | undefined) { unsupported("setModChannel"); }
  async removeMod() { unsupported("removeMod"); }
  async uploadMod() { unsupported("uploadMod"); }
  async installMod() { unsupported("installMod"); }
}
