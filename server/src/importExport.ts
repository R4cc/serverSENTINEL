import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  EXPORT_ARTIFACT_TYPE,
  EXPORT_CATEGORIES,
  EXPORT_MANIFEST_ENTRY,
  EXPORT_SCHEMA_VERSION,
  type ExportCategory,
  type ExportLockfileEntry,
  type ExportSelection,
  type ImportIssue,
  type ImportValidationResult
} from "@serversentinel/contracts";
import type { ManagedServer, ModPreference } from "./types.js";
import { currentSchemaVersion, type StorageDatabase } from "./storage/database.js";
import { defaultServerContainerName, serverDirectory, serverStorageName } from "./storage/serverIdentity.js";
import type { ServersRepository } from "./storage/serversRepository.js";
import type { ModPreferencesRepository } from "./storage/modPreferencesRepository.js";
import { serverRuntimeDefinition } from "@serversentinel/contracts";
import { parseDockerPorts } from "./core.js";
import { assertRuntimeProvider, runtimeTarget } from "./runtime/profile.js";
import { createZipArchiveStream, type FileArchiveEntry } from "./downloadArchive.js";
import { extractZipArchive, readZipEntryBuffer } from "./zipArchive.js";
import { archiveEntriesForFiles, collectServerCategories, type CollectedCategory } from "./servers/exportSelection.js";
import { planServerContent } from "./servers/exportContent.js";
import { config } from "./config.js";
import type { NodeRuntime } from "./nodes/types.js";

export const exportArtifactType = EXPORT_ARTIFACT_TYPE;
export const exportArtifactSchemaVersion = EXPORT_SCHEMA_VERSION;

const maxManifestBytes = 64 * 1024 * 1024;
const contentFileSuffixes = [".jar", ".jar.disabled"];

export const importZipLimits = {
  maxEntries: config.importMaxFiles,
  maxExpandedBytes: config.importMaxExpandedBytes
};

export type ExportManifestFile = {
  /** Relative to the server's archive folder; the bytes live at `servers/<key>/<path>`. */
  path: string;
  size: number;
};

export type ExportManifestServer = {
  key: string;
  server: ManagedServer;
  modPreferences: Record<string, ModPreference>;
  lockfile: ExportLockfileEntry[];
  files: ExportManifestFile[];
};

export type ExportManifest = {
  artifactType: typeof EXPORT_ARTIFACT_TYPE;
  schemaVersion: typeof EXPORT_SCHEMA_VERSION;
  manifest: {
    exportedAt: string;
    appVersion: string;
    sqliteSchemaVersion: number;
    selection: ExportSelection;
    content: {
      servers: number;
      files: number;
      totalBytes: number;
    };
  };
  warnings: string[];
  servers: ExportManifestServer[];
};

export type ExportPlan = {
  manifest: ExportManifest;
  entries: FileArchiveEntry[];
  /** Archive members generated in memory rather than read from a server directory. */
  synthetic: Map<string, Buffer>;
  /**
   * How to open a member, keyed by its `servers/<key>` prefix. Reads go through the owning server's
   * runtime rather than the panel's filesystem, so a server on a remote node streams over the node
   * protocol instead of silently reading whatever happens to sit at that path on the panel.
   */
  openers: Map<string, (sourcePath: string) => Promise<Readable>>;
  totalBytes: number;
};

type ExportInput = {
  appVersion: string;
  servers: ManagedServer[];
  selection: ExportSelection;
  runtimeForServer: (server: ManagedServer) => NodeRuntime;
  modPreferencesForServer: (serverId: string) => Record<string, ModPreference>;
  report?: (progress: number, task: string) => void;
};

type ImportContext = {
  targetNodeId?: string;
  localNodeId: string;
  existingServers: ManagedServer[];
  serversDir: string;
  tmpDir: string;
};

