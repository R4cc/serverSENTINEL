import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { runtimeForServer, services } from "../appServices.js";
import { durationSince, errorLogFields, logError, logInfo, logOperationFailure, logWarn } from "../logging.js";
import { operationInProgress } from "../http/errors.js";
import { optionalReleaseChannel, optionalStrictBoolean, requireStrictBoolean, validateModrinthProjectId, validateModrinthVersionId } from "../http/validation.js";
import { ensureInsideServer, ensureWritableInsideServer, openContainedReadStream, safeInstalledModFilename, safeModFilename, validateExistingInsideServer, validateExistingResolvedInsideServer } from "../core.js";
import { asObject, optionalString, requiredString } from "../storage/valueValidation.js";
import { ModHashCache } from "../modHashCache.js";
import { normalizeInstalledModMetadata } from "../installedModMetadata.js";
import { findCachedIconFile } from "../iconFileCache.js";
import { diffModSnapshots, snapshotMods } from "../modRestartState.js";
import { modrinthFetch } from "../modrinth/modrinthClient.js";

import { assessRequiredModDependencies } from "../modrinth/dependencyHealth.js";
import { createModUpdatePlan, type ModUpdatePlan } from "../modrinth/updatePlan.js";
import { assertDownloadableModrinthFile, assertModrinthDownloadSize, assertModrinthJarHashes, assertVersionInstallable, compatibilityFromSelectedVersion } from "../modrinth/installPolicy.js";
import { allowedForChannel, fetchProject, fetchProjects, fetchProjectVersions, fetchVersions, latestCompatibleProjectVersion, minecraftVersionFacetValues, minecraftVersionsInclude, modrinthJarFile, modrinthServerSideSupported, modrinthVersionIsNewer, normalizeReleaseChannel, resolveSelectedProjectVersion, versionChannel } from "../modrinth/compatibility.js";
import { deleteModIcon, ensureModrinthIconForFile, iconContentType, isMissingPathError, modIconKey, modrinthIconProxyUrl, saveModIcon } from "./icons.js";
import { activeModMutations, assertJarBuffer, modFileSizeLimit, sizeLimitTransform, uploadManagedContentBuffer, verifyDownloadedJar, withModMutationLock } from "./managedContent.js";
import { managedContentRuntime } from "../servers/versions.js";

import { blockingRuntimeOperations } from "../servers/lifecycle.js";
import { toPublicPath } from "../files/fileService.js";
import { serverLogFields } from "../runtime/local/dockerContainers.js";
import { writeRuntimeUpload } from "../runtime/local/fileService.js";
import { localNodeId, findServerNode, readNodes } from "../nodes/nodeService.js";
import { nodeAdvertisesCapability } from "../nodes/protocol.js";
import { RemoteNodeRuntime } from "../nodes/remoteNodeRuntime.js";
import { runtimeTarget } from "../runtime/profile.js";
import type { RuntimeUploadSource } from "../nodes/types.js";
import type { InstalledModMetadata, ManagedServer, ModCompatibility, ModPreference, ModrinthInstallVersionStatus, ModrinthProject, ModrinthVersion, ReleaseChannel } from "../types.js";
export function modrinthSearchFacets(loaders: string | readonly string[], minecraftVersion: string, compatibilityFilter: "compatible" | "incompatible" | "all", projectType: "mod" | "plugin" = "mod") {
  const compatibleLoaders = typeof loaders === "string" ? [loaders] : Array.from(loaders);
  const facets: string[][] = [[`project_type:${projectType}`]];
  if (compatibilityFilter !== "all" && compatibilityFilter !== "incompatible") {
    facets.push(compatibleLoaders.map((loader) => `categories:${loader}`));
    facets.push(minecraftVersionFacetValues(minecraftVersion).map((value) => `versions:${value}`));
    facets.push(["server_side:required", "server_side:optional"]);
  }
  return facets;
}
const remoteModListRequests = new Map<string, Promise<unknown>>();
const remoteHashBatchRequests = new Map<string, Promise<Map<string, ModrinthVersion>>>();
const localModHashCache = new ModHashCache();

export async function modrinthApiKey() {
  return services.settingsRepository.get().modrinthApiKey || process.env.MODRINTH_API_KEY || "";
}

async function readModPreferences(server: ManagedServer): Promise<Record<string, ModPreference>> {
  return normalizeModPreferences(services.modPreferencesRepository.list(server.id));
}

async function writeModPreferences(server: ManagedServer, data: Record<string, ModPreference>) {
  services.modPreferencesRepository.replaceAll(server.id, normalizeModPreferences(data));
}

function normalizeModPreferences(value: unknown): Record<string, ModPreference> {
  const raw = asObject(value, "mod preferences");
  const normalized: Record<string, ModPreference> = {};
  for (const [filename, preference] of Object.entries(raw)) {
    const safeFilename = safeInstalledModFilename(filename);
    const item = asObject(preference, `mod preferences.${filename}`);
    normalized[safeFilename] = {
      channel: normalizeReleaseChannel(optionalString(item.channel, `mod preferences.${filename}.channel`)),
      modrinth: item.modrinth === undefined ? undefined : normalizeInstalledModMetadata(item.modrinth)
    };
  }
  return normalized;
}

function installedModCompatibility(server: ManagedServer, metadata?: InstalledModMetadata): ModCompatibility {
  const content = managedContentRuntime(server);
  if (!metadata) {
    return { status: "unknown", compatible: false, reason: "Server-side support unknown" };
  }
  const target = runtimeTarget(server);
  const serverSide = metadata.serverSide;
  const clientSide = metadata.clientSide;

  if (serverSide === "unsupported") {
    return {
      status: "incompatible",
      compatible: false,
      reason: metadata.installedWithForceIncompatible
        ? (metadata.incompatibilityReason ? `This ${content.singular} was force installed: ${metadata.incompatibilityReason}` : `Client-only ${content.singular}; server-side support is unsupported`)
        : `Client-only ${content.singular}; server-side support is unsupported`,
      serverSide,
      clientSide
    };
  }
  if (serverSide === "unknown") {
    return {
      status: "unknown",
      compatible: false,
      reason: metadata.installedWithForceIncompatible
        ? (metadata.incompatibilityReason ? `This ${content.singular} was force installed: ${metadata.incompatibilityReason}` : "Server-side support could not be verified")
        : "Server-side support could not be verified",
      serverSide,
      clientSide
    };
  }
  if (!metadata.loaders.some((loader) => content.loaders.includes(loader))) {
    return {
      status: content.definition.type === "fabric" ? "no_fabric" : "no_compatible_loader",
      compatible: false,
      reason: `This ${content.singular} does not advertise ${content.definition.displayName} compatibility.`,
      serverSide,
      clientSide
    };
  }
  if (target.minecraftVersion && !minecraftVersionsInclude(metadata.gameVersions, target.minecraftVersion)) {
    return {
      status: "no_minecraft_version",
      compatible: false,
      reason: `This ${content.singular} was installed for Minecraft ${metadata.gameVersions.join(", ") || "unknown"}, but this server is ${target.minecraftVersion}.`,
      serverSide,
      clientSide
    };
  }
  if (metadata.installedWithForceIncompatible) {
    return {
      status: "incompatible",
      compatible: false,
      reason: metadata.incompatibilityReason
        ? `This ${content.singular} was force installed: ${metadata.incompatibilityReason}`
        : `This ${content.singular} was force installed even though serverSENTINEL could not confirm compatibility.`,
      serverSide,
      clientSide
    };
  }
  return { status: "compatible", compatible: true, reason: "Compatibility verified for this server.", serverSide, clientSide };
}

function installedModReviewCanBeAcknowledged(server: ManagedServer, metadata?: InstalledModMetadata) {
  if (!metadata) return false;
  if (metadata.reviewAcknowledgedVersionId === metadata.versionId) return false;
  if (metadata.installedWithForceIncompatible || metadata.forceIncompatible || metadata.overrideMinecraftVersion || metadata.incompatibilityReason || metadata.overrideReason) return false;
  const target = runtimeTarget(server);
  if (!metadata.loaders.some((loader) => managedContentRuntime(server).loaders.includes(loader))) return false;
  if (target.minecraftVersion && !minecraftVersionsInclude(metadata.gameVersions, target.minecraftVersion)) return false;
  const compatibility = installedModCompatibility(server, metadata);
  return compatibility.status === "unknown"
    || compatibility.serverSide === "unknown"
    || compatibility.reason === "Server-side support unknown"
    || compatibility.reason === "Server-side support could not be verified";
}

type InstalledModUpdateCurrent = {
  project_id?: string;
  id?: string;
  version_id?: string;
  version_number?: string;
  version_type?: string;
};

type InstalledModUpdateInfo = {
  projectId: string;
  currentVersion?: string;
  currentChannel: ReleaseChannel;
  latestVersion?: string;
  latestVersionId?: string;
  latestFilename?: string;
  latestChannel?: ReleaseChannel;
  upToDate: boolean;
};

