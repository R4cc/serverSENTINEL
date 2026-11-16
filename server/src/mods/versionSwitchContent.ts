import { sortVersionSwitchContent, type VersionSwitchContentEntry } from "@serversentinel/contracts";
import { modrinthJarFile } from "../modrinth/compatibility.js";
import type { ModrinthProject, ModrinthVersion, ReleaseChannel } from "../types.js";

/**
 * Decides what a Minecraft version switch does to each installed mod or plugin. Kept free of I/O:
 * every Modrinth lookup arrives through `lookups`, so the decision rules can be tested directly.
 */

export type VersionSwitchInstalledContent = {
  filename: string;
  enabled: boolean;
  iconUrl?: string;
  channel: ReleaseChannel;
  metadata?: {
    projectId: string;
    versionId: string;
    versionNumber?: string;
    gameVersions: string[];
    loaders: string[];
  };
};

export type VersionSwitchLookups = {
  /** The newest installable version of a project for the target, or undefined when none exists. */
  latestForTarget: (projectId: string, channel: ReleaseChannel) => Promise<ModrinthVersion | undefined>;
  versions: (versionIds: string[]) => Promise<Map<string, ModrinthVersion>>;
  projects: (projectIds: string[]) => Promise<Map<string, ModrinthProject>>;
};

export type VersionSwitchContentContext = {
  minecraftVersion: string;
  loaders: readonly string[];
  runtimeName: string;
  versionMatches: (gameVersions: string[], minecraftVersion: string) => boolean;
  iconUrl: (url?: string | null) => string | undefined;
};

const maxDependencyPasses = 8;

function enabledAfter(entry: VersionSwitchContentEntry) {
  return entry.action === "keep" || entry.action === "install" || (entry.action === "update" && entry.enabled);
}

function requiredProjectIds(version: ModrinthVersion | undefined) {
  return (version?.dependencies ?? [])
    .filter((dependency) => (dependency.dependency_type || "required") === "required" && dependency.project_id)
    .map((dependency) => dependency.project_id as string);
}

export function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** The fields every plan entry copies from the installed jar. */
export function versionSwitchBaseEntry(item: VersionSwitchInstalledContent) {
  return {
    filename: item.filename,
    displayName: item.filename.replace(/\.jar(?:\.disabled)?$/i, ""),
    iconUrl: item.iconUrl,
    projectId: item.metadata?.projectId,
    enabled: item.enabled,
    currentVersion: item.metadata?.versionNumber
  };
}