type ApplyImportContext = ImportContext & {
  storage: StorageDatabase;
  serversRepository: ServersRepository;
  modPreferencesRepository: ModPreferencesRepository;
  /** Restores lockfile content after the files land; failures are reported, never fatal. */
  restoreContent?: (server: ManagedServer, lockfile: ExportLockfileEntry[]) => Promise<ContentRestoreReport>;
  /**
   * Fetches the runtime jar, which is never carried in the archive because the runtime profile
   * already names an immutable, checksummed artifact. Without it an imported server has nothing to
   * launch, so a failure here is reported prominently rather than discarded.
   */
  restoreRuntimeJar?: (server: ManagedServer) => Promise<void>;
  report?: (progress: number, task: string) => void;
};

export type ContentRestoreReport = {
  restored: number;
  failures: Array<{ filename: string; reason: string }>;
};

export function exportArtifactFilename(operationId: string) {
  return `serversentinel-export-${operationId}.zip`;
}

function archiveSlug(value: string) {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.slice(0, 48) || "server";
}

export function serverArchiveKey(index: number, server: Pick<ManagedServer, "displayName">) {
  return `${String(index + 1).padStart(3, "0")}-${archiveSlug(server.displayName)}`;
}

function isContentFile(relativePath: string, contentDirectory: string) {
  const prefix = `${contentDirectory}/`;
  if (!relativePath.startsWith(prefix)) return false;
  const name = relativePath.slice(prefix.length);
  return !name.includes("/") && contentFileSuffixes.some((suffix) => name.endsWith(suffix));
}

/**
 * Panel bookkeeping that describes a running instance rather than its configuration. None of it is
 * meaningful on a freshly imported server, and carrying it would resurrect stale crash counters.
 */
function exportableServerRecord(server: ManagedServer, includePanelSettings: boolean): ManagedServer {
  const {
    restartPhase: _restartPhase,
    crashAttemptTimestamps: _crashAttemptTimestamps,
    crashNextRetryAt: _crashNextRetryAt,
    crashLoopSince: _crashLoopSince,
    crashStableSince: _crashStableSince,
    restartRequiredSince: _restartRequiredSince,
    restartRequiredChanges: _restartRequiredChanges,
    restartRequiredModBaseline: _restartRequiredModBaseline,
    runtimeIntent: _runtimeIntent,
    ...retained
  } = server;
  if (includePanelSettings) return retained;
  // Ports, image, and runtime profile always travel: without them the record cannot be created or
  // conflict-checked. Panel settings are the discretionary extras.
  const { schedules: _schedules, javaArgs: _javaArgs, startOnNodeStart: _startOnNodeStart, ...core } = retained;
  return core;
}

export async function createExportPlan(input: ExportInput): Promise<ExportPlan> {
  const includePanelSettings = input.selection.categories.includes("panelSettings");
  const includeContent = input.selection.categories.includes("content");
  const entries: FileArchiveEntry[] = [];
  const synthetic = new Map<string, Buffer>();
  const openers = new Map<string, (sourcePath: string) => Promise<Readable>>();
  const manifestServers: ExportManifestServer[] = [];
  const warnings: string[] = [];
  let totalBytes = 0;

  for (const [index, server] of input.servers.entries()) {
    const progress = 10 + Math.floor((index / Math.max(input.servers.length, 1)) * 70);
    input.report?.(progress, `Collecting ${server.displayName}`);
    const key = serverArchiveKey(index, server);
    const runtime = input.runtimeForServer(server);
    const collected = await collectServerCategories(runtime, server, input.selection.categories);

    let lockfile: ExportLockfileEntry[] = [];
    let shipped: Set<string> | undefined;
    if (includeContent && input.selection.contentStrategy === "lockfile") {
      const plan = await planServerContent(server, "lockfile");
      lockfile = plan.lockfile;
      // `undefined` keeps every jar. Only a plan that actually enumerated the content may narrow the
      // set, so a failed enumeration ships everything instead of quietly excluding all of it.
      shipped = plan.shipAll ? undefined : new Set(plan.shippedFilenames);
      for (const warning of plan.warnings) warnings.push(`${server.displayName}: ${warning}`);
    }

    const files = filesForServer(server, collected, includeContent, shipped);
    totalBytes += files.reduce((total, file) => total + file.size, 0);
    if (totalBytes > config.exportMaxBytes) {
      throw new Error(`Export exceeds the ${Math.floor(config.exportMaxBytes / 1024 / 1024 / 1024)} GiB limit. Deselect the world or export fewer servers.`);
    }
    entries.push(...archiveEntriesForFiles(`servers/${key}`, files));
    openers.set(`servers/${key}`, async (sourcePath) => (await runtime.downloadFile(server, sourcePath)).stream);
    manifestServers.push({
      key,
      server: exportableServerRecord(server, includePanelSettings),
      modPreferences: includePanelSettings ? input.modPreferencesForServer(server.id) : {},
      lockfile,
      files: files.map((file) => ({ path: file.relativePath, size: file.size }))
    });
  }

  input.report?.(85, "Writing export manifest");
  const manifest: ExportManifest = {
    artifactType: EXPORT_ARTIFACT_TYPE,
    schemaVersion: EXPORT_SCHEMA_VERSION,
    manifest: {
      exportedAt: new Date().toISOString(),
      appVersion: input.appVersion,
      sqliteSchemaVersion: currentSchemaVersion,
      selection: input.selection,
      content: {
        servers: manifestServers.length,
        files: entries.length,
        totalBytes
      }
    },
    warnings,
    servers: manifestServers
  };
  const manifestBuffer = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  synthetic.set(EXPORT_MANIFEST_ENTRY, manifestBuffer);
  entries.unshift({
    sourcePath: EXPORT_MANIFEST_ENTRY,
    archivePath: EXPORT_MANIFEST_ENTRY,
    type: "file",
    size: manifestBuffer.byteLength
  });
  return { manifest, entries, synthetic, openers, totalBytes };
}

