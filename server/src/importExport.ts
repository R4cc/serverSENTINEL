import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { AppSettings, ManagedNode, ManagedServer, ModPreference } from "./types.js";
import { currentSchemaVersion, type StorageDatabase } from "./storage/database.js";
import { defaultServerContainerName, serverDirectory, serverStorageName } from "./storage/serverIdentity.js";
import type { ServersRepository } from "./storage/serversRepository.js";
import type { ModPreferencesRepository } from "./storage/modPreferencesRepository.js";
import type { SettingsRepository } from "./storage/settingsRepository.js";
import { parseDockerPorts } from "./core.js";

export const exportArtifactType = "serversentinel.export";
export const exportArtifactSchemaVersion = 1;
const maxExportedConfigFileBytes = 2 * 1024 * 1024;
const excludedServerFileRoots = new Set([
  "backups",
  "cache",
  "crash-reports",
  "libraries",
  "logs",
  "versions",
  "world",
  "world_nether",
  "world_the_end",
  "worlds"
]);
const includedRootFiles = new Set([
  ".serversentinel-version.json",
  "banned-ips.json",
  "banned-players.json",
  "eula.txt",
  "ops.json",
  "permissions.json",
  "server.properties",
  "usercache.json",
  "whitelist.json"
]);
const includedDirectoryRoots = new Set(["config", "defaultconfigs"]);

export type ExportServerEntry = {
  server: ManagedServer;
  modPreferences: Record<string, ModPreference>;
  files: ExportedServerFile[];
};

export type ExportedServerFile = {
  path: string;
  size: number;
  sha256: string;
  contentBase64: string;
};

export type ExportArtifact = {
  artifactType: typeof exportArtifactType;
  schemaVersion: typeof exportArtifactSchemaVersion;
  manifest: {
    exportedAt: string;
    appVersion: string;
    sqliteSchemaVersion: number;
    content: {
      instance: boolean;
      servers: number;
      serverFiles: number;
    };
  };
  instance: {
    settings: AppSettings;
    nodes: Array<Omit<ManagedNode, "secretHash" | "joinTokenHash">>;
  };
  servers: ExportServerEntry[];
};

export type ImportIssue = {
  code: string;
  message: string;
  serverName?: string;
  path?: string;
};

export type ImportValidationResult = {
  valid: boolean;
  issues: ImportIssue[];
  warnings: ImportIssue[];
  plan: {
    targetNodeId: string;
    servers: Array<{
      sourceId: string;
      newId: string;
      displayName: string;
      storageName: string;
      serverDir: string;
      fileCount: number;
    }>;
  };
};

type ExportInput = {
  appVersion: string;
  settings: AppSettings;
  nodes: ManagedNode[];
  servers: ManagedServer[];
  selectedServerIds?: string[];
  modPreferencesForServer: (serverId: string) => Record<string, ModPreference>;
  report?: (progress: number, task: string) => void;
};

type ImportContext = {
  targetNodeId?: string;
  nodes: ManagedNode[];
  existingServers: ManagedServer[];
  serversDir: string;
  tmpDir: string;
};

type ApplyImportContext = ImportContext & {
  storage: StorageDatabase;
  serversRepository: ServersRepository;
  modPreferencesRepository: ModPreferencesRepository;
  settingsRepository: SettingsRepository;
  importInstanceSettings?: boolean;
  report?: (progress: number, task: string) => void;
};

export function exportArtifactFilename(operationId: string) {
  return `serversentinel-export-${operationId}.json`;
}

