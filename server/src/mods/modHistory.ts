import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { runtimeForServer, services } from "../appServices.js";
import { safeInstalledModFilename } from "../core.js";
import { throwHttp } from "../http/errors.js";
import { managedContentRuntime } from "../servers/versions.js";
import { ModHistoryRepository, type ModHistorySnapshot, type StoredModHistoryEntry } from "../storage/modHistoryRepository.js";
import type { ManagedServer, ModHistoryEntry, Permission } from "../types.js";
import { modFileSizeLimit, sizeLimitTransform, uploadManagedContentBuffer } from "./managedContent.js";
import { listModsWithPanelMetadata, modsFromListResult, remoteModMetadata } from "./modService.js";

export type ModHistoryActor = { id: string; username: string };
export function modHistoryRepository() { return new ModHistoryRepository(services.storageDatabase); }

export function modHistoryBackupAvailable(server: ManagedServer, entry: StoredModHistoryEntry) {
  return [entry.before, entry.after].every((snapshot) => !snapshot || existsSync(archivePath(server, snapshot.sha1)));
}

export async function removeModHistoryArchives(server: ManagedServer) {
  await rm(archiveDirectory(server), { recursive: true, force: true });
}

function archiveDirectory(server: ManagedServer) {
  // Server identifiers never become filesystem paths supplied by a request.
  return join(dirname(services.storageDatabase.path), "mod-history", createHash("sha256").update(server.id).digest("hex"));
}

function archivePath(server: ManagedServer, sha1: string) {
  if (!/^[a-f0-9]{40}$/.test(sha1)) throw new Error("Invalid mod history checksum");
  return join(archiveDirectory(server), `${sha1}.jar`);
}

export async function readModHistorySnapshot(server: ManagedServer): Promise<ModHistorySnapshot[]> {
  const listed = await listModsWithPanelMetadata(server);
  const preferences = services.modPreferencesRepository.list(server.id);
  return modsFromListResult(listed).map((mod) => {
    const filename = safeInstalledModFilename(mod.filename as string);
    const metadata = remoteModMetadata(mod.modrinth);
    return {
      identity: metadata?.projectId ? `project:${metadata.projectId}` : `file:${filename.replace(/\.disabled$/, "")}`,
      directory: managedContentRuntime(server).directory,
      displayName: typeof mod.displayName === "string" ? mod.displayName : filename,
      filename,
      version: metadata?.versionNumber || null,
      enabled: mod.enabled === true,
      // Only the runtime's actual file hash is suitable for conflict detection, not catalog metadata.
      sha1: typeof mod.sha1 === "string" ? mod.sha1 : "",
      preference: preferences[filename]
    };
  });
}