async function lookupModrinthUpdateForCurrent(server: ManagedServer, current: InstalledModUpdateCurrent | undefined, preferredChannel: ReleaseChannel, options: { forceRefresh?: boolean } = {}) {
  const targetRuntime = runtimeTarget(server);
  const content = managedContentRuntime(server);
  if (!targetRuntime.minecraftVersion) return null;
  if (!current?.project_id) return null;
  const versionFilter = {
    loaders: content.loaders,
    runtimeName: content.definition.displayName,
    contentKind: content.singular,
    minecraftVersion: targetRuntime.minecraftVersion
  };
  const versions = await fetchProjectVersions(current.project_id, versionFilter, options);
  let target = latestCompatibleProjectVersion(versions, { ...versionFilter, channel: preferredChannel });
  if (!target) {
    target = latestCompatibleProjectVersion(await fetchProjectVersions(current.project_id, undefined, options), { ...versionFilter, channel: preferredChannel });
  }
  const currentVersionId = current.version_id ?? current.id;
  let currentVersion: ModrinthVersion | undefined;
  if (currentVersionId) {
    currentVersion = await resolveSelectedProjectVersion({
      projectId: current.project_id,
      versionId: currentVersionId,
      versions
    }).catch(() => undefined);
  }
  if (currentVersion
    && allowedForChannel(currentVersion, preferredChannel)
    && currentVersion.loaders.some((loader) => content.loaders.includes(loader))
    && minecraftVersionsInclude(currentVersion.game_versions, versionFilter.minecraftVersion)
    && modrinthJarFile(currentVersion)
    && modrinthVersionIsNewer(currentVersion, target)
  ) {
    target = currentVersion;
  }
  const currentMatchesTarget = Boolean(target && (
    current.version_id
      ? current.version_id === target.id
      : current.version_number === target.version_number
  ));
  return {
    projectId: current.project_id,
    currentVersion: current.version_number,
    currentChannel: versionChannel(current.version_type),
    latestVersion: target?.version_number,
    latestVersionId: target?.id,
    latestFilename: modrinthJarFile(target)?.filename,
    latestChannel: target ? versionChannel(target.version_type) : undefined,
    upToDate: Boolean(target && currentMatchesTarget)
  } satisfies InstalledModUpdateInfo;
}

async function lookupModrinthUpdateFromMetadata(server: ManagedServer, metadata: InstalledModMetadata, preferredChannel: ReleaseChannel, options: { forceRefresh?: boolean } = {}) {
  return lookupModrinthUpdateForCurrent(server, {
    project_id: metadata.projectId,
    version_id: metadata.versionId,
    version_number: metadata.versionNumber,
    version_type: metadata.versionType
  }, preferredChannel, options);
}

async function lookupModrinthUpdate(server: ManagedServer, modPath: string, preferredChannel: ReleaseChannel, metadata?: InstalledModMetadata, options: { forceRefresh?: boolean } = {}) {
  if (metadata?.projectId) {
    return lookupModrinthUpdateFromMetadata(server, metadata, preferredChannel, options);
  }
  const hash = createHash("sha1").update(await readFile(modPath)).digest("hex");
  const currentRes = await modrinthFetch(`https://api.modrinth.com/v2/version_file/${hash}?algorithm=sha1`);
  const current = await currentRes.json() as InstalledModUpdateCurrent;
  return lookupModrinthUpdateForCurrent(server, {
    project_id: current.project_id,
    version_id: current.version_id ?? current.id,
    version_number: current.version_number,
    version_type: current.version_type
  }, preferredChannel, options);
}

export function remoteModMetadata(value: unknown): InstalledModMetadata | null {
  if (!value || typeof value !== "object") return null;
  const metadata = value as Partial<InstalledModMetadata>;
  if (!metadata.projectId || !metadata.versionId || !metadata.versionNumber) return null;
  return {
    projectId: metadata.projectId,
    versionId: metadata.versionId,
    filename: metadata.filename ? safeInstalledModFilename(metadata.filename) : "unknown.jar",
    versionNumber: metadata.versionNumber,
    versionType: metadata.versionType,
    gameVersions: Array.isArray(metadata.gameVersions) ? metadata.gameVersions.filter((item): item is string => typeof item === "string") : [],
    loaders: Array.isArray(metadata.loaders) ? metadata.loaders.filter((item): item is string => typeof item === "string") : [],
    hashes: metadata.hashes,
    installedAt: metadata.installedAt || new Date(0).toISOString(),
    installedWithForceIncompatible: metadata.installedWithForceIncompatible === true,
    incompatibilityReason: metadata.incompatibilityReason,
    overrideMinecraftVersion: metadata.overrideMinecraftVersion,
    overrideReason: metadata.overrideReason,
    clientSide: metadata.clientSide,
    serverSide: metadata.serverSide,
    iconUrl: metadata.iconUrl,
    forceIncompatible: metadata.forceIncompatible
  };
}

export function runtimeRunning(status: unknown) {
  if (!status || typeof status !== "object") return undefined;
  const docker = "docker" in status ? (status as { docker?: { running?: unknown } }).docker : status as { running?: unknown };
  return typeof docker?.running === "boolean" ? docker.running : undefined;
}

export async function withTrackedModMutation<T>(server: ManagedServer, action: () => Promise<T>) {
  return withModMutationLock(server.id, async () => {
    if (blockingRuntimeOperations(server.id).length > 0) {
      operationInProgress("A server runtime action is already running", "RUNTIME_OPERATION_IN_PROGRESS");
    }

    let baseline = server.restartRequiredModBaseline;
    if (!baseline) {
      const running = runtimeRunning(await runtimeForServer(server).serverStatus(server));
      if (running === undefined) throw new Error("Server runtime status is unavailable; retry the mod change when the runtime reconnects");
      if (running) {
        if (server.nodeId !== localNodeId) {
          const node = findServerNode(server, await readNodes());
          const liveMutationCapability = runtimeTarget(server).runtimeType === "fabric" ? "mods.liveMutation" : "content.liveMutation";
          if (!node || !nodeAdvertisesCapability(node, liveMutationCapability)) {
            const nodeName = node?.name || server.nodeId;
            const plural = managedContentRuntime(server).plural;
            throw new Error(`Node ${nodeName} must be updated and restarted before ${plural} can be changed while the server is running. Update the node agent, or stop the Minecraft server before changing ${plural}.`);
          }
        }
        baseline = snapshotMods(await listModsWithPanelMetadata(server));
        services.serversRepository.beginModRestartTracking(server.id, baseline);
      }
    }

    let result!: T;
    let actionError: unknown;
    try {
      result = await action();
    } catch (error) {
      actionError = error;
    }

    let reconciliationError: unknown;
    if (baseline) {
      try {
        const current = snapshotMods(await listModsWithPanelMetadata(server));
        services.serversRepository.updateModRestartChanges(server.id, diffModSnapshots(baseline, current));
      } catch (error) {
        reconciliationError = error;
      }
    }

    if (actionError) throw actionError;
    if (reconciliationError) throw reconciliationError;
    return result;
  });
}

export function requireNoActiveModMutation(serverId: string) {
  if (activeModMutations.has(serverId)) operationInProgress("A mod change is already running for this server", "MOD_OPERATION_IN_PROGRESS");
}

async function enrichInstalledModUpdates(server: ManagedServer, result: unknown, options: { forceRefresh?: boolean } = {}) {
  if (!result || typeof result !== "object" || !Array.isArray((result as { mods?: unknown }).mods)) return result;
  const base = result as { mods: Array<Record<string, unknown>> };
  const mods = await Promise.all(base.mods.map(async (mod) => {
    const metadata = remoteModMetadata(mod.modrinth);
    if (!metadata) return mod;
    const preferredChannel = normalizeReleaseChannel(typeof mod.preferredChannel === "string" ? mod.preferredChannel : undefined);
    try {
      const versionInfo = await lookupModrinthUpdateFromMetadata(server, metadata, preferredChannel, options);
      return versionInfo ? { ...mod, versionInfo } : mod;
    } catch {
      return mod;
    }
  }));
  return { ...base, mods };
}

export async function batchVersionsFromSha1(hashes: string[]) {
  const requestKey = [...hashes].sort().join(",");
  const pending = remoteHashBatchRequests.get(requestKey);
  if (pending) return pending;
  const request = loadBatchVersionsFromSha1(hashes).finally(() => remoteHashBatchRequests.delete(requestKey));
  remoteHashBatchRequests.set(requestKey, request);
  return request;
}

async function loadBatchVersionsFromSha1(hashes: string[]) {
  const resolved = new Map<string, ModrinthVersion>();
  for (let index = 0; index < hashes.length; index += 100) {
    const chunk = hashes.slice(index, index + 100);
    const response = await modrinthFetch("https://api.modrinth.com/v2/version_files", {
      method: "POST",
      json: { hashes: chunk, algorithm: "sha1" }
    });
    const body = await response.json() as Record<string, ModrinthVersion>;
    for (const [hash, version] of Object.entries(body)) resolved.set(hash, version);
  }
  return resolved;
}

