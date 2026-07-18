import type { ManagedNode, ManagedServer, Permission, PublicServer } from "../types.js";
import type { FileArchiveEntry } from "../downloadArchive.js";
import type { ZipArchiveListing, ZipExtractionPlan, ZipExtractionResult } from "../zipArchive.js";
import type { FileDownloadResult, ModIconResult, NodeRuntime, RuntimeAction, RuntimeProgressReporter } from "./types.js";
import type { PlayerObservation } from "../playerSnapshots.js";

export type LocalNodeRuntimeHandlers = {
  publicServer(server: ManagedServer, nodes?: ManagedNode[]): Promise<PublicServer>;
  createServer(input: unknown, report?: RuntimeProgressReporter, jobId?: string): Promise<ManagedServer>;
  updateServer(serverId: string, input: unknown): Promise<ManagedServer>;
  deleteServer(server: ManagedServer, input: unknown): Promise<unknown>;
  serverStatus(server: ManagedServer): Promise<unknown>;
  lifecycle(server: ManagedServer, action: RuntimeAction): Promise<unknown>;
  sendConsoleCommand(server: ManagedServer, command: unknown): Promise<unknown>;
  streamConsole(server: ManagedServer, client: unknown, onClose: (cleanup: () => void) => void): Promise<void>;
  serverLogs(server: ManagedServer, lineLimit?: number): Promise<unknown>;
  readPlayerObservation(server: ManagedServer): Promise<PlayerObservation>;
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
  downloadArchive(server: ManagedServer, entries: FileArchiveEntry[], filename: string): Promise<FileDownloadResult>;
  listArchive(server: ManagedServer, archivePath: string, entryPath: string): Promise<ZipArchiveListing>;
  previewArchiveEntry(server: ManagedServer, archivePath: string, entryPath: string): Promise<unknown>;
  downloadArchiveEntry(server: ManagedServer, archivePath: string, entryPath: string): Promise<FileDownloadResult>;
  planArchiveExtraction(server: ManagedServer, archivePath: string, destinationPath: string): Promise<ZipExtractionPlan>;
  extractArchive(server: ManagedServer, archivePath: string, destinationPath: string, conflictPolicy: "replace" | "skip", report?: RuntimeProgressReporter): Promise<ZipExtractionResult>;
  readFile(server: ManagedServer, target: string): Promise<unknown>;
  writeFile(server: ManagedServer, target: string, content: unknown): Promise<unknown>;
  createFolder(server: ManagedServer, parent: string, name: unknown): Promise<unknown>;
  uploadFile(server: ManagedServer, parent: string, filename: unknown, contentBase64: unknown): Promise<unknown>;
  renameFile(server: ManagedServer, source: string, name: unknown): Promise<unknown>;
  moveFile(server: ManagedServer, source: string, destinationParent: string): Promise<unknown>;
  duplicateFile(server: ManagedServer, source: string, name: unknown): Promise<unknown>;
  deleteFile(server: ManagedServer, target: string, recursive: unknown): Promise<unknown>;
  listMods(server: ManagedServer, options?: { forceRefresh?: boolean }): Promise<unknown>;
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

  serverLogs(server: ManagedServer, lineLimit?: number) {
    return this.handlers.serverLogs(server, lineLimit);
  }

  readPlayerObservation(server: ManagedServer) {
    return this.handlers.readPlayerObservation(server);
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

  downloadArchive(server: ManagedServer, entries: FileArchiveEntry[], filename: string) {
    return this.handlers.downloadArchive(server, entries, filename);
  }

  listArchive(server: ManagedServer, archivePath: string, entryPath: string) {
    return this.handlers.listArchive(server, archivePath, entryPath);
  }

  previewArchiveEntry(server: ManagedServer, archivePath: string, entryPath: string) {
    return this.handlers.previewArchiveEntry(server, archivePath, entryPath);
  }

  downloadArchiveEntry(server: ManagedServer, archivePath: string, entryPath: string) {
    return this.handlers.downloadArchiveEntry(server, archivePath, entryPath);
  }

  planArchiveExtraction(server: ManagedServer, archivePath: string, destinationPath: string) {
    return this.handlers.planArchiveExtraction(server, archivePath, destinationPath);
  }

  extractArchive(server: ManagedServer, archivePath: string, destinationPath: string, conflictPolicy: "replace" | "skip", report?: RuntimeProgressReporter) {
    return this.handlers.extractArchive(server, archivePath, destinationPath, conflictPolicy, report);
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

  moveFile(server: ManagedServer, source: string, destinationParent: string) {
    return this.handlers.moveFile(server, source, destinationParent);
  }

  duplicateFile(server: ManagedServer, source: string, name: unknown) {
    return this.handlers.duplicateFile(server, source, name);
  }

  deleteFile(server: ManagedServer, target: string, recursive: unknown) {
    return this.handlers.deleteFile(server, target, recursive);
  }

  listMods(server: ManagedServer, options?: { forceRefresh?: boolean }) {
    return this.handlers.listMods(server, options);
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
