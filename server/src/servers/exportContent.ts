import type { ExportLockfileEntry } from "@serversentinel/contracts";
import { errorLogFields, logWarn } from "../logging.js";
import { batchVersionsFromSha1, listModsWithPanelMetadata, modsFromListResult, remoteModMetadata } from "../mods/modService.js";
import { normalizeReleaseChannel, versionChannel } from "../modrinth/compatibility.js";
import { serverLogFields } from "../runtime/local/dockerContainers.js";
import type { ManagedServer, ModPreference, ModrinthVersion } from "../types.js";

export type ContentPlan = {
  /** Restorable from Modrinth on import; the jar bytes stay out of the archive. */
  lockfile: ExportLockfileEntry[];
  /** Filenames Modrinth could not identify, which must travel as real files. */
  shippedFilenames: string[];
  /**
   * Ship every jar and ignore `shippedFilenames` entirely. Set when the installed content could not
   * be enumerated, which is the one case where the panel does not know what a lockfile would contain
   * and so cannot safely leave anything out.
   */
  shipAll: boolean;
  warnings: string[];
};

function lockfileEntry(filename: string, enabled: boolean, metadata: {
  projectId: string;
  versionId: string;
  versionNumber: string;
  versionType?: string;
  hashes?: Record<string, string>;
}, fallbackSha1?: string): ExportLockfileEntry {
  return {
    filename,
    enabled,
    projectId: metadata.projectId,
    versionId: metadata.versionId,
    versionNumber: metadata.versionNumber,
    channel: normalizeReleaseChannel(metadata.versionType),
    sha1: metadata.hashes?.sha1 ?? fallbackSha1
  };
}

/**
 * Decides, per installed jar, whether it can be restored from Modrinth or has to be carried.
 *
 * Panel-installed content already has its Modrinth version recorded, so it costs nothing. Manually
 * uploaded jars get one bulk SHA-1 lookup -- the same hash the mods list already computes -- and only
 * the genuinely unidentifiable ones fall through to being shipped whole.
 */
export async function planServerContent(server: ManagedServer, strategy: "lockfile" | "jars"): Promise<ContentPlan> {
  if (strategy === "jars") {
    return { lockfile: [], shippedFilenames: [], shipAll: true, warnings: [] };
  }
  let mods: Array<Record<string, unknown>>;
  try {
    mods = modsFromListResult(await listModsWithPanelMetadata(server));
  } catch (error) {
    logWarn({ ...serverLogFields(server), action: "export_content_plan", ...errorLogFields(error) }, "Could not list installed content for the export lockfile; shipping jars instead");
    return {
      lockfile: [],
      shippedFilenames: [],
      shipAll: true,
      warnings: ["Installed content could not be listed, so mod and plugin jars were included in full"]
    };
  }

  const lockfile: ExportLockfileEntry[] = [];
  const shippedFilenames: string[] = [];
  const warnings: string[] = [];
  const unresolved: Array<{ filename: string; enabled: boolean; sha1: string }> = [];

  for (const mod of mods) {
    const filename = typeof mod.filename === "string" ? mod.filename : "";
    if (!filename) continue;
    const enabled = mod.enabled !== false;
    const metadata = remoteModMetadata(mod.modrinth);
    const sha1 = typeof mod.sha1 === "string" ? mod.sha1 : "";
    if (metadata) {
      lockfile.push(lockfileEntry(filename, enabled, metadata, sha1 || undefined));
      continue;
    }
    if (sha1) {
      unresolved.push({ filename, enabled, sha1 });
      continue;
    }
    shippedFilenames.push(filename);
  }

  if (unresolved.length) {
    let resolved = new Map<string, ModrinthVersion>();
    try {
      resolved = await batchVersionsFromSha1(unresolved.map((entry) => entry.sha1));
    } catch (error) {
      logWarn({ ...serverLogFields(server), action: "export_content_hash_lookup", ...errorLogFields(error) }, "Modrinth hash lookup failed during export; unmatched jars will be included in full");
    }
    for (const entry of unresolved) {
      const version = resolved.get(entry.sha1);
      if (version?.project_id) {
        lockfile.push(lockfileEntry(entry.filename, entry.enabled, {
          projectId: version.project_id,
          versionId: version.id,
          versionNumber: version.version_number,
          versionType: versionChannel(version.version_type),
          hashes: version.files?.find((file) => file.hashes?.sha1 === entry.sha1 || file.primary)?.hashes
        }, entry.sha1));
        continue;
      }
      shippedFilenames.push(entry.filename);
    }
  }

  if (shippedFilenames.length) {
    warnings.push(`${shippedFilenames.length} mod or plugin file(s) could not be matched on Modrinth and were included in full`);
  }
  lockfile.sort((left, right) => left.filename.localeCompare(right.filename));
  shippedFilenames.sort();
  return { lockfile, shippedFilenames, shipAll: false, warnings };
}

/**
 * The filenames a lockfile export would leave out, judged from stored preferences alone.
 *
 * Used by the size estimate, which runs on every checkbox toggle and so must not spend a Modrinth
 * hash lookup. Content the panel installed already has its version recorded, so this covers the
 * common case; a jar that only a hash lookup could identify is still counted as shipping, which
 * keeps the estimate on the pessimistic side of the real archive.
 */
export function lockfileOmittedFilenames(preferences: Record<string, ModPreference>) {
  return new Set(Object.entries(preferences)
    .filter(([, preference]) => Boolean(preference.modrinth?.versionId))
    .map(([filename]) => filename));
}