async function reconcileRemoteInstalledMods(server: ManagedServer, result: unknown, options: { forceRefresh?: boolean } = {}) {
  if (!result || typeof result !== "object" || !Array.isArray((result as { mods?: unknown }).mods)) return result;
  const base = result as { mods: Array<Record<string, unknown>> };
  const prefs = await readModPreferences(server);
  const hashes = Array.from(new Set(base.mods.map((mod) => typeof mod.sha1 === "string" ? mod.sha1 : undefined).filter((hash): hash is string => Boolean(hash))));
  let versions = new Map<string, ModrinthVersion>();
  let projects = new Map<string, ModrinthProject>();
  if (options.forceRefresh) {
    try {
      versions = await batchVersionsFromSha1(hashes);
      const projectIds = Array.from(new Set(Array.from(versions.values()).map((version) => version.project_id).filter((projectId): projectId is string => Boolean(projectId))));
      projects = await fetchProjects(projectIds);
    } catch (error) {
      logWarn({ ...serverLogFields(server), hashCount: hashes.length, action: "remote_mod_metadata_reconcile", ...errorLogFields(error) }, "Remote mod metadata refresh failed; retaining last-known metadata");
    }
  } else {
    const missingIconProjectIds = Array.from(new Set(base.mods.map((mod) => {
      const filename = typeof mod.filename === "string" ? mod.filename : "";
      const metadata = remoteModMetadata(mod.modrinth) ?? prefs[filename]?.modrinth;
      return metadata && !metadata.iconUrl ? metadata.projectId : undefined;
    }).filter((projectId): projectId is string => Boolean(projectId))));
    if (missingIconProjectIds.length) {
      try {
        projects = await fetchProjects(missingIconProjectIds);
      } catch (error) {
        logWarn({ ...serverLogFields(server), projectCount: missingIconProjectIds.length, action: "remote_mod_icon_reconcile", ...errorLogFields(error) }, "Remote mod icon metadata refresh failed; retaining last-known metadata");
      }
    }
  }

  let prefsModified = false;
  const mods = await Promise.all(base.mods.map(async (mod) => {
    const filename = typeof mod.filename === "string" ? mod.filename : "";
    const sha1 = typeof mod.sha1 === "string" ? mod.sha1 : "";
    const existingPreference = prefs[filename];
    const incomingMetadata = remoteModMetadata(mod.modrinth) ?? undefined;
    const existingMetadata = incomingMetadata ?? existingPreference?.modrinth;
    const version = versions.get(sha1);
    const projectId = version?.project_id ?? existingMetadata?.projectId;
    const project = projectId ? projects.get(projectId) : undefined;
    let metadata = existingMetadata;
    if (version?.project_id) {
      const primaryFile = version.files?.find((file) => file.hashes?.sha1 === sha1 || file.primary);
      metadata = {
        ...existingMetadata,
        projectId: version.project_id,
        versionId: version.id,
        filename,
        versionNumber: version.version_number,
        versionType: versionChannel(version.version_type),
        gameVersions: version.game_versions ?? [],
        loaders: version.loaders ?? [],
        hashes: primaryFile?.hashes ?? { sha1 },
        installedAt: existingMetadata?.installedAt ?? new Date().toISOString(),
        installedWithForceIncompatible: existingMetadata?.installedWithForceIncompatible ?? false,
        clientSide: project?.client_side ?? existingMetadata?.clientSide,
        serverSide: project?.server_side ?? existingMetadata?.serverSide,
        iconUrl: project?.icon_url
          ? modrinthIconProxyUrl(project.icon_url)
          : existingMetadata?.iconUrl ?? (typeof mod.iconUrl === "string" ? modrinthIconProxyUrl(mod.iconUrl) : undefined)
      };
    }
    if (metadata && !metadata.iconUrl && project?.icon_url) {
      metadata = { ...metadata, iconUrl: modrinthIconProxyUrl(project.icon_url) };
    }
    if (metadata) {
      const nextPreference = { channel: normalizeReleaseChannel(existingPreference?.channel), modrinth: metadata };
      if (JSON.stringify(existingPreference) !== JSON.stringify(nextPreference)) {
        prefs[filename] = nextPreference;
        prefsModified = true;
      }
    }
    if (!metadata) return mod;
    const preferredChannel = normalizeReleaseChannel(existingPreference?.channel);
    let versionInfo = mod.versionInfo;
    if (options.forceRefresh) {
      try { versionInfo = await lookupModrinthUpdateFromMetadata(server, metadata, preferredChannel, options); } catch { /* retain existing */ }
    }
    return {
      ...mod,
      iconUrl: metadata.iconUrl ?? mod.iconUrl,
      preferredChannel,
      compatibility: installedModCompatibility(server, metadata),
      modrinth: metadata,
      versionInfo
    };
  }));
  if (prefsModified) await writeModPreferences(server, prefs);
  return { ...base, mods };
}

export async function enrichInstalledModDependencies(result: unknown, options: { fetchMetadata?: boolean } = { fetchMetadata: true }) {
  if (!result || typeof result !== "object" || !Array.isArray((result as { mods?: unknown }).mods)) return result;
  const base = result as { mods: Array<Record<string, unknown>> };
  const installed = base.mods.map((mod) => ({ mod, metadata: remoteModMetadata(mod.modrinth) }));
  const installedIdentities = installed.map(({ mod, metadata }) => ({ projectId: metadata?.projectId, versionId: metadata?.versionId, enabled: mod.enabled !== false }));
  const versionIds = installed.map(({ metadata }) => metadata?.versionId).filter((id): id is string => Boolean(id));
  let versions = new Map<string, ModrinthVersion>();
  try {
    versions = await fetchVersions(versionIds, { cacheOnly: options.fetchMetadata === false });
  } catch {
    // Dependency health is supplemental; an unavailable Modrinth API must not block the installed-mod list.
  }
  const resolved = installed.map(({ metadata }) => {
    if (!metadata) return null;
    const version = versions.get(metadata.versionId);
    if (!version || (version.project_id && version.project_id !== metadata.projectId)) return undefined;
    return (version.dependencies ?? []).filter((dependency) => (dependency.dependency_type || "required") === "required");
  });
  const projectIds = Array.from(new Set(resolved.flatMap((dependencies) => dependencies ?? []).map((dependency) => dependency.project_id).filter((id): id is string => Boolean(id))));
  let projects = new Map<string, ModrinthProject>();
  if (options.fetchMetadata !== false) {
    try {
      projects = await fetchProjects(projectIds);
    } catch {
      // Project names and icons are optional; dependency identifiers remain actionable.
    }
  }
  return {
    ...base,
    mods: base.mods.map((mod, index) => {
      const dependencies = resolved[index];
      if (dependencies === null) return mod;
      if (dependencies === undefined) {
        return { ...mod, dependencyHealth: { status: "unknown", requiredCount: 0, missing: [] } };
      }
      const assessment = assessRequiredModDependencies(dependencies, installedIdentities);
      const missing = assessment.missing.map((dependency) => {
        const project = dependency.projectId ? projects.get(dependency.projectId) : undefined;
        return { ...dependency, title: project?.title, iconUrl: modrinthIconProxyUrl(project?.icon_url) };
      });
      return {
        ...mod,
        dependencyHealth: {
          status: assessment.status,
          requiredCount: assessment.requiredCount,
          missing
        }
      };
    })
  };
}

export async function listModsWithPanelMetadata(server: ManagedServer, options: { forceRefresh?: boolean } = {}) {
  const runtime = runtimeForServer(server);
  if (runtime instanceof RemoteNodeRuntime) {
    const requestKey = `${server.id}|${options.forceRefresh === true}`;
    const pending = remoteModListRequests.get(requestKey);
    if (pending) return pending;
    const request = runtime.listMods(server, options)
      .then((result) => reconcileRemoteInstalledMods(server, result, options))
      .finally(() => remoteModListRequests.delete(requestKey));
    remoteModListRequests.set(requestKey, request);
    return request;
  }
  const result = await runtime.listMods(server, options);
  return options.forceRefresh ? enrichInstalledModUpdates(server, result, options) : result;
}

export async function localListMods(server: ManagedServer, options: { forceRefresh?: boolean } = {}) {
  const { directory } = managedContentRuntime(server);
  await mkdir(ensureInsideServer(server, directory), { recursive: true });
  const modsDir = await validateExistingInsideServer(server, directory);
  const entries = await readdir(modsDir, { withFileTypes: true });
  const prefs = await readModPreferences(server);
  let prefsModified = false;

  const mods = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && (entry.name.endsWith(".jar") || entry.name.endsWith(".jar.disabled")))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(async (entry) => {
        const modPath = await validateExistingResolvedInsideServer(server, join(modsDir, entry.name));
        const modStat = await stat(modPath);
        const sha1 = await localModHashCache.sha1(`${server.id}:${entry.name}`, modStat.size, modStat.mtimeMs, () => readFile(modPath));
        const preferredChannel = normalizeReleaseChannel(prefs[entry.name]?.channel);
        let metadata = prefs[entry.name]?.modrinth;

        if (!metadata && options.forceRefresh) {
          try {
            const currentRes = await modrinthFetch(`https://api.modrinth.com/v2/version_file/${sha1}?algorithm=sha1`);
            if (currentRes.ok) {
              const current = await currentRes.json() as any;
              if (current && current.project_id) {
                const project = await fetchProject(current.project_id);
                metadata = {
                  projectId: current.project_id,
                  versionId: current.id,
                  filename: entry.name,
                  versionNumber: current.version_number,
                  versionType: normalizeReleaseChannel(current.version_type),
                  gameVersions: current.game_versions,
                  loaders: current.loaders,
                  hashes: current.files?.find((f: any) => f.hashes?.sha1 === sha1 || f.primary)?.hashes || { sha1 },
                  installedAt: new Date().toISOString(),
                  installedWithForceIncompatible: false,
                  clientSide: project.client_side,
                  serverSide: project.server_side
                };
                prefs[entry.name] = {
                  ...(prefs[entry.name] || {}),
                  channel: preferredChannel,
                  modrinth: metadata
                };
                prefsModified = true;
              }
            }
          } catch {
            // Ignore backfill failures
          }
        }

        const iconUrl = await ensureModrinthIconForFile(server, entry.name, modPath, metadata);
        let versionInfo: any = null;
        if (options.forceRefresh) {
          try { versionInfo = await lookupModrinthUpdate(server, modPath, preferredChannel, metadata, options); } catch { versionInfo = null; }
        }
        return {
          filename: entry.name,
          displayName: entry.name.replace(/\.jar\.disabled$/, ".jar"),
          enabled: entry.name.endsWith(".jar"),
          size: modStat.size,
          modifiedAt: modStat.mtime.toISOString(),
          sha1,
          iconUrl: iconUrl ?? metadata?.iconUrl,
          preferredChannel,
          compatibility: installedModCompatibility(server, metadata),
          modrinth: metadata,
          versionInfo
        };
      })
  );

  if (prefsModified) {
    await writeModPreferences(server, prefs);
  }

  return { mods };
}

