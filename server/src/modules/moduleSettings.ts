import { isModuleId, type ModuleId } from "@serversentinel/contracts";
import type { StorageDatabase } from "../storage/database.js";

/**
 * Only the exceptions are stored. A module is enabled unless it appears here, so an installation
 * that upgrades into this release keeps every feature it already had, and a module added in a later
 * release arrives switched on without a migration writing a row for it.
 */
const disabledModulesKey = "modules.disabled";

function storedIds(storage: StorageDatabase): string[] {
  const raw = storage.metadata(disabledModulesKey);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

/** Only the ids this build knows about. An unrecognized one is not this registry's business. */
export function readDisabledModules(storage: StorageDatabase): Set<ModuleId> {
  return new Set(storedIds(storage).filter(isModuleId));
}

/**
 * Ids this build does not recognize are written back untouched. A panel rolled back to a release
 * that predates a module would otherwise drop that module's "off" setting on the first unrelated
 * toggle, and rolling forward again would silently switch the feature back on for the installation.
 */
export function writeDisabledModules(storage: StorageDatabase, disabled: Iterable<ModuleId>) {
  const foreign = storedIds(storage).filter((id) => !isModuleId(id));
  const next = [...new Set([...[...disabled].filter(isModuleId), ...foreign])].sort();
  storage.setMetadata(disabledModulesKey, JSON.stringify(next));
}
