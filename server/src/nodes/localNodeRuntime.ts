import type { ManagedNode, ManagedServer, Permission, PublicServer } from "../types.js";
import type { FileDownloadResult, ModIconResult, NodeRuntime, RuntimeAction, RuntimeProgressReporter } from "./types.js";

export type LocalNodeRuntimeHandlers = {
  publicServer(server: ManagedServer, nodes?: ManagedNode[]): Promise<PublicServer>;
  createServer(input: unknown, report?: RuntimeProgressReporter, jobId?: string): Promise<ManagedServer>;
  updateServer(serverId: string, input: unknown): Promise<ManagedServer>;
  deleteServer(server: ManagedServer, input: unknown): Promise<unknown>;
  serverStatus(server: ManagedServer): Promise<unknown>;
  lifecycle(server: ManagedServer, action: RuntimeAction): Promise<unknown>;
  sendConsoleCommand(server: ManagedServer, command: unknown): Promise<unknown>;
  streamConsole(server: ManagedServer, client: unknown, onClose: (cleanup: () => void) => void): Promise<void>;
  serverLogs(server: ManagedServer): Promise<unknown>;
  onlinePlayerCount(server: ManagedServer): Promise<number | null>;
  serverStats(server: ManagedServer): Promise<unknown>;
  serverOverview(server: ManagedServer): Promise<unknown>;
  resolveExistingPath(server: ManagedServer, path: string): Promise<string>;
  resolveWritablePath(server: ManagedServer, path: string): Promise<string>;
  resolveWritableResolvedPath(server: ManagedServer, path: string): Promise<string>;
  publicPath(server: ManagedServer, absolutePath: string): string;
  isModsPath(server: ManagedServer, absolutePath: string): boolean;
  isServerSettingsFile(server: ManagedServer, absolutePath: string): boolean;
  fileRenamePermission(server: ManagedServer, source: string, target: string): Permission;
  listFiles(server: ManagedServer, target: string): Promise<unknown>;
  previewFile(server: ManagedServer, target: string): Promise<unknown>;
  downloadFile(server: ManagedServer, target: string): Promise<FileDownloadResult>;
  readFile(server: ManagedServer, target: string): Promise<unknown>;
  writeFile(server: ManagedServer, target: string, content: unknown): Promise<unknown>;
  createFolder(server: ManagedServer, parent: string, name: unknown): Promise<unknown>;
  uploadFile(server: ManagedServer, parent: string, filename: unknown, contentBase64: unknown): Promise<unknown>;
  renameFile(server: ManagedServer, source: string, name: unknown): Promise<unknown>;
  duplicateFile(server: ManagedServer, source: string, name: unknown): Promise<unknown>;
  deleteFile(server: ManagedServer, target: string, recursive: unknown): Promise<unknown>;
  listMods(server: ManagedServer): Promise<unknown>;
  modIcon(server: ManagedServer, filename: unknown): Promise<ModIconResult | null>;
  toggleMod(server: ManagedServer, filename: unknown, enabled: unknown): Promise<unknown>;
  removeMod(server: ManagedServer, filename: unknown): Promise<unknown>;
  uploadMod(server: ManagedServer, filename: unknown, contentBase64: unknown): Promise<unknown>;
  installMod(server: ManagedServer, input: unknown): Promise<unknown>;
};

export class LocalNodeRuntime implements NodeRuntime {
  readonly nodeId = "local";

  constructor(private readonly handlers: LocalNodeRuntimeHandlers) {}

  publicServer(server: ManagedServer, nodes?: ManagedNode[]) {
    return this.handlers.publicServer(server, nodes);
  }

  createServer(input: unknown, report?: RuntimeProgressReporter, jobId?: string) {
    return this.handlers.createServer(input, report, jobId);
  }

  updateServer(server: ManagedServer, input: unknown) {
    return this.handlers.updateServer(server.id, input);
  }

  deleteServer(server: ManagedServer, input: unknown) {
    return this.handlers.deleteServer(server, input);
  }