export async function localModIcon(server: ManagedServer, filenameInput: unknown) {
  const { directory } = managedContentRuntime(server);
  const filename = safeInstalledModFilename(filenameInput as string | undefined);
  let iconsDir: string;
  try {
    iconsDir = await validateExistingInsideServer(server, `${directory}/.serversentinel-icons`);
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    return null;
  }
  const icon = existsSync(iconsDir) ? await findCachedIconFile(iconsDir, modIconKey(filename)) : null;
  if (!icon) return null;
  const iconPath = await validateExistingResolvedInsideServer(server, icon.path);
  // Opened without following a final-component symlink: the cache entry lives inside the server root,
  // which the workload can write, so the pathname may point somewhere else by the time it is opened.
  const { stream } = await openContainedReadStream(iconPath);
  return { contentType: iconContentType(icon.filename), stream };
}

export async function localToggleMod(server: ManagedServer, filenameInput: unknown, enabledInput: unknown) {
  const { directory, singular } = managedContentRuntime(server);
  const filename = safeInstalledModFilename(filenameInput as string | undefined);
  const enabled = requireStrictBoolean(enabledInput, "enabled");
  const sourceName = filename.endsWith(".jar") && !existsSync(ensureInsideServer(server, join(directory, filename)))
    ? `${filename}.disabled`
    : filename;
  const source = await validateExistingInsideServer(server, join(directory, sourceName));
  const targetName = enabled
    ? sourceName.replace(/\.jar\.disabled$/, ".jar")
    : sourceName.endsWith(".jar.disabled")
      ? sourceName
      : `${sourceName}.disabled`;
  if (sourceName === targetName) {
    return { ok: true, filename: targetName, enabled };
  }
  const target = await ensureWritableInsideServer(server, join(directory, safeInstalledModFilename(targetName)));
  await rename(source, target);
  const prefs = await readModPreferences(server);
  if (prefs[sourceName]) {
    prefs[targetName] = {
      ...prefs[sourceName],
      modrinth: prefs[sourceName].modrinth ? { ...prefs[sourceName].modrinth, filename: targetName } : undefined
    };
    delete prefs[sourceName];
    await writeModPreferences(server, prefs);
  }
  logInfo({ ...serverLogFields(server), filename: basename(target), enabled, action: "toggle_mod" }, `${singular === "plugin" ? "Plugin" : "Mod"} state changed`);
  return { ok: true, filename: basename(target), enabled };
}

export async function localRemoveMod(server: ManagedServer, filenameInput: unknown) {
  const { directory, singular } = managedContentRuntime(server);
  const filename = safeInstalledModFilename(filenameInput as string | undefined);
  const target = await validateExistingInsideServer(server, join(directory, filename));
  await rm(target, { force: true });
  await deleteModIcon(server, filename);
  const prefs = await readModPreferences(server);
  if (prefs[filename]) {
    delete prefs[filename];
    await writeModPreferences(server, prefs);
  }
  logInfo({ ...serverLogFields(server), filename, action: "remove_mod" }, `${singular === "plugin" ? "Plugin" : "Mod"} removed`);
  return { ok: true, filename };
}

export async function localUploadMod(server: ManagedServer, filenameInput: unknown, content: RuntimeUploadSource) {
  const { directory, singular } = managedContentRuntime(server);
  const startedAt = Date.now();
  let filename: string | undefined;
  try {
    filename = safeModFilename(safeInstalledModFilename(filenameInput as string | undefined));
    logInfo({ ...serverLogFields(server), filename, action: "upload_mod" }, `Manual ${singular} upload started`);
    await mkdir(ensureInsideServer(server, directory), { recursive: true });
    await validateExistingInsideServer(server, directory);
    const destination = await ensureWritableInsideServer(server, join(directory, filename));
    if (existsSync(destination)) {
      throw new Error(`A ${singular} with that filename already exists`);
    }
    const size = await writeRuntimeUpload(destination, content, {
      maximumBytes: modFileSizeLimit,
      allowEmpty: false,
      label: `Uploaded ${singular}`,
      validateTemporary: async (temporary) => {
        const headerHandle = await open(temporary, "r");
        try {
          const header = Buffer.alloc(4);
          const { bytesRead } = await headerHandle.read(header, 0, 4, 0);
          assertJarBuffer(header.subarray(0, bytesRead));
        } finally {
          await headerHandle.close();
        }
      }
    });
    await deleteModIcon(server, filename);
    const prefs = await readModPreferences(server);
    if (prefs[filename]?.modrinth) {
      prefs[filename] = { channel: normalizeReleaseChannel(prefs[filename].channel) };
      await writeModPreferences(server, prefs);
    }
    logInfo({ ...serverLogFields(server), filename: basename(destination), size, durationMs: durationSince(startedAt), action: "upload_mod", status: "succeeded" }, `Manual ${singular} upload succeeded`);
    return { ok: true, filename: basename(destination), path: toPublicPath(server, destination) };
  } catch (error) {
    logOperationFailure({ ...serverLogFields(server), filename, durationMs: durationSince(startedAt), action: "upload_mod", status: "failed" }, `Manual ${singular} upload failed`, error);
    throw error;
  }
}

export async function downloadModrinthJar(file: NonNullable<ReturnType<typeof modrinthJarFile>>) {
  if (!file.url.startsWith("https://")) {
    throw new Error("Refusing to download a non-HTTPS Modrinth JAR");
  }
  if (file.size && file.size > modFileSizeLimit) {
    throw new Error(`Modrinth JAR is larger than ${Math.floor(modFileSizeLimit / 1024 / 1024)} MiB`);
  }
  const response = await modrinthFetch(file.url);
  if (!response.ok) {
    throw new Error(`Modrinth JAR download failed: ${response.statusText}`);
  }
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > modFileSizeLimit) {
    throw new Error(`Modrinth JAR is larger than ${Math.floor(modFileSizeLimit / 1024 / 1024)} MiB`);
  }
  const content = Buffer.from(await response.arrayBuffer());
  if (!content.length || content.length > modFileSizeLimit) {
    throw new Error(`Modrinth JAR must be between 1 byte and ${Math.floor(modFileSizeLimit / 1024 / 1024)} MiB`);
  }
  assertJarBuffer(content);
  assertModrinthJarHashes(content, file);
  return content;
}

async function replaceManagedContentJar(
  server: ManagedServer,
  currentFilename: string,
  targetFilename: string,
  content: Buffer,
  enabled: boolean
) {
  const runtime = runtimeForServer(server);
  const { directory } = managedContentRuntime(server);
  const source = await runtime.resolveExistingPath(server, `${directory}/${currentFilename}`);
  const backupName = `.serversentinel-${randomUUID()}.backup`;
  const backupPath = `${directory}/${backupName}`;
  await runtime.renameFile(server, source, backupName);

  let finalFilename = targetFilename;
  try {
    await uploadManagedContentBuffer(runtime, server, targetFilename, content);
    if (!enabled) {
      const toggled = await runtime.toggleMod(server, targetFilename, false) as { filename?: string };
      finalFilename = toggled.filename || `${targetFilename}.disabled`;
    }
    const backup = await runtime.resolveExistingPath(server, backupPath);
    await runtime.deleteFile(server, backup, undefined);
    return finalFilename;
  } catch (error) {
    for (const candidate of new Set([targetFilename, `${targetFilename}.disabled`, finalFilename])) {
      try {
        const created = await runtime.resolveExistingPath(server, `${directory}/${candidate}`);
        await runtime.deleteFile(server, created, undefined);
      } catch {
        // An upload can reach disk before a remote response fails, so always try cleanup.
      }
    }
    try {
      const backup = await runtime.resolveExistingPath(server, backupPath);
      await runtime.renameFile(server, backup, currentFilename);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], `Failed to replace ${currentFilename} and restore the previous file`);
    }
    throw error;
  }
}

export function modsFromListResult(result: unknown) {
  if (!result || typeof result !== "object" || !Array.isArray((result as { mods?: unknown }).mods)) return [];
  return (result as { mods: Array<Record<string, unknown>> }).mods;
}