function filesForServer(
  server: ManagedServer,
  collected: CollectedCategory[],
  includeContent: boolean,
  shipped: Set<string> | undefined
) {
  const contentDirectory = serverRuntimeDefinition(runtimeTarget(server).runtimeType).contentDirectory;
  const files: CollectedCategory["files"] = [];
  const seen = new Set<string>();
  for (const category of collected) {
    for (const file of category.files) {
      if (seen.has(file.relativePath)) continue;
      // In lockfile mode only the jars Modrinth could not identify are carried; sibling files such as
      // a content folder's icon cache still travel so the folder arrives intact.
      if (
        includeContent
        && shipped
        && isContentFile(file.relativePath, contentDirectory)
        && !shipped.has(basename(file.relativePath))
      ) {
        continue;
      }
      seen.add(file.relativePath);
      files.push(file);
    }
  }
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

export async function writeExportArchive(path: string, plan: ExportPlan, report?: (progress: number, task: string) => void) {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const hash = createHash("sha256");
  const digest = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    }
  });
  try {
    report?.(88, "Compressing export archive");
    const archive = createZipArchiveStream(
      plan.entries,
      async (entry) => {
        const generated = plan.synthetic.get(entry.archivePath);
        if (generated) return Readable.from([generated]);
        const prefix = entry.archivePath.split("/").slice(0, 2).join("/");
        const open = plan.openers.get(prefix);
        if (!open) throw new Error(`No reader is registered for archive member ${entry.archivePath}`);
        return open(entry.sourcePath);
      },
      { compress: true }
    );
    await pipeline(archive, digest, createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 }));
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
  const written = await stat(path);
  return {
    path,
    filename: basename(path),
    size: written.size,
    sha256: hash.digest("hex")
  };
}

export function exportDownloadStream(path: string) {
  return createReadStream(path);
}

export async function readExportManifest(archivePath: string): Promise<ExportManifest> {
  const buffer = await readZipEntryBuffer(archivePath, EXPORT_MANIFEST_ENTRY, maxManifestBytes, importZipLimits);
  let parsed: unknown;
  try {
    parsed = JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new Error("Export manifest must be valid JSON");
  }
  return assertExportManifest(parsed);
}