export async function createExportArtifact(input: ExportInput): Promise<ExportArtifact> {
  const selectedIds = input.selectedServerIds?.length ? new Set(input.selectedServerIds) : undefined;
  const selectedServers = input.servers.filter((server) => !selectedIds || selectedIds.has(server.id));
  if (selectedIds && selectedServers.length !== selectedIds.size) {
    throw new Error("One or more selected servers could not be found");
  }
  input.report?.(10, "Collecting SQLite configuration");
  const servers: ExportServerEntry[] = [];
  for (const [index, server] of selectedServers.entries()) {
    input.report?.(20 + Math.floor((index / Math.max(selectedServers.length, 1)) * 60), `Collecting ${server.displayName}`);
    servers.push({
      server,
      modPreferences: input.modPreferencesForServer(server.id),
      files: await collectServerConfigFiles(server.serverDir)
    });
  }
  const serverFiles = servers.reduce((count, entry) => count + entry.files.length, 0);
  input.report?.(90, "Writing export manifest");
  return {
    artifactType: exportArtifactType,
    schemaVersion: exportArtifactSchemaVersion,
    manifest: {
      exportedAt: new Date().toISOString(),
      appVersion: input.appVersion,
      sqliteSchemaVersion: currentSchemaVersion,
      content: {
        instance: true,
        servers: servers.length,
        serverFiles
      }
    },
    instance: {
      settings: input.settings,
      nodes: input.nodes.map((node) => ({
        id: node.id,
        name: node.name,
        type: node.type,
        status: node.status,
        isInternal: node.isInternal,
        createdAt: node.createdAt,
        updatedAt: node.updatedAt,
        lastSeenAt: node.lastSeenAt,
        connectedAt: node.connectedAt,
        agentVersion: node.agentVersion,
        protocolVersion: node.protocolVersion,
        capabilities: node.capabilities,
        dockerStatus: node.dockerStatus,
        dataPathStatus: node.dataPathStatus,
        totalMemory: node.totalMemory,
        compatibility: node.compatibility,
        joinTokenExpiresAt: node.joinTokenExpiresAt
      }))
    },
    servers
  };
}

export async function writeExportArtifact(path: string, artifact: ExportArtifact) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return {
    path,
    filename: basename(path),
    size: (await stat(path)).size,
    sha256: createHash("sha256").update(await readFile(path)).digest("hex")
  };
}

export function parseExportArtifactBase64(contentBase64: string): ExportArtifact {
  if (typeof contentBase64 !== "string" || !contentBase64.trim()) {
    throw new Error("Import artifact contentBase64 is required");
  }
  const normalizedContent = contentBase64.trim();
  assertBase64(normalizedContent, "Import artifact contentBase64");
  const decoded = Buffer.from(normalizedContent, "base64").toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw new Error("Import artifact must be valid JSON");
  }
  return assertExportArtifact(parsed);
}

export function assertExportArtifact(value: unknown): ExportArtifact {
  if (!isPlainObject(value)) throw new Error("Import artifact must be an object");
  rejectUnsupportedKeys(value, ["artifactType", "schemaVersion", "manifest", "instance", "servers"], "artifact");
  if (value.artifactType !== exportArtifactType) throw new Error("Unsupported import artifact type");
  if (value.schemaVersion !== exportArtifactSchemaVersion) throw new Error("Unsupported import schema version");
  if (!isPlainObject(value.manifest)) throw new Error("Import manifest is required");
  if (!isPlainObject(value.instance)) throw new Error("Import instance section is required");
  if (!Array.isArray(value.servers)) throw new Error("Import servers section must be an array");
  for (const [serverIndex, entry] of value.servers.entries()) {
    if (!isPlainObject(entry)) throw new Error(`Import servers[${serverIndex}] must be an object`);
    rejectUnsupportedKeys(entry, ["server", "modPreferences", "files"], `servers[${serverIndex}]`);
    if (!isPlainObject(entry.server)) throw new Error(`Import servers[${serverIndex}].server is required`);
    if (!isPlainObject(entry.modPreferences)) throw new Error(`Import servers[${serverIndex}].modPreferences is required`);
    assertImportServer(entry.server, `servers[${serverIndex}].server`);
    assertImportModPreferences(entry.modPreferences, `servers[${serverIndex}].modPreferences`);
    if (!Array.isArray(entry.files)) throw new Error(`Import servers[${serverIndex}].files must be an array`);
    for (const [fileIndex, file] of entry.files.entries()) {
      if (!isPlainObject(file)) throw new Error(`Import servers[${serverIndex}].files[${fileIndex}] must be an object`);
      rejectUnsupportedKeys(file, ["path", "size", "sha256", "contentBase64"], `servers[${serverIndex}].files[${fileIndex}]`);
      const filePath = assertSafeArtifactPath(stringValue(file.path, "file.path"));
      const fileSize = file.size;
      if (typeof fileSize !== "number" || !Number.isInteger(fileSize) || fileSize < 0 || fileSize > maxExportedConfigFileBytes) {
        throw new Error(`Import file ${filePath} has an invalid size`);
      }
      if (typeof file.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(file.sha256)) {
        throw new Error(`Import file ${filePath} has an invalid sha256`);
      }
      if (typeof file.contentBase64 !== "string") {
        throw new Error(`Import file ${filePath} contentBase64 is required`);
      }
      assertBase64(file.contentBase64, `Import file ${filePath} contentBase64`);
      const buffer = Buffer.from(file.contentBase64, "base64");
      if (buffer.length !== fileSize) throw new Error(`Import file ${filePath} size does not match content`);
      if (createHash("sha256").update(buffer).digest("hex") !== file.sha256) {
        throw new Error(`Import file ${filePath} checksum does not match content`);
      }
      if (!shouldIncludeRelativePath(filePath, fileSize)) {
        throw new Error(`Import file ${filePath} is not a supported configuration file`);
      }
    }
  }
  return value as ExportArtifact;
}