export async function buildModUpdatePlan(server: ManagedServer, options: { forceRefresh?: boolean; channel?: ReleaseChannel } = {}): Promise<ModUpdatePlan> {
  const listed = await listModsWithPanelMetadata(server, { forceRefresh: options.forceRefresh });
  let mods = modsFromListResult(listed);
  if (options.channel) {
    mods = await Promise.all(mods.map(async (mod) => {
      const metadata = remoteModMetadata(mod.modrinth);
      if (!metadata) return { ...mod, preferredChannel: options.channel };
      try {
        const versionInfo = await lookupModrinthUpdateFromMetadata(server, metadata, options.channel!, { forceRefresh: options.forceRefresh });
        return { ...mod, preferredChannel: options.channel, versionInfo };
      } catch {
        return { ...mod, preferredChannel: options.channel, versionInfo: null };
      }
    }));
  }
  return createModUpdatePlan(server.id, mods);
}

export async function updateModrinthMod(server: ManagedServer, input: unknown) {
  const contentDefinition = managedContentRuntime(server);
  const startedAt = Date.now();
  const body = asObject(input, "mod update request");
  const filename = safeInstalledModFilename(requiredString(body.filename, "filename"));
  const selectedChannel = optionalReleaseChannel(body.channel);
  const runtime = runtimeForServer(server);
  try {
    const listResult = await listModsWithPanelMetadata(server, { forceRefresh: true });
    const mods = modsFromListResult(listResult);
    const currentMod = mods.find((mod) => mod.filename === filename);
    const metadata = remoteModMetadata(currentMod?.modrinth);
    if (!currentMod || !metadata) {
      throw new Error(`Installed Modrinth metadata could not be found for that ${contentDefinition.singular}`);
    }

    const targetRuntime = runtimeTarget(server);
    if (!targetRuntime.minecraftVersion) {
      throw new Error(`A resolved ${contentDefinition.definition.displayName} runtime profile is required before updating ${contentDefinition.plural}`);
    }
    const versionFilter = {
      loaders: contentDefinition.loaders,
      runtimeName: contentDefinition.definition.displayName,
      contentKind: contentDefinition.singular,
      minecraftVersion: targetRuntime.minecraftVersion
    };
    const versions = await fetchProjectVersions(metadata.projectId, versionFilter, { forceRefresh: true });
    let latest = latestCompatibleProjectVersion(versions, { ...versionFilter, channel: selectedChannel });
    if (!latest) {
      latest = latestCompatibleProjectVersion(await fetchProjectVersions(metadata.projectId, undefined, { forceRefresh: true }), { ...versionFilter, channel: selectedChannel });
    }
    const file = modrinthJarFile(latest);
    if (!latest || !file) {
      throw new Error("No compatible installable update was found for that project");
    }
    if (metadata.versionId === latest.id) {
      return { ok: true, filename, version: latest.version_number, channel: versionChannel(latest.version_type), upToDate: true };
    }

    const targetFilename = safeModFilename(safeInstalledModFilename(file.filename));
    const currentEnabled = !filename.endsWith(".disabled");
    const existingTarget = mods.find((mod) => mod.filename === targetFilename || mod.filename === `${targetFilename}.disabled`);
    if (existingTarget && existingTarget.filename !== filename) {
      await runtime.removeMod(server, filename);
      logInfo({ ...serverLogFields(server), filename, targetFilename, versionId: latest.id, action: "update_mod", status: "deduplicated", durationMs: durationSince(startedAt) }, "Mod update removed older duplicate");
      return { ok: true, filename: existingTarget.filename, version: latest.version_number, channel: versionChannel(latest.version_type), replaced: filename };
    }

    const content = await downloadModrinthJar(file);
    const finalFilename = await replaceManagedContentJar(server, filename, targetFilename, content, currentEnabled);
    const prefs = await readModPreferences(server);
    delete prefs[filename];
    delete prefs[targetFilename];
    delete prefs[`${targetFilename}.disabled`];
    prefs[finalFilename] = {
      channel: selectedChannel,
      modrinth: {
        ...metadata,
        filename: finalFilename,
        versionId: latest.id,
        versionNumber: latest.version_number,
        versionType: versionChannel(latest.version_type),
        gameVersions: latest.game_versions,
        loaders: latest.loaders,
        hashes: file.hashes,
        installedAt: new Date().toISOString(),
        installedWithForceIncompatible: false,
        incompatibilityReason: undefined,
        overrideMinecraftVersion: undefined,
        overrideReason: undefined,
        forceIncompatible: false
      }
    };
    await writeModPreferences(server, prefs);

    logInfo({ ...serverLogFields(server), filename, targetFilename: finalFilename, versionId: latest.id, action: "update_mod", status: "succeeded", durationMs: durationSince(startedAt) }, `${contentDefinition.singular === "plugin" ? "Plugin" : "Mod"} update succeeded`);
    return { ok: true, filename: finalFilename, version: latest.version_number, channel: versionChannel(latest.version_type), replaced: filename };
  } catch (error) {
    logOperationFailure({ ...serverLogFields(server), filename, action: "update_mod", status: "failed", durationMs: durationSince(startedAt) }, "Mod update failed", error);
    throw error;
  }
}

export async function switchModrinthModVersion(server: ManagedServer, input: unknown) {
  const contentDefinition = managedContentRuntime(server);
  const startedAt = Date.now();
  const request = parseModrinthSwitchVersionRequest(input);
  try {
    const listResult = await listModsWithPanelMetadata(server, { forceRefresh: true });
    const mods = modsFromListResult(listResult);
    const currentMod = mods.find((mod) => mod.filename === request.filename);
    const metadata = remoteModMetadata(currentMod?.modrinth);
    if (!currentMod || !metadata) {
      throw new Error(`Installed Modrinth metadata could not be found for that ${contentDefinition.singular}`);
    }

    const targetRuntime = runtimeTarget(server);
    if (!targetRuntime.minecraftVersion) {
      throw new Error(`A resolved ${contentDefinition.definition.displayName} runtime profile is required before switching ${contentDefinition.singular} versions`);
    }

    const [project, filteredVersions] = await Promise.all([
      fetchProject(metadata.projectId),
      fetchProjectVersions(metadata.projectId, {
        loaders: contentDefinition.loaders,
        minecraftVersion: targetRuntime.minecraftVersion
      }, { forceRefresh: true })
    ]);
    const selectedVersion = await resolveSelectedProjectVersion({
      projectId: metadata.projectId,
      project,
      versionId: request.versionId,
      versions: filteredVersions
    });
    if (!allowedForChannel(selectedVersion, request.channel)) {
      throw new Error("The selected version is outside the requested release channel");
    }

    const file = modrinthJarFile(selectedVersion);
    if (!file) {
      throw new Error("No installable .jar file was found for that version");
    }
    if (!selectedVersion.loaders.some((loader) => contentDefinition.loaders.includes(loader))) {
      throw new Error(`The selected version is not compatible with ${contentDefinition.definition.displayName}`);
    }
    const projectSides = { server_side: project.server_side, client_side: project.client_side };
    const serverSide = project.server_side;
    const serverSupported = modrinthServerSideSupported(serverSide);
    if (serverSide === "unsupported") {
      throw new Error(`Client-only ${contentDefinition.plural} cannot be installed on the server`);
    }
    if (!serverSupported) {
      throw new Error("Server-side support could not be verified for that version");
    }
    const matchesMinecraft = minecraftVersionsInclude(selectedVersion.game_versions, targetRuntime.minecraftVersion);
    if (!matchesMinecraft && !request.overrideMinecraftVersion) {
      throw new Error(`This version is not marked for Minecraft ${targetRuntime.minecraftVersion}. Confirm the Minecraft version override before switching.`);
    }

    const targetFilename = safeModFilename(safeInstalledModFilename(file.filename));
    const currentEnabled = !request.filename.endsWith(".disabled");
    const existingTarget = mods.find((mod) => (
      mod.filename === targetFilename
      || mod.filename === `${targetFilename}.disabled`
    ));
    if (existingTarget && existingTarget.filename !== request.filename) {
      throw new Error(`A ${contentDefinition.singular} with that filename already exists`);
    }

    const content = await downloadModrinthJar(file);
    const finalFilename = await replaceManagedContentJar(server, request.filename, targetFilename, content, currentEnabled);

    const compatible = matchesMinecraft && serverSupported;
    const incompatibilityReason = compatible
      ? undefined
      : !matchesMinecraft
        ? `Switched with Minecraft version override. Server ${targetRuntime.minecraftVersion}; mod ${selectedVersion.game_versions.join(", ") || "unknown"}.`
        : "Switched with compatibility override";
    const compatibility = compatibilityFromSelectedVersion({
      version: selectedVersion,
      file,
      projectSides,
      compatible,
      reason: compatible ? `Compatible server-side ${contentDefinition.definition.displayName} ${contentDefinition.singular}` : incompatibilityReason ?? "Switched with compatibility override"
    });

    const prefs = await readModPreferences(server);
    delete prefs[request.filename];
    if (targetFilename !== finalFilename) delete prefs[targetFilename];
    prefs[finalFilename] = {
      channel: request.channel,
      modrinth: {
        projectId: metadata.projectId,
        versionId: selectedVersion.id,
        filename: finalFilename,
        versionNumber: selectedVersion.version_number,
        versionType: versionChannel(selectedVersion.version_type),
        gameVersions: selectedVersion.game_versions,
        loaders: selectedVersion.loaders,
        hashes: file.hashes,
        installedAt: new Date().toISOString(),
        installedWithForceIncompatible: request.forceIncompatible && !compatibility.compatible,
        incompatibilityReason,
        overrideMinecraftVersion: request.overrideMinecraftVersion && !matchesMinecraft,
        overrideReason: request.overrideMinecraftVersion && !matchesMinecraft ? incompatibilityReason : undefined,
        clientSide: project.client_side,
        serverSide: project.server_side,
        forceIncompatible: request.forceIncompatible && !compatibility.compatible
      }
    };
    await writeModPreferences(server, prefs);

    logInfo({ ...serverLogFields(server), filename: request.filename, targetFilename: finalFilename, projectId: metadata.projectId, versionId: selectedVersion.id, action: "switch_mod_version", status: "succeeded", durationMs: durationSince(startedAt) }, "Mod version switch succeeded");
    return {
      ok: true,
      filename: finalFilename,
      replaced: request.filename,
      version: selectedVersion.version_number,
      channel: versionChannel(selectedVersion.version_type),
      compatibility
    };
  } catch (error) {
    logOperationFailure({ ...serverLogFields(server), filename: request.filename, versionId: request.versionId, action: "switch_mod_version", status: "failed", durationMs: durationSince(startedAt) }, "Mod version switch failed", error);
    throw error;
  }
}