  serverStatus(server: ManagedServer) {
    return this.handlers.serverStatus(server);
  }

  lifecycle(server: ManagedServer, action: RuntimeAction) {
    return this.handlers.lifecycle(server, action);
  }

  sendConsoleCommand(server: ManagedServer, command: unknown) {
    return this.handlers.sendConsoleCommand(server, command);
  }

  streamConsole(server: ManagedServer, client: unknown, onClose: (cleanup: () => void) => void) {
    return this.handlers.streamConsole(server, client, onClose);
  }

  serverLogs(server: ManagedServer) {
    return this.handlers.serverLogs(server);
  }

  onlinePlayerCount(server: ManagedServer) {
    return this.handlers.onlinePlayerCount(server);
  }

  serverStats(server: ManagedServer) {
    return this.handlers.serverStats(server);
  }

  serverOverview(server: ManagedServer) {
    return this.handlers.serverOverview(server);
  }

  resolveExistingPath(server: ManagedServer, path: string) {
    return this.handlers.resolveExistingPath(server, path);
  }

  resolveWritablePath(server: ManagedServer, path: string) {
    return this.handlers.resolveWritablePath(server, path);
  }

  resolveWritableResolvedPath(server: ManagedServer, path: string) {
    return this.handlers.resolveWritableResolvedPath(server, path);
  }

  publicPath(server: ManagedServer, absolutePath: string) {
    return this.handlers.publicPath(server, absolutePath);
  }

  isModsPath(server: ManagedServer, absolutePath: string) {
    return this.handlers.isModsPath(server, absolutePath);
  }

  isServerSettingsFile(server: ManagedServer, absolutePath: string) {
    return this.handlers.isServerSettingsFile(server, absolutePath);
  }

  fileRenamePermission(server: ManagedServer, source: string, target: string) {
    return this.handlers.fileRenamePermission(server, source, target);
  }

  listFiles(server: ManagedServer, target: string) {
    return this.handlers.listFiles(server, target);
  }

  previewFile(server: ManagedServer, target: string) {
    return this.handlers.previewFile(server, target);
  }

  downloadFile(server: ManagedServer, target: string) {
    return this.handlers.downloadFile(server, target);
  }

  readFile(server: ManagedServer, target: string) {
    return this.handlers.readFile(server, target);
  }

  writeFile(server: ManagedServer, target: string, content: unknown) {
    return this.handlers.writeFile(server, target, content);
  }

  createFolder(server: ManagedServer, parent: string, name: unknown) {
    return this.handlers.createFolder(server, parent, name);
  }

  uploadFile(server: ManagedServer, parent: string, filename: unknown, contentBase64: unknown) {
    return this.handlers.uploadFile(server, parent, filename, contentBase64);
  }

  renameFile(server: ManagedServer, source: string, name: unknown) {
    return this.handlers.renameFile(server, source, name);
  }

  duplicateFile(server: ManagedServer, source: string, name: unknown) {
    return this.handlers.duplicateFile(server, source, name);
  }

  deleteFile(server: ManagedServer, target: string, recursive: unknown) {
    return this.handlers.deleteFile(server, target, recursive);
  }

  listMods(server: ManagedServer) {
    return this.handlers.listMods(server);
  }

  modIcon(server: ManagedServer, filename: unknown) {
    return this.handlers.modIcon(server, filename);
  }

  toggleMod(server: ManagedServer, filename: unknown, enabled: unknown) {
    return this.handlers.toggleMod(server, filename, enabled);
  }

  removeMod(server: ManagedServer, filename: unknown) {
    return this.handlers.removeMod(server, filename);
  }

  uploadMod(server: ManagedServer, filename: unknown, contentBase64: unknown) {
    return this.handlers.uploadMod(server, filename, contentBase64);
  }

  installMod(server: ManagedServer, input: unknown) {
    return this.handlers.installMod(server, input);
  }
}