function assertImportServer(server: Record<string, unknown>, label: string) {
  rejectUnsupportedKeys(server, [
    "id",
    "nodeId",
    "displayName",
    "serverDir",
    "storageName",
    "runtimeProfile",
    "dockerContainer",
    "dockerImage",
    "dockerMountSource",
    "dockerWorkingDir",
    "dockerPorts",
    "managedPorts",
    "javaArgs",
    "restartRequiredSince",
    "schedules",
    "createdAt",
    "updatedAt"
  ], label);
  stringValue(server.id, `${label}.id`);
  stringValue(server.nodeId, `${label}.nodeId`);
  stringValue(server.displayName, `${label}.displayName`);
  stringValue(server.serverDir, `${label}.serverDir`);
  stringValue(server.createdAt, `${label}.createdAt`);
  stringValue(server.updatedAt, `${label}.updatedAt`);
  optionalStringValue(server.storageName, `${label}.storageName`);
  optionalStringValue(server.dockerContainer, `${label}.dockerContainer`);
  optionalStringValue(server.dockerImage, `${label}.dockerImage`);
  optionalStringValue(server.dockerMountSource, `${label}.dockerMountSource`);
  optionalStringValue(server.dockerWorkingDir, `${label}.dockerWorkingDir`);
  optionalStringValue(server.javaArgs, `${label}.javaArgs`);
  optionalStringValue(server.restartRequiredSince, `${label}.restartRequiredSince`);
  const dockerPorts = optionalStringValue(server.dockerPorts, `${label}.dockerPorts`);
  if (dockerPorts) parseDockerPorts(dockerPorts);
  if (!isPlainObject(server.runtimeProfile)) throw new Error(`${label}.runtimeProfile must be a JSON object`);
  assertRuntimeProfile(server.runtimeProfile, `${label}.runtimeProfile`);
  if (server.managedPorts !== undefined) assertManagedPorts(server.managedPorts, `${label}.managedPorts`);
  if (server.schedules !== undefined) assertSchedules(server.schedules, `${label}.schedules`);
}