export async function acknowledgeInstalledModReview(server: ManagedServer, input: unknown) {
  const body = asObject(input, "mod review acknowledgement request");
  const filename = safeInstalledModFilename(requiredString(body.filename, "filename"));
  const listResult = await listModsWithPanelMetadata(server, { forceRefresh: true });
  const currentMod = modsFromListResult(listResult).find((mod) => mod.filename === filename);
  if (!currentMod) {
    throw new Error("Installed mod could not be found");
  }

  const prefs = await readModPreferences(server);
  const metadata = prefs[filename]?.modrinth ?? remoteModMetadata(currentMod.modrinth);
  if (!metadata) {
    throw new Error("Installed Modrinth metadata could not be found for that mod");
  }
  if (!installedModReviewCanBeAcknowledged(server, metadata)) {
    throw new Error(`Only installed Modrinth ${managedContentRuntime(server).plural} that need review can be acknowledged`);
  }

  const acknowledgedAt = new Date().toISOString();
  prefs[filename] = {
    ...(prefs[filename] || {}),
    channel: normalizeReleaseChannel(prefs[filename]?.channel),
    modrinth: {
      ...metadata,
      filename,
      reviewAcknowledgedVersionId: metadata.versionId,
      reviewAcknowledgedAt: acknowledgedAt
    }
  };
  await writeModPreferences(server, prefs);
  logInfo({ ...serverLogFields(server), filename, projectId: metadata.projectId, versionId: metadata.versionId, action: "acknowledge_mod_review", status: "succeeded" }, "Mod review acknowledged");
  return { ok: true, filename, reviewAcknowledgedVersionId: metadata.versionId, reviewAcknowledgedAt: acknowledgedAt };
}

type ModrinthInstallRequest = {
  projectId: string;
  versionId?: string;
  forceIncompatible: boolean;
  overrideMinecraftVersion: boolean;
  dependenciesOnly: boolean;
  channel: ReleaseChannel;
};

type ModrinthSwitchVersionRequest = {
  filename: string;
  versionId: string;
  forceIncompatible: boolean;
  overrideMinecraftVersion: boolean;
  channel: ReleaseChannel;
};

function parseModrinthInstallRequest(input: unknown): ModrinthInstallRequest {
  const body = asObject(input, "mod install request");
  return {
    projectId: validateModrinthProjectId(body.projectId),
    versionId: validateModrinthVersionId(body.versionId),
    forceIncompatible: optionalStrictBoolean(body.forceIncompatible, "forceIncompatible", false),
    overrideMinecraftVersion: optionalStrictBoolean(body.overrideMinecraftVersion, "overrideMinecraftVersion", false),
    dependenciesOnly: optionalStrictBoolean(body.dependenciesOnly, "dependenciesOnly", false),
    channel: optionalReleaseChannel(body.channel)
  };
}

function parseModrinthSwitchVersionRequest(input: unknown): ModrinthSwitchVersionRequest {
  const body = asObject(input, "mod version switch request");
  const versionId = validateModrinthVersionId(body.versionId);
  if (!versionId) {
    throw new Error("A valid Modrinth version id is required");
  }
  return {
    filename: safeInstalledModFilename(requiredString(body.filename, "filename")),
    versionId,
    forceIncompatible: optionalStrictBoolean(body.forceIncompatible, "forceIncompatible", false),
    overrideMinecraftVersion: optionalStrictBoolean(body.overrideMinecraftVersion, "overrideMinecraftVersion", false),
    channel: optionalReleaseChannel(body.channel)
  };
}

type PlannedModInstall = {
  projectId: string;
  project: ModrinthProject;
  version: ModrinthVersion;
  file: NonNullable<ReturnType<typeof modrinthJarFile>>;
  compatibility: ModCompatibility;
  dependencyType: "root" | "required";
};

type OptionalModDependency = {
  projectId?: string;
  versionId?: string;
  dependencyType: string;
  reason: string;
};

async function planRequiredModrinthInstalls(input: {
  rootProjectId: string;
  rootProject: ModrinthProject;
  rootVersion: ModrinthVersion;
  minecraftVersion: string;
  channel: ReleaseChannel;
  loaders: readonly string[];
  runtimeName: string;
  contentKind: "mod" | "plugin";
}) {
  const planned = new Map<string, PlannedModInstall>();
  const optionalDependencies: OptionalModDependency[] = [];
  const visiting = new Set<string>();

  const planVersion = async (
    projectId: string,
    project: ModrinthProject,
    version: ModrinthVersion,
    dependencyType: "root" | "required"
  ) => {
    const key = version.id || projectId;
    if (planned.has(key)) return;
    if (visiting.has(key)) {
      throw new Error(`Required Modrinth dependency cycle detected at ${project.title || projectId}`);
    }
    visiting.add(key);
    const file = modrinthJarFile(version);
    if (!file) {
      throw new Error(`Required dependency ${project.title || projectId} has no installable .jar file for this runtime`);
    }
    const hasCompatibleLoader = version.loaders.some((loader) => input.loaders.includes(loader));
    const matchesMinecraft = minecraftVersionsInclude(version.game_versions, input.minecraftVersion);
    if (!hasCompatibleLoader) {
      throw new Error(`Required dependency ${project.title || projectId} is not available for ${input.runtimeName}`);
    }
    if (!matchesMinecraft) {
      throw new Error(`Required dependency ${project.title || projectId} is not available for Minecraft ${input.minecraftVersion}`);
    }
    const projectSides = { server_side: project.server_side, client_side: project.client_side };
    const compatibility = compatibilityFromSelectedVersion({
      version,
      file,
      projectSides,
      compatible: true,
      reason: dependencyType === "root" ? `Compatible server-side ${input.runtimeName} ${input.contentKind}` : "Compatible required dependency"
    });

    for (const dependency of version.dependencies ?? []) {
      const type = dependency.dependency_type || "required";
      if (type !== "required") {
        optionalDependencies.push({
          projectId: dependency.project_id,
          versionId: dependency.version_id,
          dependencyType: type,
          reason: "Optional dependency was not installed automatically"
        });
        continue;
      }
      let dependencyVersion: ModrinthVersion | undefined;
      let dependencyProjectId = dependency.project_id;
      if (dependency.version_id) {
        dependencyVersion = await resolveSelectedProjectVersion({
          projectId: dependency.project_id,
          versionId: dependency.version_id
        });
        dependencyProjectId ||= dependencyVersion.project_id;
      }
      if (!dependencyProjectId) {
        throw new Error(`Required dependency for ${project.title || projectId} does not include a project id`);
      }
      const dependencyProject = await fetchProject(dependencyProjectId);
      dependencyVersion ??= (await fetchProjectVersions(dependencyProjectId, {
        loaders: input.loaders,
        minecraftVersion: input.minecraftVersion
      })).find((candidate) => allowedForChannel(candidate, input.channel) && modrinthJarFile(candidate));
      if (!dependencyVersion) {
        throw new Error(`Required dependency ${dependencyProject.title || dependencyProjectId} has no compatible ${input.runtimeName} version for Minecraft ${input.minecraftVersion}`);
      }
      await planVersion(dependencyProjectId, dependencyProject, dependencyVersion, "required");
    }

    visiting.delete(key);
    planned.set(key, {
      projectId,
      project,
      version,
      file,
      compatibility,
      dependencyType
    });
  };

  await planVersion(input.rootProjectId, input.rootProject, input.rootVersion, "root");
  return {
    installs: Array.from(planned.values()).sort((a, b) => a.dependencyType === b.dependencyType ? 0 : a.dependencyType === "required" ? -1 : 1),
    optionalDependencies
  };
}