export function assertExportManifest(value: unknown): ExportManifest {
  if (!isPlainObject(value)) throw new Error("Export manifest must be an object");
  rejectUnsupportedKeys(value, ["artifactType", "schemaVersion", "manifest", "warnings", "servers"], "manifest");
  if (value.artifactType !== EXPORT_ARTIFACT_TYPE) throw new Error("Unsupported import artifact type");
  if (value.schemaVersion !== EXPORT_SCHEMA_VERSION) {
    throw new Error(`Unsupported import schema version; this serverSENTINEL release requires export schema ${EXPORT_SCHEMA_VERSION}. Recreate the export with this version.`);
  }
  if (!isPlainObject(value.manifest)) throw new Error("Import manifest section is required");
  assertManifestHeader(value.manifest);
  if (value.warnings !== undefined) stringArray(value.warnings, "manifest.warnings");
  if (!Array.isArray(value.servers)) throw new Error("Import servers section must be an array");
  if (value.servers.length > config.importMaxServers) {
    throw new Error(`Import artifact contains more than ${config.importMaxServers} servers`);
  }
  let fileCount = 0;
  const keys = new Set<string>();
  for (const [serverIndex, entry] of value.servers.entries()) {
    const label = `servers[${serverIndex}]`;
    if (!isPlainObject(entry)) throw new Error(`Import ${label} must be an object`);
    rejectUnsupportedKeys(entry, ["key", "server", "modPreferences", "lockfile", "files"], label);
    const key = stringValue(entry.key, `${label}.key`);
    assertSafeArchiveSegment(key, `${label}.key`);
    if (keys.has(key)) throw new Error(`Import ${label}.key is duplicated`);
    keys.add(key);
    if (!isPlainObject(entry.server)) throw new Error(`Import ${label}.server is required`);
    assertImportServer(entry.server, `${label}.server`);
    if (!isPlainObject(entry.modPreferences)) throw new Error(`Import ${label}.modPreferences is required`);
    assertImportModPreferences(entry.modPreferences, `${label}.modPreferences`);
    if (!Array.isArray(entry.lockfile)) throw new Error(`Import ${label}.lockfile must be an array`);
    for (const [lockIndex, lock] of entry.lockfile.entries()) {
      assertLockfileEntry(lock, `${label}.lockfile[${lockIndex}]`);
    }
    if (!Array.isArray(entry.files)) throw new Error(`Import ${label}.files must be an array`);
    fileCount += entry.files.length;
    if (fileCount > config.importMaxFiles) {
      throw new Error(`Import artifact describes more than ${config.importMaxFiles} files`);
    }
    for (const [fileIndex, file] of entry.files.entries()) {
      const fileLabel = `${label}.files[${fileIndex}]`;
      if (!isPlainObject(file)) throw new Error(`Import ${fileLabel} must be an object`);
      rejectUnsupportedKeys(file, ["path", "size"], fileLabel);
      assertSafeArchiveRelativePath(stringValue(file.path, `${fileLabel}.path`));
      if (typeof file.size !== "number" || !Number.isInteger(file.size) || file.size < 0) {
        throw new Error(`Import ${fileLabel}.size must be a non-negative integer`);
      }
    }
  }
  return value as unknown as ExportManifest;
}

function assertManifestHeader(header: Record<string, unknown>) {
  rejectUnsupportedKeys(header, ["exportedAt", "appVersion", "sqliteSchemaVersion", "selection", "content"], "manifest.manifest");
  stringValue(header.exportedAt, "manifest.exportedAt");
  stringValue(header.appVersion, "manifest.appVersion");
  if (typeof header.sqliteSchemaVersion !== "number") throw new Error("manifest.sqliteSchemaVersion must be a number");
  if (!isPlainObject(header.selection)) throw new Error("manifest.selection is required");
  rejectUnsupportedKeys(header.selection, ["categories", "contentStrategy"], "manifest.selection");
  const categories = header.selection.categories;
  if (!Array.isArray(categories) || !categories.length) throw new Error("manifest.selection.categories must be a non-empty array");
  for (const category of categories) {
    if (typeof category !== "string" || !(EXPORT_CATEGORIES as readonly string[]).includes(category)) {
      throw new Error(`manifest.selection.categories contains unknown category ${String(category)}`);
    }
  }
  if (header.selection.contentStrategy !== "lockfile" && header.selection.contentStrategy !== "jars") {
    throw new Error("manifest.selection.contentStrategy must be lockfile or jars");
  }
  if (!isPlainObject(header.content)) throw new Error("manifest.content is required");
}