function assertRuntimeProfile(profile: Record<string, unknown>, label: string) {
  rejectUnsupportedKeys(profile, [
    "minecraftVersion",
    "loader",
    "loaderVersion",
    "javaMajorVersion",
    "jarProvider",
    "jarArtifact",
    "compatibilityStatus",
    "resolvedAt"
  ], label);
  stringValue(profile.minecraftVersion, `${label}.minecraftVersion`);
  stringValue(profile.loader, `${label}.loader`);
  stringValue(profile.loaderVersion, `${label}.loaderVersion`);
  if (typeof profile.javaMajorVersion !== "number" || !Number.isInteger(profile.javaMajorVersion)) {
    throw new Error(`${label}.javaMajorVersion must be an integer`);
  }
  stringValue(profile.jarProvider, `${label}.jarProvider`);
  if (!isPlainObject(profile.jarArtifact)) throw new Error(`${label}.jarArtifact must be a JSON object`);
  rejectUnsupportedKeys(profile.jarArtifact, ["id", "filename", "downloadUrl", "sha1", "sha256", "sizeBytes"], `${label}.jarArtifact`);
  optionalStringValue(profile.jarArtifact.id, `${label}.jarArtifact.id`);
  stringValue(profile.jarArtifact.filename, `${label}.jarArtifact.filename`);
  optionalStringValue(profile.jarArtifact.downloadUrl, `${label}.jarArtifact.downloadUrl`);
  optionalStringValue(profile.jarArtifact.sha1, `${label}.jarArtifact.sha1`);
  optionalStringValue(profile.jarArtifact.sha256, `${label}.jarArtifact.sha256`);
  if (profile.jarArtifact.sizeBytes !== undefined && (typeof profile.jarArtifact.sizeBytes !== "number" || !Number.isInteger(profile.jarArtifact.sizeBytes) || profile.jarArtifact.sizeBytes < 0)) {
    throw new Error(`${label}.jarArtifact.sizeBytes must be a non-negative integer`);
  }
  stringValue(profile.compatibilityStatus, `${label}.compatibilityStatus`);
  stringValue(profile.resolvedAt, `${label}.resolvedAt`);
}

function assertManagedPorts(value: unknown, label: string) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  for (const [index, port] of value.entries()) {
    if (!isPlainObject(port)) throw new Error(`${label}[${index}] must be a JSON object`);
    rejectUnsupportedKeys(port, ["id", "name", "type", "protocol", "internalPort", "externalPort", "required", "removable", "advanced"], `${label}[${index}]`);
    stringValue(port.id, `${label}[${index}].id`);
    stringValue(port.name, `${label}[${index}].name`);
    stringValue(port.type, `${label}[${index}].type`);
    const protocol = stringValue(port.protocol, `${label}[${index}].protocol`);
    if (protocol !== "tcp" && protocol !== "udp") throw new Error(`${label}[${index}].protocol must be tcp or udp`);
    assertPortNumber(port.internalPort, `${label}[${index}].internalPort`);
    assertPortNumber(port.externalPort, `${label}[${index}].externalPort`);
    booleanValue(port.required, `${label}[${index}].required`);
    booleanValue(port.removable, `${label}[${index}].removable`);
    booleanValue(port.advanced, `${label}[${index}].advanced`);
  }
}

function assertSchedules(value: unknown, label: string) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  for (const [index, schedule] of value.entries()) {
    if (!isPlainObject(schedule)) throw new Error(`${label}[${index}] must be a JSON object`);
    rejectUnsupportedKeys(schedule, ["id", "name", "cron", "commands", "onlyWhenNoPlayers", "enabled", "createdAt", "updatedAt", "lastRunAt", "lastStatus", "lastMessage", "nextRunAt", "recentRuns"], `${label}[${index}]`);
    stringValue(schedule.id, `${label}[${index}].id`);
    stringValue(schedule.name, `${label}[${index}].name`);
    stringValue(schedule.cron, `${label}[${index}].cron`);
    stringArray(schedule.commands, `${label}[${index}].commands`);
    booleanValue(schedule.onlyWhenNoPlayers, `${label}[${index}].onlyWhenNoPlayers`);
    booleanValue(schedule.enabled, `${label}[${index}].enabled`);
    stringValue(schedule.createdAt, `${label}[${index}].createdAt`);
    stringValue(schedule.updatedAt, `${label}[${index}].updatedAt`);
    optionalStringValue(schedule.lastRunAt, `${label}[${index}].lastRunAt`);
    optionalStringValue(schedule.lastStatus, `${label}[${index}].lastStatus`);
    optionalStringValue(schedule.lastMessage, `${label}[${index}].lastMessage`);
    optionalStringValue(schedule.nextRunAt, `${label}[${index}].nextRunAt`);
    if (schedule.recentRuns !== undefined) assertScheduledRuns(schedule.recentRuns, `${label}[${index}].recentRuns`);
  }
}