export async function localInstallMod(server: ManagedServer, input: unknown) {
  const contentDefinition = managedContentRuntime(server);
  const startedAt = Date.now();
  const install = parseModrinthInstallRequest(input);
  const projectId = install.projectId;
  const forceIncompatible = install.forceIncompatible;
  try {
    const targetRuntime = runtimeTarget(server);
    if (!projectId || !targetRuntime.minecraftVersion) {
      throw new Error(`A resolved ${contentDefinition.definition.displayName} runtime profile is required before installing compatible ${contentDefinition.plural}`);
    }
    const minecraftVersion = targetRuntime.minecraftVersion;
    const selectedChannel = install.channel;
    logInfo({ ...serverLogFields(server), projectId, versionId: install.versionId, channel: selectedChannel, forceIncompatible, overrideMinecraftVersion: install.overrideMinecraftVersion, action: "modrinth_install" }, "Modrinth install started");

    const [project, versions] = await Promise.all([
      fetchProject(projectId),
      fetchProjectVersions(projectId, undefined, { forceRefresh: true })
    ]);
    const projectSides = { server_side: project.server_side, client_side: project.client_side };
    const selectedVersion = install.versionId
      ? await resolveSelectedProjectVersion({
        projectId,
        project,
        versionId: install.versionId,
        versions
      }).catch((error) => {
        if ((error as Error).message === "The selected Modrinth version does not belong to that project") throw error;
        return undefined;
      })
      : versions.find((version) => (
        allowedForChannel(version, selectedChannel)
        && version.loaders.some((loader) => contentDefinition.loaders.includes(loader))
        && minecraftVersionsInclude(version.game_versions, minecraftVersion)
        && modrinthJarFile(version)
        && modrinthServerSideSupported(project.server_side)
      ));
    if (!selectedVersion) {
      throw new Error(install.versionId ? "The selected Modrinth version could not be found" : "No compatible installable version was found for that project");
    }
    const candidate = assertVersionInstallable({
      version: selectedVersion,
      project,
      naming: contentDefinition,
      minecraftVersion,
      channel: selectedChannel,
      forceIncompatible,
      overrideMinecraftVersion: install.overrideMinecraftVersion,
      requireKnownServerSide: true
    });
    const file = candidate.file;
    const compatibility = compatibilityFromSelectedVersion({
      version: selectedVersion,
      file,
      projectSides,
      compatible: candidate.compatible,
      reason: candidate.compatible
        ? `Compatible server-side ${contentDefinition.definition.displayName} ${contentDefinition.singular}`
        : candidate.incompatibilityReason ?? "Installed with compatibility override"
    });
    logInfo({ ...serverLogFields(server), projectId, versionId: compatibility.matchedVersionId, compatibility: compatibility.status, forceIncompatible, action: "modrinth_install" }, "Modrinth compatibility decision");
    if (!compatibility.compatible && !forceIncompatible) {
      logWarn({ ...serverLogFields(server), projectId, compatibility: compatibility.status, reason: compatibility.reason, action: "modrinth_install" }, "Modrinth install rejected as incompatible");
      throw new Error(`${compatibility.reason}. Set forceIncompatible to true to install anyway.`);
    }
    const installPlan = compatibility.compatible
      ? await planRequiredModrinthInstalls({
          rootProjectId: projectId,
          rootProject: project,
          rootVersion: selectedVersion,
          minecraftVersion,
          channel: selectedChannel,
          loaders: contentDefinition.loaders,
          runtimeName: contentDefinition.definition.displayName,
          contentKind: contentDefinition.singular
        })
      : {
          installs: [{
            projectId,
            project,
            version: selectedVersion,
            file,
            compatibility,
            dependencyType: "root" as const
          }],
          optionalDependencies: [] as OptionalModDependency[]
        };
    if (install.dependenciesOnly) {
      installPlan.installs = installPlan.installs.filter((planned) => planned.dependencyType === "required");
    }

    await mkdir(ensureInsideServer(server, contentDefinition.directory), { recursive: true });
    await validateExistingInsideServer(server, contentDefinition.directory);
    const installed: Array<{ projectId: string; version: string; filename: string; dependencyType: "root" | "required"; path: string }> = [];
    const previousPrefs = await readModPreferences(server);
    const prefs = { ...previousPrefs };
    const installedProjectIds = new Set(Object.values(previousPrefs).map((pref) => pref.modrinth?.projectId).filter(Boolean));
    const staged: Array<{ planned: PlannedModInstall; destination: string; temporaryDestination: string }> = [];

    try {
      for (const planned of installPlan.installs) {
      if (planned.dependencyType === "required" && installedProjectIds.has(planned.projectId)) continue;
      assertDownloadableModrinthFile(planned.file, { singular: contentDefinition.singular, maximumBytes: modFileSizeLimit });
      const destination = await ensureWritableInsideServer(server, join(contentDefinition.directory, safeModFilename(planned.file.filename)));
      if (existsSync(destination)) {
        if (planned.dependencyType === "required") continue;
        throw new Error(`A ${contentDefinition.singular} with that filename already exists`);
      }
      const temporaryDestination = `${destination}.serversentinel-${randomUUID()}.tmp`;
      const downloadResponse = await modrinthFetch(planned.file.url);
      if (!downloadResponse.ok) {
        throw new Error(`Mod download failed: ${downloadResponse.statusText}`);
      }
      if (!downloadResponse.body) {
        throw new Error("Mod download returned no body");
      }
      const contentLength = Number(downloadResponse.headers.get("content-length") ?? "0");
      if (Number.isFinite(contentLength)) {
        assertModrinthDownloadSize(contentLength, { singular: contentDefinition.singular, maximumBytes: modFileSizeLimit });
      }
      try {
        await pipeline(
          Readable.fromWeb(downloadResponse.body as unknown as NodeReadableStream<Uint8Array>),
          sizeLimitTransform(modFileSizeLimit),
          createWriteStream(temporaryDestination)
        );
        await verifyDownloadedJar(temporaryDestination, planned.file);
      } catch (error) {
        await rm(temporaryDestination, { force: true }).catch(() => {});
        throw error;
      }
      staged.push({ planned, destination, temporaryDestination });
      installedProjectIds.add(planned.projectId);
      }
    } catch (error) {
      await Promise.allSettled(staged.map((item) => rm(item.temporaryDestination, { force: true })));
      throw error;
    }

    const committed: Array<{ filename: string; destination: string; project: ModrinthProject }> = [];
    try {
      for (const { planned, destination, temporaryDestination } of staged) {
      await rename(temporaryDestination, destination);
      const filename = basename(destination);
      prefs[filename] = {
        channel: selectedChannel,
        modrinth: {
          projectId: planned.projectId,
          versionId: planned.version.id,
          filename,
          versionNumber: planned.version.version_number,
          versionType: versionChannel(planned.version.version_type),
          gameVersions: planned.version.game_versions,
          loaders: planned.version.loaders,
          hashes: planned.file.hashes,
          installedAt: new Date().toISOString(),
          installedWithForceIncompatible: planned.dependencyType === "root" && forceIncompatible && !compatibility.compatible,
          incompatibilityReason: planned.dependencyType === "root" ? candidate.incompatibilityReason : undefined,
          overrideMinecraftVersion: planned.dependencyType === "root" && install.overrideMinecraftVersion && !candidate.matchesMinecraft,
          overrideReason: planned.dependencyType === "root" && install.overrideMinecraftVersion && !candidate.matchesMinecraft ? candidate.incompatibilityReason : undefined,
          clientSide: planned.project.client_side,
          serverSide: planned.project.server_side,
          iconUrl: modrinthIconProxyUrl(planned.project.icon_url),
          forceIncompatible: planned.dependencyType === "root" && forceIncompatible && !compatibility.compatible
        }
      };
      installed.push({
        projectId: planned.projectId,
        version: planned.version.version_number,
        filename,
        dependencyType: planned.dependencyType,
        path: toPublicPath(server, destination)
      });
      committed.push({ filename, destination, project: planned.project });
      }
      await writeModPreferences(server, prefs);
    } catch (error) {
      await Promise.allSettled([
        ...staged.map((item) => rm(item.temporaryDestination, { force: true })),
        ...committed.map((item) => rm(item.destination, { force: true }))
      ]);
      await writeModPreferences(server, previousPrefs).catch(() => undefined);
      logError({ ...serverLogFields(server), projectId, rollbackFiles: committed.map((item) => item.filename), action: "modrinth_install_rollback", ...errorLogFields(error) }, "Local Modrinth install rolled back");
      throw error;
    }
    await Promise.all(committed.map((item) => saveModIcon(server, item.filename, item.project.icon_url)));

    const rootInstall = installed.find((item) => item.dependencyType === "root");
    logInfo({ ...serverLogFields(server), projectId, versionId: compatibility.matchedVersionId, filename: rootInstall?.filename, installedCount: installed.length, durationMs: durationSince(startedAt), forceIncompatible: forceIncompatible && !compatibility.compatible, action: "modrinth_install", status: "succeeded" }, "Modrinth install succeeded");
    return {
      ok: true,
      projectId,
      version: selectedVersion.version_number,
      filename: rootInstall?.filename ?? safeModFilename(file.filename),
      path: rootInstall?.path,
      channel: versionChannel(selectedVersion.version_type),
      compatibility,
      installed,
      optionalDependencies: installPlan.optionalDependencies
    };
  } catch (error) {
    logOperationFailure({ ...serverLogFields(server), projectId, durationMs: durationSince(startedAt), forceIncompatible, action: "modrinth_install", status: "failed" }, "Modrinth install failed", error);
    throw error;
  }
}