export async function planVersionSwitchContent(
  installed: readonly VersionSwitchInstalledContent[],
  context: VersionSwitchContentContext,
  lookups: VersionSwitchLookups
): Promise<VersionSwitchContentEntry[]> {
  const target = `Minecraft ${context.minecraftVersion}`;
  const loaderSet = new Set(context.loaders);
  const entries: VersionSwitchContentEntry[] = [];
  /** The version each entry will run after the switch, for the dependency pass. */
  const resultingVersion = new Map<VersionSwitchContentEntry, ModrinthVersion | undefined>();
  const keptVersionIds: Array<[VersionSwitchContentEntry, string]> = [];

  await Promise.all(installed.map(async (item) => {
    const base = versionSwitchBaseEntry(item);
    const push = (entry: VersionSwitchContentEntry, version?: ModrinthVersion) => {
      entries.push(entry);
      resultingVersion.set(entry, version);
      return entry;
    };
    const metadata = item.metadata;
    if (!metadata) {
      push(item.enabled
        ? { ...base, action: "disable", reason: `Not identified on Modrinth, so ${target} support cannot be verified.` }
        : { ...base, action: "unchanged", reason: "Already disabled." });
      return;
    }
    const alreadySupported = metadata.loaders.some((loader) => loaderSet.has(loader))
      && context.versionMatches(metadata.gameVersions, context.minecraftVersion);
    if (alreadySupported) {
      const entry = push(item.enabled
        ? { ...base, action: "keep", targetVersion: metadata.versionNumber, reason: `The installed version already supports ${target}.` }
        : { ...base, action: "unchanged", reason: `Already disabled; the installed version supports ${target}.` });
      if (item.enabled) keptVersionIds.push([entry, metadata.versionId]);
      return;
    }
    let latest: ModrinthVersion | undefined;
    try {
      latest = await lookups.latestForTarget(metadata.projectId, item.channel);
    } catch (error) {
      push(item.enabled
        ? { ...base, action: "disable", reason: `Could not check for a ${target} version: ${errorMessage(error, "Modrinth could not be reached")}` }
        : { ...base, action: "unchanged", reason: "Already disabled." });
      return;
    }
    if (!latest) {
      push(item.enabled
        ? { ...base, action: "disable", reason: `No ${context.runtimeName} version for ${target} is published on Modrinth.` }
        : { ...base, action: "unchanged", reason: `Already disabled; no ${target} version exists.` });
      return;
    }
    push({
      ...base,
      action: "update",
      targetVersion: latest.version_number,
      targetVersionId: latest.id,
      targetFilename: modrinthJarFile(latest)?.filename,
      reason: item.enabled
        ? `Version ${latest.version_number} supports ${target}.`
        : `Version ${latest.version_number} supports ${target}; stays disabled.`
    }, latest);
  }));

  if (keptVersionIds.length) {
    let kept = new Map<string, ModrinthVersion>();
    try { kept = await lookups.versions(keptVersionIds.map(([, id]) => id)); } catch { /* dependencies unknown: left as they are */ }
    for (const [entry, versionId] of keptVersionIds) resultingVersion.set(entry, kept.get(versionId));
  }

  // Required dependencies: a kept or updated mod may need a project that is being disabled, or a
  // new version may require one that is not installed. Disabling cascades, so repeat until stable.
  const installs = new Map<string, VersionSwitchContentEntry>();
  const unavailable = new Set<string>();
  /** Disabled because of a dependency: which project, and whether it is installed. */
  const blockedBy = new Map<VersionSwitchContentEntry, { projectId: string; installed?: VersionSwitchContentEntry }>();
  const addInstall = async (projectId: string) => {
    if (installs.has(projectId)) return true;
    if (unavailable.has(projectId)) return false;
    let dependency: ModrinthVersion | undefined;
    try { dependency = await lookups.latestForTarget(projectId, "release"); } catch { dependency = undefined; }
    const file = modrinthJarFile(dependency);
    if (!dependency || !file) {
      unavailable.add(projectId);
      return false;
    }
    const install: VersionSwitchContentEntry = {
      filename: file.filename,
      displayName: projectId,
      projectId,
      enabled: true,
      action: "install",
      targetVersion: dependency.version_number,
      targetVersionId: dependency.id,
      targetFilename: file.filename,
      reason: `Newly required for ${target}.`,
      requiredBy: []
    };
    entries.push(install);
    installs.set(projectId, install);
    resultingVersion.set(install, dependency);
    return true;
  };
  for (let pass = 0; pass < maxDependencyPasses; pass += 1) {
    let changed = false;
    const enabledProjects = new Set(entries.filter(enabledAfter).flatMap((entry) => entry.projectId ? [entry.projectId] : []));
    for (const entry of [...entries]) {
      if (!enabledAfter(entry)) continue;
      for (const projectId of requiredProjectIds(resultingVersion.get(entry))) {
        if (enabledProjects.has(projectId)) continue;
        const installedEntry = entries.find((candidate) => candidate.projectId === projectId && candidate.action !== "install");
        // Already disabled by its owner before the switch: the switch does not make that worse.
        if (installedEntry && !installedEntry.enabled) continue;
        if (!installedEntry && await addInstall(projectId)) {
          enabledProjects.add(projectId);
          changed = true;
          continue;
        }
        if (entry.action === "install") {
          // A new dependency that cannot be satisfied itself is not installed; whatever needed it
          // is disabled on the next pass.
          entries.splice(entries.indexOf(entry), 1);
          installs.delete(entry.projectId!);
          unavailable.add(entry.projectId!);
          enabledProjects.delete(entry.projectId!);
          changed = true;
          break;
        }
        entry.action = "disable";
        entry.targetVersion = undefined;
        entry.targetVersionId = undefined;
        entry.targetFilename = undefined;
        blockedBy.set(entry, { projectId, installed: installedEntry });
        if (entry.projectId) enabledProjects.delete(entry.projectId);
        changed = true;
        break;
      }
    }
    if (!changed) break;
  }

  // Record who needs each new dependency; drop any whose dependents all ended up disabled.
  for (const install of installs.values()) {
    install.requiredBy = entries
      .filter((entry) => enabledAfter(entry) && entry !== install && requiredProjectIds(resultingVersion.get(entry)).includes(install.projectId!))
      .map((entry) => entry.displayName);
  }
  const pruned = entries.filter((entry) => entry.action !== "install" || (entry.requiredBy?.length ?? 0) > 0);

  const projectIds = [...new Set([
    ...pruned.flatMap((entry) => entry.projectId ? [entry.projectId] : []),
    ...[...blockedBy.values()].map((blocked) => blocked.projectId)
  ])];
  let projects = new Map<string, ModrinthProject>();
  if (projectIds.length) {
    try { projects = await lookups.projects(projectIds); } catch { /* Titles and icons are cosmetic. */ }
  }
  const titleOf = (projectId: string, fallback: string) => projects.get(projectId)?.title || fallback;
  const previousNames = new Map<string, string>();
  for (const entry of pruned) {
    if (!entry.projectId) continue;
    const title = titleOf(entry.projectId, entry.displayName);
    previousNames.set(entry.displayName, title);
    entry.displayName = title;
    entry.iconUrl ??= context.iconUrl(projects.get(entry.projectId)?.icon_url);
  }
  for (const entry of pruned) {
    if (entry.requiredBy) entry.requiredBy = entry.requiredBy.map((name) => previousNames.get(name) ?? name);
    const blocked = blockedBy.get(entry);
    if (!blocked) continue;
    const name = titleOf(blocked.projectId, blocked.installed?.displayName ?? blocked.projectId);
    entry.reason = blocked.installed
      ? `Requires ${name}, which this switch disables.`
      : `Requires ${name}, which has no ${target} version.`;
  }

  return sortVersionSwitchContent(pruned);
}