function assertScheduledRuns(value: unknown, label: string) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  for (const [index, run] of value.entries()) {
    if (!isPlainObject(run)) throw new Error(`${label}[${index}] must be a JSON object`);
    rejectUnsupportedKeys(run, ["id", "scheduleId", "scheduleName", "status", "message", "ranAt"], `${label}[${index}]`);
    stringValue(run.id, `${label}[${index}].id`);
    stringValue(run.scheduleId, `${label}[${index}].scheduleId`);
    stringValue(run.scheduleName, `${label}[${index}].scheduleName`);
    stringValue(run.status, `${label}[${index}].status`);
    optionalStringValue(run.message, `${label}[${index}].message`);
    stringValue(run.ranAt, `${label}[${index}].ranAt`);
  }
}

function assertImportModPreferences(preferences: Record<string, unknown>, label: string) {
  for (const [filename, preference] of Object.entries(preferences)) {
    assertSafeModPreferenceFilename(filename, `${label}.${filename}`);
    if (!isPlainObject(preference)) throw new Error(`${label}.${filename} must be a JSON object`);
    rejectUnsupportedKeys(preference, ["channel", "modrinth"], `${label}.${filename}`);
    assertReleaseChannel(preference.channel, `${label}.${filename}.channel`);
    if (preference.modrinth !== undefined) assertInstalledModMetadata(preference.modrinth, `${label}.${filename}.modrinth`);
  }
}

function assertInstalledModMetadata(value: unknown, label: string) {
  if (!isPlainObject(value)) throw new Error(`${label} must be a JSON object`);
  rejectUnsupportedKeys(value, [
    "projectId",
    "versionId",
    "filename",
    "versionNumber",
    "versionType",
    "gameVersions",
    "loaders",
    "hashes",
    "installedAt",
    "installedWithForceIncompatible",
    "incompatibilityReason",
    "overrideMinecraftVersion",
    "overrideReason",
    "clientSide",
    "serverSide",
    "forceIncompatible"
  ], label);
  stringValue(value.projectId, `${label}.projectId`);
  stringValue(value.versionId, `${label}.versionId`);
  assertSafeModPreferenceFilename(stringValue(value.filename, `${label}.filename`), `${label}.filename`);
  stringValue(value.versionNumber, `${label}.versionNumber`);
  if (value.versionType !== undefined) assertReleaseChannel(value.versionType, `${label}.versionType`);
  stringArray(value.gameVersions, `${label}.gameVersions`);
  stringArray(value.loaders, `${label}.loaders`);
  if (value.hashes !== undefined) {
    if (!isPlainObject(value.hashes) || Object.values(value.hashes).some((hash) => typeof hash !== "string")) {
      throw new Error(`${label}.hashes must be a string map`);
    }
  }
  stringValue(value.installedAt, `${label}.installedAt`);
  booleanValue(value.installedWithForceIncompatible, `${label}.installedWithForceIncompatible`);
  optionalStringValue(value.incompatibilityReason, `${label}.incompatibilityReason`);
  optionalBooleanValue(value.overrideMinecraftVersion, `${label}.overrideMinecraftVersion`);
  optionalStringValue(value.overrideReason, `${label}.overrideReason`);
  optionalStringValue(value.clientSide, `${label}.clientSide`);
  optionalStringValue(value.serverSide, `${label}.serverSide`);
  optionalBooleanValue(value.forceIncompatible, `${label}.forceIncompatible`);
}