export async function archiveModSnapshot(server: ManagedServer, snapshots: ModHistorySnapshot[]) {
  await mkdir(archiveDirectory(server), { recursive: true });
  for (const snapshot of snapshots) {
    if (/^[a-f0-9]{40}$/.test(snapshot.sha1) && existsSync(archivePath(server, snapshot.sha1))) continue;
    const runtime = runtimeForServer(server);
    const source = await runtime.resolveExistingPath(server, `${managedContentRuntime(server).directory}/${snapshot.filename}`);
    const download = await runtime.downloadFile(server, source);
    const temporary = join(archiveDirectory(server), `${randomUUID()}.tmp`);
    const hash = createHash("sha1");
    try {
      await pipeline(download.stream, sizeLimitTransform(modFileSizeLimit), new Transform({
        transform(chunk: Buffer, _encoding, callback) { hash.update(chunk); callback(null, chunk); }
      }), createWriteStream(temporary, { flags: "wx" }));
      const actual = hash.digest("hex");
      if (snapshot.sha1 && actual !== snapshot.sha1) throw new Error("A mod changed while its history backup was being saved. Retry the action.");
      snapshot.sha1 = actual;
      await rename(temporary, archivePath(server, actual));
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

export function sameModState(left: ModHistorySnapshot | null | undefined, right: ModHistorySnapshot | null | undefined) {
  return !left || !right ? !left && !right : Boolean(left.sha1 && left.sha1 === right.sha1 && left.filename === right.filename && left.enabled === right.enabled);
}

export function modHistoryChanges(before: ModHistorySnapshot[], after: ModHistorySnapshot[], user: ModHistoryActor, revertsEntryId: string | null = null): StoredModHistoryEntry[] {
  const remaining = [...after];
  const pairs: Array<[ModHistorySnapshot | null, ModHistorySnapshot | null]> = before.map((previous) => {
    let index = remaining.findIndex((next) => next.filename === previous.filename);
    if (index < 0) index = remaining.findIndex((next) => next.identity === previous.identity);
    return [previous, index < 0 ? null : remaining.splice(index, 1)[0]];
  });
  pairs.push(...remaining.map((next): [null, ModHistorySnapshot] => [null, next]));
  return pairs.filter(([previous, next]) => !sameModState(previous, next)).map(([previous, next]) => ({
    id: randomUUID(), modName: (next ?? previous)!.displayName,
    action: !previous ? "installed" : !next ? "removed" : previous.sha1 !== next.sha1 ? "updated" : previous.enabled !== next.enabled ? next.enabled ? "enabled" : "disabled" : "updated",
    before: previous, after: next, occurredAt: new Date().toISOString(), user: { id: user.id, username: user.username }, revertsEntryId, revertedAt: null
  }));
}

export function modRevertPermission(entry: StoredModHistoryEntry): Permission {
  if (!entry.before) return "mods.remove";
  if (!entry.after) return entry.before.preference?.modrinth ? "mods.install" : "mods.upload";
  return entry.action === "enabled" || entry.action === "disabled" ? "mods.enableDisable" : "mods.update";
}

export function modRevertConflict(entry: StoredModHistoryEntry, current: ModHistorySnapshot[], directory?: string) {
  if (entry.revertedAt) return "This action has already been reverted.";
  const target = entry.after ?? entry.before!;
  if (directory && target.directory !== directory) return "The server now uses a different content directory. This action cannot be restored to its current runtime.";
  const matches = current.filter((mod) => mod.filename === target.filename || mod.identity === target.identity);
  if (entry.after ? matches.length !== 1 || !sameModState(matches[0], entry.after) : matches.length !== 0) {
    return "This mod has changed since this action. Revert its newer changes first.";
  }
  if (entry.before && current.some((mod) => mod !== matches[0] && (
    mod.filename.replace(/\.disabled$/, "") === entry.before!.filename.replace(/\.disabled$/, "") || mod.identity === entry.before!.identity
  ))) return "Another installed mod uses the filename or project to be restored.";
  return null;
}

export function publicModHistoryEntry(entry: StoredModHistoryEntry, reason: string | null): ModHistoryEntry {
  const version = (snapshot: ModHistorySnapshot | null) => snapshot ? { filename: snapshot.filename, version: snapshot.version, enabled: snapshot.enabled } : null;
  return { id: entry.id, modName: entry.modName, action: entry.action, before: version(entry.before), after: version(entry.after),
    occurredAt: entry.occurredAt, user: entry.user, revertsEntryId: entry.revertsEntryId, revertedAt: entry.revertedAt, canRevert: !reason, revertBlockedReason: reason };
}

export async function pruneModHistoryArchives(server: ManagedServer, current: ModHistorySnapshot[]) {
  const retained = new Set([...current, ...modHistoryRepository().list(server.id).flatMap((entry) => [entry.before, entry.after])]
    .filter((snapshot) => snapshot !== null).map((snapshot) => snapshot.sha1));
  for (const file of await readdir(archiveDirectory(server))) {
    if (/^[a-f0-9]{40}\.jar$/.test(file) && !retained.has(file.slice(0, -4))) await rm(join(archiveDirectory(server), file));
  }
}

async function restoreSnapshot(server: ManagedServer, snapshot: ModHistorySnapshot, content: Buffer) {
  const runtime = runtimeForServer(server);
  const enabledFilename = snapshot.filename.replace(/\.disabled$/, "");
  await uploadManagedContentBuffer(runtime, server, enabledFilename, content);
  if (!snapshot.enabled) await runtime.toggleMod(server, enabledFilename, false);
  const preferences = services.modPreferencesRepository.list(server.id);
  if (snapshot.preference) preferences[snapshot.filename] = snapshot.preference;
  else delete preferences[snapshot.filename];
  services.modPreferencesRepository.replaceAll(server.id, preferences);
}

async function verifiedBackup(server: ManagedServer, snapshot: ModHistorySnapshot) {
  const content = await readFile(archivePath(server, snapshot.sha1));
  if (createHash("sha1").update(content).digest("hex") !== snapshot.sha1) throw new Error("The saved jar failed its integrity check; the installed mod was left unchanged.");
  return content;
}

/** Runs inside withTrackedModMutation, sharing the same lock as ordinary changes. */
export async function revertModHistoryEntry(server: ManagedServer, entry: StoredModHistoryEntry) {
  const current = await readModHistorySnapshot(server);
  const conflict = modRevertConflict(entry, current, managedContentRuntime(server).directory);
  if (conflict) throwHttp(409, conflict, { code: "MOD_HISTORY_CONFLICT" });
  const beforeBytes = entry.before ? await verifiedBackup(server, entry.before) : null;
  const afterBytes = entry.after ? await verifiedBackup(server, entry.after) : null;
  const runtime = runtimeForServer(server);
  try {
    if (entry.after) await runtime.removeMod(server, entry.after.filename);
    if (entry.before && beforeBytes) await restoreSnapshot(server, entry.before, beforeBytes);
  } catch (error) {
    // Undo any partially completed upload/toggle before putting the current version back.
    try {
      const current = await readModHistorySnapshot(server);
      if (entry.after && current.some((mod) => sameModState(mod, entry.after))) throw error;
      if (entry.before) {
        for (const file of current.filter((mod) => mod.filename.replace(/\.disabled$/, "") === entry.before!.filename.replace(/\.disabled$/, ""))) {
          await runtime.removeMod(server, file.filename);
        }
      }
      if (entry.after && afterBytes) await restoreSnapshot(server, entry.after, afterBytes);
    } catch (rollbackError) {
      if (rollbackError === error) throw error;
      throw new AggregateError([error, rollbackError], "Revert and recovery failed. Saved jars are retained in mod history; check the installed files before retrying.");
    }
    throw error;
  }
  return { ok: true };
}