export function classifyModrinthInstallVersion(input: {
  version: ModrinthVersion;
  minecraftVersion: string;
  projectSides: { server_side?: string; client_side?: string };
  recommended: boolean;
  dependencyProjects: Map<string, ModrinthProject>;
  loaders: readonly string[];
  runtimeName: string;
  contentKind: "mod" | "plugin";
}) {
  const file = modrinthJarFile(input.version);
  const hasCompatibleLoader = input.version.loaders.some((loader) => input.loaders.includes(loader));
  const matchesMinecraft = minecraftVersionsInclude(input.version.game_versions, input.minecraftVersion);
  const serverSide = input.projectSides.server_side;
  const serverSupported = modrinthServerSideSupported(serverSide);
  const selectable = Boolean(file && hasCompatibleLoader && serverSupported);
  const compatible = selectable && matchesMinecraft;
  let status: ModrinthInstallVersionStatus = compatible ? "compatible" : "version_mismatch";
  let statusLabel = compatible ? "Compatible" : "Version mismatch";
  let reason = compatible
    ? `Compatible ${input.runtimeName} server ${input.contentKind}`
    : `Not marked for Minecraft ${input.minecraftVersion}`;

  if (!file) {
    status = "no_installable_jar";
    statusLabel = "No installable jar";
    reason = "No installable .jar file was found";
  } else if (!hasCompatibleLoader) {
    status = "wrong_loader";
    statusLabel = "Wrong loader";
    reason = `This version is not compatible with ${input.runtimeName}`;
  } else if (serverSide === "unsupported") {
    status = "client_only";
    statusLabel = "Client-only";
    reason = "Server-side support is unsupported";
  } else if (serverSide === "unknown") {
    status = "server_support_unknown";
    statusLabel = "Server support unknown";
    reason = "Server-side support could not be verified";
  } else if (input.recommended) {
    status = "recommended";
    statusLabel = "Recommended";
  }

  return {
    id: input.version.id,
    versionNumber: input.version.version_number,
    releaseChannel: versionChannel(input.version.version_type),
    publishedAt: input.version.date_published,
    minecraftVersions: input.version.game_versions,
    loaders: input.version.loaders,
    file: file ? {
      filename: file.filename,
      size: file.size
    } : undefined,
    compatible,
    selectable,
    requiresMinecraftAcknowledgement: selectable && !matchesMinecraft,
    status,
    statusLabel,
    reason,
    dependencies: (input.version.dependencies ?? []).map((dependency) => {
      const project = dependency.project_id ? input.dependencyProjects.get(dependency.project_id) : undefined;
      return {
        projectId: dependency.project_id,
        versionId: dependency.version_id,
        dependencyType: dependency.dependency_type || "required",
        title: project?.title,
        iconUrl: modrinthIconProxyUrl(project?.icon_url)
      };
    })
  };
}

export async function installModWithRemoteVersionFallback(server: ManagedServer, input: unknown) {
  const runtime = runtimeForServer(server);
  if (!(runtime instanceof RemoteNodeRuntime)) return runtime.installMod(server, input);

    const install = parseModrinthInstallRequest(input);
    if (!install.versionId) throw new Error("A valid Modrinth version id is required");
    const targetRuntime = runtimeTarget(server);
    const contentDefinition = managedContentRuntime(server);
    if (!targetRuntime.minecraftVersion) throw new Error(`A resolved ${contentDefinition.definition.displayName} runtime profile is required before installing compatible ${contentDefinition.plural}`);

    const [project, versions] = await Promise.all([
      fetchProject(install.projectId),
      fetchProjectVersions(install.projectId, {
        loaders: contentDefinition.loaders,
        minecraftVersion: targetRuntime.minecraftVersion
      }, { forceRefresh: true })
    ]);
    const selectedVersion = await resolveSelectedProjectVersion({
      projectId: install.projectId,
      project,
      versionId: install.versionId,
      versions
    });
    const selectedIsCompatible = Boolean(allowedForChannel(selectedVersion, install.channel)
      && selectedVersion.loaders.some((loader) => contentDefinition.loaders.includes(loader))
      && minecraftVersionsInclude(selectedVersion.game_versions, targetRuntime.minecraftVersion)
      && modrinthJarFile(selectedVersion)
      && modrinthServerSideSupported(project.server_side));
    if (!selectedIsCompatible && !install.forceIncompatible) throw new Error("The selected version is not compatible with this server");

    logWarn({
      ...serverLogFields(server),
      projectId: install.projectId,
      versionId: install.versionId,
      action: "modrinth_install",
      status: "panel_side_remote_install"
    }, "Installing selected Modrinth version from panel because remote node agent could not resolve it");

    const file = modrinthJarFile(selectedVersion);
    if (!file) throw new Error("No installable .jar file was found for that version");
    const projectSides = { server_side: project.server_side, client_side: project.client_side };
    const compatibility = compatibilityFromSelectedVersion({
      version: selectedVersion,
      file,
      projectSides,
      compatible: selectedIsCompatible,
      reason: selectedIsCompatible ? `Compatible server-side ${contentDefinition.definition.displayName} ${contentDefinition.singular}` : "Installed with compatibility override"
    });
    const installPlan = selectedIsCompatible ? await planRequiredModrinthInstalls({
      rootProjectId: install.projectId,
      rootProject: project,
      rootVersion: selectedVersion,
      minecraftVersion: targetRuntime.minecraftVersion,
      channel: install.channel,
      loaders: contentDefinition.loaders,
      runtimeName: contentDefinition.definition.displayName,
      contentKind: contentDefinition.singular
    }) : { installs: [{ projectId: install.projectId, project, version: selectedVersion, file, compatibility, dependencyType: "root" as const }], optionalDependencies: [] as OptionalModDependency[] };
    if (install.dependenciesOnly) {
      installPlan.installs = installPlan.installs.filter((planned) => planned.dependencyType === "required");
    }
    const listResult = await reconcileRemoteInstalledMods(server, await runtime.listMods(server, { forceRefresh: false }));
    const listedMods = modsFromListResult(listResult);
    const installedProjectIds = new Set(listedMods.map((mod) => remoteModMetadata(mod.modrinth)?.projectId).filter(Boolean));
    const installedFilenames = new Set(listedMods.map((mod) => typeof mod.filename === "string" ? mod.filename : undefined).filter(Boolean));
    const installed: Array<{ projectId: string; version: string; filename: string; dependencyType: "root" | "required"; path?: string }> = [];
    const createdFilenames: string[] = [];
    const previousPrefs = await readModPreferences(server);
    const nextPrefs = { ...previousPrefs };

    const staged: Array<{ planned: PlannedModInstall; filename: string; content: Buffer }> = [];
    for (const planned of installPlan.installs) {
      if (planned.dependencyType === "required" && installedProjectIds.has(planned.projectId)) continue;
      const filename = safeModFilename(safeInstalledModFilename(planned.file.filename));
      if (installedFilenames.has(filename) || installedFilenames.has(`${filename}.disabled`)) {
        if (planned.dependencyType === "required") continue;
        throw new Error(`A ${contentDefinition.singular} with that filename already exists`);
      }
      staged.push({ planned, filename, content: await downloadModrinthJar(planned.file) });
    }
    try {
      for (const { planned, filename, content } of staged) {
      const written = await uploadManagedContentBuffer(runtime, server, filename, content) as { path?: string };
      createdFilenames.push(filename);
      installedProjectIds.add(planned.projectId);
      installedFilenames.add(filename);
      installed.push({
        projectId: planned.projectId,
        version: planned.version.version_number,
        filename,
        dependencyType: planned.dependencyType,
        path: written.path
      });
      nextPrefs[filename] = {
        channel: install.channel,
        modrinth: {
          projectId: planned.projectId,
          versionId: planned.version.id,
          filename,
          versionNumber: planned.version.version_number,
          versionType: versionChannel(planned.version.version_type),
          gameVersions: planned.version.game_versions,
          loaders: planned.version.loaders,
          hashes: planned.file.hashes,
          installedAt: new Date().toISOString(),
          installedWithForceIncompatible: planned.dependencyType === "root" && !selectedIsCompatible,
          clientSide: planned.project.client_side,
          serverSide: planned.project.server_side,
          iconUrl: modrinthIconProxyUrl(planned.project.icon_url),
          forceIncompatible: planned.dependencyType === "root" && install.forceIncompatible && !selectedIsCompatible
        }
      };
      }
      await writeModPreferences(server, nextPrefs);
    } catch (error) {
      await Promise.allSettled(createdFilenames.map((filename) => runtime.removeMod(server, filename)));
      await writeModPreferences(server, previousPrefs).catch(() => undefined);
      logError({ ...serverLogFields(server), projectId: install.projectId, rollbackFiles: createdFilenames, action: "modrinth_install_rollback", ...errorLogFields(error) }, "Remote Modrinth install rolled back");
      throw error;
    }

    const rootInstall = installed.find((item) => item.dependencyType === "root");
    return {
      ok: true,
      projectId: install.projectId,
      version: selectedVersion.version_number,
      filename: rootInstall?.filename ?? file.filename,
      channel: versionChannel(selectedVersion.version_type),
      installed,
      optionalDependencies: installPlan.optionalDependencies,
      compatibility
    };
}