export function validateImportArtifact(artifact: ExportArtifact, context: ImportContext): ImportValidationResult {
  const targetNodeId = context.targetNodeId?.trim() || "";
  const issues: ImportIssue[] = [];
  const warnings: ImportIssue[] = [];
  const targetNode = context.nodes.find((node) => node.id === targetNodeId);
  if (!targetNode) {
    issues.push({ code: "missing_node_target", message: "A valid target node is required before importing servers" });
  }
  const existingNames = new Set(context.existingServers.map((server) => server.displayName.toLowerCase()));
  const plannedNames = new Set<string>();
  const existingContainerNames = new Set(context.existingServers.map((server) => server.dockerContainer?.toLowerCase()).filter(Boolean));
  const plannedContainerNames = new Set<string>();
  const existingPortKeys = new Set<string>();
  for (const server of context.existingServers) {
    if (server.nodeId !== targetNodeId) continue;
    for (const port of portKeysForServer(server)) existingPortKeys.add(port);
  }
  const plan: ImportValidationResult["plan"]["servers"] = [];
  for (const entry of artifact.servers) {
    const source = entry.server;
    const newId = randomUUID();
    const displayName = uniqueDisplayName(source.displayName, existingNames, plannedNames);
    if (displayName !== source.displayName) {
      warnings.push({
        code: "display_name_renamed",
        serverName: source.displayName,
        message: `Server "${source.displayName}" will be imported as "${displayName}"`
      });
    }
    const lowerContainer = source.dockerContainer?.toLowerCase();
    if (lowerContainer && (existingContainerNames.has(lowerContainer) || plannedContainerNames.has(lowerContainer))) {
      issues.push({
        code: "conflicting_container_name",
        serverName: source.displayName,
        message: `Container name "${source.dockerContainer}" already exists`
      });
    }
    if (lowerContainer) plannedContainerNames.add(lowerContainer);
    let portKeys: string[] = [];
    try {
      portKeys = portKeysForServer(source);
    } catch (error) {
      issues.push({
        code: "invalid_ports",
        serverName: source.displayName,
        message: error instanceof Error ? error.message : "Imported server ports are invalid"
      });
    }
    for (const key of portKeys) {
      const [port, protocol] = key.split("/", 2);
      if (existingPortKeys.has(key)) {
        issues.push({
          code: "conflicting_port",
          serverName: source.displayName,
          message: `Port ${port}/${protocol} already belongs to another server on ${targetNodeId}`
        });
      }
      existingPortKeys.add(key);
    }
    for (const file of entry.files) {
      try {
        assertSafeArtifactPath(file.path);
      } catch (error) {
        issues.push({
          code: "invalid_path",
          serverName: source.displayName,
          path: file.path,
          message: error instanceof Error ? error.message : "Invalid import path"
        });
      }
    }
    plan.push({
      sourceId: source.id,
      newId,
      displayName,
      storageName: serverStorageName(newId),
      serverDir: serverDirectory(context.serversDir, newId),
      fileCount: entry.files.length
    });
  }
  return {
    valid: issues.length === 0,
    issues,
    warnings,
    plan: {
      targetNodeId,
      servers: plan
    }
  };
}

