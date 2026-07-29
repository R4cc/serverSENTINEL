import type { ExportLockfileEntry } from "@serversentinel/contracts";
import { services } from "../appServices.js";
import { errorLogFields, logWarn } from "../logging.js";
import { fetchProjects, fetchVersions, modrinthJarFile, normalizeReleaseChannel, versionChannel } from "../modrinth/compatibility.js";
import { downloadModrinthJar } from "../mods/modService.js";
import { uploadManagedContentBuffer } from "../mods/managedContent.js";
import { serverLogFields } from "../runtime/local/dockerContainers.js";
import type { ContentRestoreReport } from "../importExport.js";
import type { InstalledModMetadata, ManagedServer, ModPreference, ModrinthProject, ModrinthVersion } from "../types.js";
import type { NodeRuntime } from "../nodes/types.js";

/**
 * Re-downloads the content a lockfile describes.
 *
 * Modrinth versions can be deleted long after an export was taken, so every jar is reported
 * individually and a missing one never aborts the import: the operator gets a named list of what did
 * not come back rather than a server that silently starts without half its mods.
 */
export async function restoreLockfileContent(
  runtime: NodeRuntime,
  server: ManagedServer,
  lockfile: ExportLockfileEntry[]
): Promise<ContentRestoreReport> {
  if (!lockfile.length) return { restored: 0, failures: [] };

  const failures: ContentRestoreReport["failures"] = [];
  let restored = 0;

  let versions = new Map<string, ModrinthVersion>();
  try {
    versions = await fetchVersions(lockfile.map((entry) => entry.versionId), { forceRefresh: true });
  } catch (error) {
    logWarn({ ...serverLogFields(server), action: "import_content_restore", ...errorLogFields(error) }, "Modrinth version lookup failed during import");
  }

  const preferences: Record<string, ModPreference> = {};
  const projectIds = new Set<string>();
  for (const entry of lockfile) {
    const version = versions.get(entry.versionId);
    if (version?.project_id) projectIds.add(version.project_id);
  }
  let projects = new Map<string, ModrinthProject>();
  if (projectIds.size) {
    try {
      projects = await fetchProjects([...projectIds]);
    } catch {
      // Side metadata only; a missing project entry never blocks the jar itself.
    }
  }

  for (const entry of lockfile) {
    const version = versions.get(entry.versionId);
    if (!version) {
      failures.push({ filename: entry.filename, reason: `Modrinth version ${entry.versionNumber} is no longer available` });
      continue;
    }
    const file = modrinthJarFile(version);
    if (!file) {
      failures.push({ filename: entry.filename, reason: `Modrinth version ${entry.versionNumber} no longer publishes a .jar` });
      continue;
    }
    try {
      const content = await downloadModrinthJar(file);
      // The lockfile records the exported filename, including a .disabled suffix, so a mod that was
      // switched off before the export comes back switched off.
      const targetFilename = entry.enabled ? entry.filename : entry.filename.replace(/\.disabled$/, "");
      await uploadManagedContentBuffer(runtime, server, targetFilename, content);
      if (!entry.enabled) await runtime.toggleMod(server, targetFilename, false);
      const project = version.project_id ? projects.get(version.project_id) : undefined;
      const metadata: InstalledModMetadata = {
        projectId: version.project_id ?? entry.projectId,
        versionId: version.id,
        filename: entry.filename,
        versionNumber: version.version_number,
        versionType: versionChannel(version.version_type),
        gameVersions: version.game_versions ?? [],
        loaders: version.loaders ?? [],
        hashes: file.hashes,
        installedAt: new Date().toISOString(),
        installedWithForceIncompatible: false,
        clientSide: project?.client_side,
        serverSide: project?.server_side
      };
      preferences[entry.filename] = { channel: normalizeReleaseChannel(entry.channel), modrinth: metadata };
      restored += 1;
    } catch (error) {
      failures.push({
        filename: entry.filename,
        reason: error instanceof Error ? error.message : "Download failed"
      });
    }
  }

  if (Object.keys(preferences).length) {
    const existing = services.modPreferencesRepository.list(server.id);
    services.modPreferencesRepository.replaceAll(server.id, { ...existing, ...preferences });
  }
  return { restored, failures };
}