function assertLockfileEntry(value: unknown, label: string) {
  if (!isPlainObject(value)) throw new Error(`${label} must be a JSON object`);
  rejectUnsupportedKeys(value, ["filename", "enabled", "projectId", "versionId", "versionNumber", "channel", "sha1"], label);
  assertSafeModPreferenceFilename(stringValue(value.filename, `${label}.filename`), `${label}.filename`);
  booleanValue(value.enabled, `${label}.enabled`);
  stringValue(value.projectId, `${label}.projectId`);
  stringValue(value.versionId, `${label}.versionId`);
  stringValue(value.versionNumber, `${label}.versionNumber`);
  assertReleaseChannel(value.channel, `${label}.channel`);
  if (value.sha1 !== undefined && (typeof value.sha1 !== "string" || !/^[0-9a-f]{40}$/i.test(value.sha1))) {
    throw new Error(`${label}.sha1 must be a 40-character hexadecimal hash`);
  }
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
    "startOnNodeStart",
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
  optionalBooleanValue(server.startOnNodeStart, `${label}.startOnNodeStart`);
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
    "runtimeType",
    "runtimeVersion",
    "javaMajorVersion",
    "jarProvider",
    "jarArtifact",
    "compatibilityStatus",
    "resolvedAt"
  ], label);
  stringValue(profile.minecraftVersion, `${label}.minecraftVersion`);
  const runtimeType = stringValue(profile.runtimeType, `${label}.runtimeType`);
  stringValue(profile.runtimeVersion, `${label}.runtimeVersion`);
  if (runtimeType !== "fabric" && runtimeType !== "paper") throw new Error(`${label}.runtimeType must be fabric or paper`);
  if (typeof profile.javaMajorVersion !== "number" || !Number.isInteger(profile.javaMajorVersion)) {
    throw new Error(`${label}.javaMajorVersion must be an integer`);
  }
  const jarProvider = stringValue(profile.jarProvider, `${label}.jarProvider`);
  if (jarProvider !== "mcjars" && jarProvider !== "papermc") {
    throw new Error(`${label}.jarProvider must be mcjars or papermc`);
  }
  assertRuntimeProvider(runtimeType, jarProvider, `${label}.jarProvider`);
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
    rejectUnsupportedKeys(schedule, ["id", "name", "cron", "steps", "onlyWhenNoPlayers", "enabled", "createdAt", "updatedAt", "lastRunAt", "lastStatus", "lastMessage", "nextRunAt", "recentRuns"], `${label}[${index}]`);
    stringValue(schedule.id, `${label}[${index}].id`);
    stringValue(schedule.name, `${label}[${index}].name`);
    stringValue(schedule.cron, `${label}[${index}].cron`);
    if (!Array.isArray(schedule.steps) || schedule.steps.length === 0) throw new Error(`${label}[${index}].steps must be a non-empty array`);
    for (const [stepIndex, step] of schedule.steps.entries()) {
      if (!isPlainObject(step)) throw new Error(`${label}[${index}].steps[${stepIndex}] must be a JSON object`);
      const allowed = step.type === "command" ? ["type", "command", "delaySeconds"] : ["type", "procedure", "delaySeconds"];
      rejectUnsupportedKeys(step, allowed, `${label}[${index}].steps[${stepIndex}]`);
      if (step.type !== "command" && step.type !== "action") throw new Error(`${label}[${index}].steps[${stepIndex}].type must be command or action`);
      if (step.type === "command") stringValue(step.command, `${label}[${index}].steps[${stepIndex}].command`);
      if (step.type === "action" && step.procedure !== "restart") throw new Error(`${label}[${index}].steps[${stepIndex}].procedure must be restart`);
      if (!Number.isInteger(step.delaySeconds) || (step.delaySeconds as number) < 0 || (step.delaySeconds as number) > 604_800) throw new Error(`${label}[${index}].steps[${stepIndex}].delaySeconds must be a whole number from 0 to 604800`);
    }
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
    rejectUnsupportedKeys(run, ["id", "scheduleId", "scheduleName", "status", "message", "ranAt", "details"], `${label}[${index}]`);
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
    "iconUrl",
    "forceIncompatible",
    "reviewAcknowledgedVersionId",
    "reviewAcknowledgedAt"
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
  optionalStringValue(value.iconUrl, `${label}.iconUrl`);
  optionalBooleanValue(value.forceIncompatible, `${label}.forceIncompatible`);
  optionalStringValue(value.reviewAcknowledgedVersionId, `${label}.reviewAcknowledgedVersionId`);
  optionalStringValue(value.reviewAcknowledgedAt, `${label}.reviewAcknowledgedAt`);
}