export async function applyImportArtifact(artifact: ExportArtifact, context: ApplyImportContext) {
  const validation = validateImportArtifact(artifact, context);
  if (!validation.valid) {
    throw new Error(`Import validation failed: ${validation.issues.map((issue) => issue.message).join("; ")}`);
  }
  context.report?.(10, "Preparing imported server files");
  const imported: Array<{ sourceId: string; serverId: string; displayName: string; fileCount: number }> = [];
  const writtenDirs: string[] = [];
  const preparedServers: Array<{ entry: ExportServerEntry; remapped: ManagedServer; fileCount: number }> = [];
  try {
    for (const [index, entry] of artifact.servers.entries()) {
      const plan = validation.plan.servers[index];
      const tempDir = join(context.tmpDir, `import-${plan.newId}`);
      await rm(tempDir, { recursive: true, force: true });
      await mkdir(tempDir, { recursive: true });
      for (const file of entry.files) {
        const target = resolve(tempDir, file.path);
        assertPathInside(tempDir, target, "Import file target escapes the prepared server directory");
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, Buffer.from(file.contentBase64, "base64"));
      }
      await mkdir(dirname(plan.serverDir), { recursive: true });
      await rename(tempDir, plan.serverDir);
      writtenDirs.push(plan.serverDir);
      const now = new Date().toISOString();
      const remapped = remapImportedServer(entry.server, {
        id: plan.newId,
        targetNodeId: validation.plan.targetNodeId,
        displayName: plan.displayName,
        serverDir: plan.serverDir,
        storageName: plan.storageName,
        now
      });
      preparedServers.push({ entry, remapped, fileCount: entry.files.length });
    }
    context.storage.transaction(() => {
      for (const [index, prepared] of preparedServers.entries()) {
        context.report?.(25 + Math.floor((index / Math.max(artifact.servers.length, 1)) * 60), `Registering ${prepared.remapped.displayName}`);
        context.serversRepository.create(prepared.remapped);
        context.modPreferencesRepository.replaceAll(prepared.remapped.id, prepared.entry.modPreferences);
        imported.push({
          sourceId: prepared.entry.server.id,
          serverId: prepared.remapped.id,
          displayName: prepared.remapped.displayName,
          fileCount: prepared.fileCount
        });
      }
      if (context.importInstanceSettings !== false) {
        const key = artifact.instance.settings.modrinthApiKey?.trim();
        if (key) context.settingsRepository.setModrinthApiKey(key);
      }
    });
  } catch (error) {
    await Promise.all(writtenDirs.map((directory) => rm(directory, { recursive: true, force: true })));
    throw error;
  }
  context.report?.(100, "Import complete");
  return {
    imported,
    warnings: validation.warnings,
    idMap: Object.fromEntries(imported.map((server) => [server.sourceId, server.serverId]))
  };
}

export function exportDownloadStream(path: string) {
  return createReadStream(path);
}

async function collectServerConfigFiles(serverDir: string): Promise<ExportedServerFile[]> {
  const root = resolve(serverDir);
  const files: ExportedServerFile[] = [];
  await walk(root, "", files);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}

async function walk(root: string, relativePath: string, files: ExportedServerFile[]) {
  let entries;
  try {
    entries = await readdir(join(root, relativePath), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const childRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    if (!canDescendOrInclude(childRelativePath, entry.isDirectory())) continue;
    if (entry.isDirectory()) {
      await walk(root, childRelativePath, files);
      continue;
    }
    if (!entry.isFile()) continue;
    const absolute = join(root, childRelativePath);
    const fileStat = await stat(absolute);
    if (!shouldIncludeRelativePath(childRelativePath, fileStat.size)) continue;
    const buffer = await readFile(absolute);
    files.push({
      path: childRelativePath,
      size: buffer.length,
      sha256: createHash("sha256").update(buffer).digest("hex"),
      contentBase64: buffer.toString("base64")
    });
  }
}

function canDescendOrInclude(relativePath: string, directory: boolean) {
  const firstSegment = relativePath.split("/")[0].toLowerCase();
  if (excludedServerFileRoots.has(firstSegment)) return false;
  if (directory) return includedDirectoryRoots.has(firstSegment);
  return shouldIncludeRelativePath(relativePath, 0);
}

function shouldIncludeRelativePath(path: string, size: number) {
  if (size > maxExportedConfigFileBytes) return false;
  const normalized = assertSafeArtifactPath(path);
  const [firstSegment] = normalized.split("/");
  if (includedRootFiles.has(normalized)) return true;
  return includedDirectoryRoots.has(firstSegment.toLowerCase());
}

function assertSafeArtifactPath(path: string) {
  if (typeof path !== "string" || !path || path.includes("\0") || path.includes("\\") || /^[a-zA-Z]:/.test(path) || path.startsWith("/")) {
    throw new Error("Import file path is invalid");
  }
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Import file path must be normalized and stay inside the server directory");
  }
  const firstSegment = segments[0].toLowerCase();
  if (excludedServerFileRoots.has(firstSegment)) {
    throw new Error(`Import file path ${path} is excluded by default`);
  }
  return segments.join("/");
}

