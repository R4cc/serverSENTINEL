import type { Readable } from "node:stream";
import type { ManagedNode, ManagedServer, Permission, PublicServer } from "../types.js";

export type RuntimeProgressReporter = (progress: number, task: string) => void;
export type RuntimeAction = "start" | "stop" | "restart";

export type FileDownloadResult = {
  filename: string;
  size: number;
  stream: Readable;
};

export type ModIconResult = {
  contentType: string;
  stream: Readable;
};

export type NodeRuntime = {
  readonly nodeId: string;
  publicServer(server: ManagedServer, nodes?: ManagedNode[]): Promise<PublicServer>;
  createServer(input: unknown, report?: RuntimeProgressReporter, jobId?: string): Promise<ManagedServer>;
  updateServer(server: ManagedServer, input: unknown): Promise<ManagedServer>;
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
  listMods(server: ManagedServer, options?: { forceRefresh?: boolean }): Promise<unknown>;
  modIcon(server: ManagedServer, filename: unknown): Promise<ModIconResult | null>;
  toggleMod(server: ManagedServer, filename: unknown, enabled: unknown): Promise<unknown>;
  removeMod(server: ManagedServer, filename: unknown): Promise<unknown>;
  uploadMod(server: ManagedServer, filename: unknown, contentBase64: unknown): Promise<unknown>;
  installMod(server: ManagedServer, input: unknown): Promise<unknown>;
};
