import { isModuleId, type ModuleId } from "@serversentinel/contracts";
import type { StorageDatabase } from "../storage/database.js";

/**
 * Only the exceptions are stored. A module is enabled unless it appears here, so an installation
 * that upgrades into this release keeps every feature it already had, and a module added in a later
 * release arrives switched on without a migration writing a row for it.
 */
const disabledModulesKey = "modules.disabled";

export function readDisabledModules(storage: StorageDatabase): Set<ModuleId> {
  const raw = storage.metadata(disabledModulesKey);
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    // Unknown ids are dropped rather than kept: they belong to a module this build does not have,
    // and carrying them forward would resurrect a stale opinion if the id were ever reused.
    return new Set(parsed.filter(isModuleId));
  } catch {
    return new Set();
  }
}

export function writeDisabledModules(storage: StorageDatabase, disabled: Iterable<ModuleId>) {
  storage.setMetadata(disabledModulesKey, JSON.stringify([...disabled].filter(isModuleId).sort()));
}