function remapImportedServer(server: ManagedServer, input: {
  id: string;
  targetNodeId: string;
  displayName: string;
  serverDir: string;
  storageName: string;
  now: string;
}): ManagedServer {
  const scheduleIdMap = new Map((server.schedules ?? []).map((schedule) => [schedule.id, randomUUID()]));
  return {
    ...server,
    id: input.id,
    nodeId: input.targetNodeId,
    displayName: input.displayName,
    serverDir: input.serverDir,
    storageName: input.storageName,
    dockerContainer: server.dockerContainer ? server.dockerContainer : defaultServerContainerName(input.id),
    dockerMountSource: input.serverDir,
    dockerWorkingDir: undefined,
    schedules: (server.schedules ?? []).map((schedule) => {
      const scheduleId = scheduleIdMap.get(schedule.id) ?? randomUUID();
      return {
        ...schedule,
        id: scheduleId,
        createdAt: input.now,
        updatedAt: input.now,
        lastRunAt: undefined,
        lastStatus: undefined,
        lastMessage: undefined,
        recentRuns: (schedule.recentRuns ?? []).map((run) => ({
          ...run,
          id: randomUUID(),
          scheduleId,
          ranAt: input.now
        }))
      };
    }),
    createdAt: input.now,
    updatedAt: input.now
  };
}

function uniqueDisplayName(name: string, existingNames: Set<string>, plannedNames: Set<string>) {
  const base = name.trim() || "Imported server";
  let candidate = base;
  let suffix = 2;
  while (existingNames.has(candidate.toLowerCase()) || plannedNames.has(candidate.toLowerCase())) {
    candidate = `${base} (${suffix})`;
    suffix += 1;
  }
  plannedNames.add(candidate.toLowerCase());
  return candidate;
}

function portKeysForServer(server: ManagedServer) {
  const keys = new Set<string>();
  for (const port of server.managedPorts ?? []) {
    keys.add(`${port.externalPort}/${port.protocol}`);
  }
  if (server.dockerPorts) {
    const { portBindings } = parseDockerPorts(server.dockerPorts);
    for (const [containerPort, bindings] of Object.entries(portBindings)) {
      const [, protocol = "tcp"] = containerPort.split("/", 2);
      for (const binding of bindings) {
        keys.add(`${binding.HostPort}/${protocol}`);
      }
    }
  }
  return [...keys];
}

function assertPathInside(root: string, target: string, message: string) {
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  const comparableRoot = process.platform === "win32" ? normalizedRoot.toLowerCase() : normalizedRoot;
  const comparableTarget = process.platform === "win32" ? normalizedTarget.toLowerCase() : normalizedTarget;
  if (comparableTarget !== comparableRoot && !comparableTarget.startsWith(`${comparableRoot}${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error(message);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnsupportedKeys(value: Record<string, unknown>, allowed: string[], label: string) {
  const allowedSet = new Set(allowed);
  const unsupported = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unsupported.length) {
    throw new Error(`Unsupported ${label} content: ${unsupported.join(", ")}`);
  }
}

function assertBase64(value: string, label: string) {
  if (!/^[a-zA-Z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error(`${label} must be valid base64`);
  }
}

function stringValue(value: unknown, field: string) {
  if (typeof value !== "string" || !value) throw new Error(`${field} is required`);
  return value;
}

function optionalStringValue(value: unknown, field: string) {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value;
}

function booleanValue(value: unknown, field: string) {
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

function optionalBooleanValue(value: unknown, field: string) {
  if (value === undefined) return undefined;
  return booleanValue(value, field);
}

function assertReleaseChannel(value: unknown, field: string) {
  if (value !== "release" && value !== "beta" && value !== "alpha") {
    throw new Error(`${field} must be release, beta, or alpha`);
  }
}

function assertPortNumber(value: unknown, field: string) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${field} must be a port from 1 to 65535`);
  }
}

function stringArray(value: unknown, field: string) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be an array of strings`);
  }
}

function assertSafeModPreferenceFilename(filename: string, field: string) {
  if (!filename || filename.includes("/") || filename.includes("\\") || basename(filename) !== filename || (!filename.endsWith(".jar") && !filename.endsWith(".jar.disabled"))) {
    throw new Error(`${field} must be a local .jar filename`);
  }
}
