import type { InstalledMod } from "../../types";

export type ModDependencyLinks = {
  /** Installed mods this mod needs to load. */
  requires: InstalledMod[];
  /** Installed mods that need this one to load. */
  requiredBy: InstalledMod[];
};

export type ModDependencyGraph = {
  linksFor(mod: InstalledMod): ModDependencyLinks;
};

const noLinks: ModDependencyLinks = Object.freeze({ requires: [], requiredBy: [] }) as ModDependencyLinks;

/**
 * Links installed mods through the required dependencies the server reported for each one. A
 * dependency resolves to an installed mod by Modrinth project first and by exact version second,
 * the same order the server uses when it decides whether the dependency is satisfied, so a link
 * appears exactly when the server counts that file as the one meeting the requirement.
 */
export function buildModDependencyGraph(mods: readonly InstalledMod[]): ModDependencyGraph {
  const byProject = new Map<string, InstalledMod>();
  const byVersion = new Map<string, InstalledMod>();
  for (const mod of mods) {
    if (mod.modrinth?.projectId && !byProject.has(mod.modrinth.projectId)) byProject.set(mod.modrinth.projectId, mod);
    if (mod.modrinth?.versionId && !byVersion.has(mod.modrinth.versionId)) byVersion.set(mod.modrinth.versionId, mod);
  }
  const links = new Map<string, ModDependencyLinks>();
  const entry = (mod: InstalledMod) => {
    let value = links.get(mod.filename);
    if (!value) {
      value = { requires: [], requiredBy: [] };
      links.set(mod.filename, value);
    }
    return value;
  };
  for (const mod of mods) {
    for (const dependency of mod.dependencyHealth?.required ?? []) {
      const target = (dependency.projectId ? byProject.get(dependency.projectId) : undefined)
        ?? (dependency.versionId ? byVersion.get(dependency.versionId) : undefined);
      if (!target || target === mod) continue;
      const own = entry(mod);
      if (own.requires.includes(target)) continue;
      own.requires.push(target);
      entry(target).requiredBy.push(mod);
    }
  }
  for (const value of links.values()) {
    value.requires.sort(byName);
    value.requiredBy.sort(byName);
  }
  return { linksFor: (mod) => links.get(mod.filename) ?? noLinks };
}

function byName(a: InstalledMod, b: InstalledMod) {
  return a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" });
}

/** Mods that would stop loading if this one were disabled or removed. */
export function enabledDependents(links: ModDependencyLinks) {
  return links.requiredBy.filter((mod) => mod.enabled);
}

/** "Lithium", "Lithium and Krypton", "Lithium, Krypton and Sodium", "Lithium, Krypton and 2 more". */
export function formatModNames(mods: readonly InstalledMod[], visible = 2) {
  const names = mods.map((mod) => mod.displayName);
  if (names.length <= 1) return names[0] ?? "";
  // "and 1 more" hides a single name behind a count that takes as much room as the name itself.
  if (names.length <= visible + 1) return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `${names.slice(0, visible).join(", ")} and ${names.length - visible} more`;
}

/**
 * Brings each mod's reported dependency health up to date with the installed list in hand. The
 * server assesses dependencies on a scan, but a library can be switched off or back on between
 * scans; without this the mods that need it would keep reading "Healthy" until the next check.
 * The result matches what the server's next scan reports: a disabled library counts as missing
 * (and repairable by enabling it), an enabled one does not. Unchanged mods keep their identity.
 */
export function reconcileDependencyHealth(mods: InstalledMod[]): InstalledMod[] {
  const graph = buildModDependencyGraph(mods);
  let changed = false;
  const reconciled = mods.map((mod) => {
    const health = mod.dependencyHealth;
    if (!health?.required?.length) return mod;
    const installedFor = (dependency: { projectId?: string; versionId?: string }) => graph.linksFor(mod).requires.find((installed) => (
      (dependency.projectId && installed.modrinth?.projectId === dependency.projectId)
      || (dependency.versionId && installed.modrinth?.versionId === dependency.versionId)
    ));
    const missing = health.missing.filter((dependency) => !installedFor(dependency)?.enabled);
    for (const dependency of health.required) {
      const installed = installedFor(dependency);
      if (!installed || installed.enabled || missing.some((entry) => installedFor(entry) === installed)) continue;
      missing.push({ projectId: dependency.projectId, versionId: dependency.versionId, title: installed.displayName, iconUrl: installed.iconUrl, disabled: true });
    }
    const status = missing.length > 0 ? "missing" as const : health.status === "unknown" ? "unknown" as const : "satisfied" as const;
    if (status === health.status && missing.length === health.missing.length && missing.every((entry, index) => entry === health.missing[index])) return mod;
    changed = true;
    return { ...mod, dependencyHealth: { ...health, status, missing } };
  });
  return changed ? reconciled : mods;
}