export function validateImportArchive(manifest: ExportManifest, context: ImportContext): ImportValidationResult {
  const targetNodeId = context.targetNodeId?.trim() || "";
  const issues: ImportIssue[] = [];
  const warnings: ImportIssue[] = [];

  if (!targetNodeId) {
    issues.push({ code: "missing_node_target", message: "A valid target node is required before importing servers" });
  } else if (targetNodeId !== context.localNodeId) {
    // Imported files are written to the panel's own servers directory. Registering them against a
    // remote node would produce a record pointing at a directory that node cannot see.
    issues.push({
      code: "missing_node_target",
      message: "Imports can only be restored onto the local node. Import here, then move the server to another node."
    });
  }

  const existingNames = new Set(context.existingServers.map((server) => server.displayName.toLowerCase()));
  const plannedNames = new Set<string>();
  const existingContainerNames = new Set(context.existingServers.map((server) => server.dockerContainer?.toLowerCase()).filter(Boolean));
  const existingPortKeys = new Set<string>();
  for (const server of context.existingServers) {
    if (server.nodeId !== targetNodeId) continue;
    for (const port of portKeysForServer(server)) existingPortKeys.add(port);
  }

  const plan: ImportValidationResult["plan"]["servers"] = [];
  for (const entry of manifest.servers) {
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
    // The container is always renamed for the new id, so a collision is a warning rather than a stop.
    const lowerContainer = source.dockerContainer?.toLowerCase();
    if (lowerContainer && existingContainerNames.has(lowerContainer)) {
      warnings.push({
        code: "conflicting_container_name",
        serverName: source.displayName,
        message: `Container name "${source.dockerContainer}" is already in use; the imported server gets a fresh one`
      });
    }
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
          message: `Port ${port}/${protocol} already belongs to another server on this node`
        });
      }
      existingPortKeys.add(key);
    }
    for (const file of entry.files) {
      try {
        assertSafeArchiveRelativePath(file.path);
      } catch (error) {
        issues.push({
          code: "invalid_path",
          serverName: source.displayName,
          path: file.path,
          message: error instanceof Error ? error.message : "Invalid import path"
        });
      }
    }
    if (entry.lockfile.length) {
      warnings.push({
        code: "lockfile_download_required",
        serverName: source.displayName,
        message: `${entry.lockfile.length} mod/plugin file(s) will be re-downloaded from Modrinth`
      });
    }
    plan.push({
      sourceId: source.id,
      newId,
      displayName,
      storageName: serverStorageName(newId),
      serverDir: serverDirectory(context.serversDir, newId),
      fileCount: entry.files.length,
      totalBytes: entry.files.reduce((total, file) => total + file.size, 0),
      lockfileCount: entry.lockfile.length
    });
  }

  return {
    valid: issues.length === 0,
    issues,
    warnings,
    plan: {
      targetNodeId,
      categories: manifest.manifest.selection.categories as ExportCategory[],
      servers: plan
    }
  };
}

export async function applyImportArchive(archivePath: string, manifest: ExportManifest, context: ApplyImportContext) {
  const validation = validateImportArchive(manifest, context);
  if (!validation.valid) {
    throw new Error(`Import validation failed: ${validation.issues.map((issue) => issue.message).join("; ")}`);
  }

  const stagingDir = join(context.tmpDir, `import-${randomUUID()}`);
  const imported: Array<{ sourceId: string; serverId: string; displayName: string; fileCount: number }> = [];
  const contentFailures: Array<{ serverName: string; filename: string; reason: string }> = [];
  const runtimeJarFailures: Array<{ serverName: string; reason: string }> = [];
  const writtenDirs: string[] = [];

  try {
    context.report?.(10, "Extracting archive");
    await rm(stagingDir, { recursive: true, force: true });
    await mkdir(stagingDir, { recursive: true });
    await extractZipArchive({
      archivePath,
      destinationPath: stagingDir,
      conflictPolicy: "replace",
      limits: importZipLimits,
      report: (progress, task) => context.report?.(10 + Math.round(progress * 0.5), task)
    });

    const prepared: Array<{ entry: ExportManifestServer; remapped: ManagedServer }> = [];
    for (const [index, entry] of manifest.servers.entries()) {
      const plan = validation.plan.servers[index];
      const staged = join(stagingDir, "servers", entry.key);
      assertPathInside(stagingDir, staged, "Import staging path escapes the staging directory");
      await mkdir(dirname(plan.serverDir), { recursive: true });
      // A server folder can legitimately be absent when only panel settings were exported.
      await mkdir(staged, { recursive: true });
      await rename(staged, plan.serverDir);
      writtenDirs.push(plan.serverDir);
      prepared.push({
        entry,
        remapped: remapImportedServer(entry.server, {
          id: plan.newId,
          targetNodeId: validation.plan.targetNodeId,
          displayName: plan.displayName,
          serverDir: plan.serverDir,
          storageName: plan.storageName,
          now: new Date().toISOString()
        })
      });
    }

    context.report?.(70, "Registering imported servers");
    context.storage.transaction(() => {
      for (const item of prepared) {
        context.serversRepository.create(item.remapped);
        context.modPreferencesRepository.replaceAll(item.remapped.id, item.entry.modPreferences);
        imported.push({
          sourceId: item.entry.server.id,
          serverId: item.remapped.id,
          displayName: item.remapped.displayName,
          fileCount: item.entry.files.length
        });
      }
    });

    for (const [index, item] of prepared.entries()) {
      const base = 70 + Math.floor((index / Math.max(prepared.length, 1)) * 25);
      if (context.restoreRuntimeJar) {
        context.report?.(base, `Downloading the runtime for ${item.remapped.displayName}`);
        try {
          await context.restoreRuntimeJar(item.remapped);
        } catch (error) {
          runtimeJarFailures.push({
            serverName: item.remapped.displayName,
            reason: error instanceof Error ? error.message : "The runtime jar could not be downloaded"
          });
        }
      }
      if (context.restoreContent && item.entry.lockfile.length) {
        context.report?.(base + 3, `Restoring content for ${item.remapped.displayName}`);
        const report = await context.restoreContent(item.remapped, item.entry.lockfile);
        for (const failure of report.failures) {
          contentFailures.push({ serverName: item.remapped.displayName, ...failure });
        }
      }
    }
  } catch (error) {
    await Promise.all(writtenDirs.map((directory) => rm(directory, { recursive: true, force: true })));
    throw error;
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
  }

  context.report?.(100, "Import complete");
  return {
    imported,
    warnings: validation.warnings,
    contentFailures,
    runtimeJarFailures,
    idMap: Object.fromEntries(imported.map((server) => [server.sourceId, server.serverId]))
  };
}

function assertSafeArchiveSegment(value: string, label: string) {
  if (!value || value.includes("/") || value.includes("\\") || value === "." || value === ".." || value.includes("\0")) {
    throw new Error(`${label} must be a single safe path segment`);
  }
}

function assertSafeArchiveRelativePath(path: string) {
  if (typeof path !== "string" || !path || path.includes("\0") || path.includes("\\") || /^[a-zA-Z]:/.test(path) || path.startsWith("/")) {
    throw new Error("Import file path is invalid");
  }
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Import file path must be normalized and stay inside the server directory");
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
    // Always fresh: reusing the exported container name would collide with the source instance when
    // both live on the same host, which is the common case for a restore-onto-the-same-panel.
    dockerContainer: defaultServerContainerName(input.id),
    dockerMountSource: config.serversDockerVolume || input.serverDir,
    dockerWorkingDir: config.serversDockerVolume ? `/data/servers/${input.storageName}` : undefined,
    runtimeIntent: "stopped",
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
        recentRuns: []
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
