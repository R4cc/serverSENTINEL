import { modrinthFetch } from "./modrinthClient.js";
import type { ModCompatibility, ModrinthVersion, ReleaseChannel } from "../types.js";

const channelRank: Record<ReleaseChannel, number> = { release: 0, beta: 1, alpha: 2 };

export type ModrinthJarFile = {
  url: string;
  filename: string;
  primary: boolean;
  size?: number;
  hashes?: Record<string, string>;
};

export type ModrinthCompatibilityMatch = ModCompatibility & {
  matchedVersionId?: string;
  matchedVersionNumber?: string;
  matchedVersionType?: ReleaseChannel;
  matchedLoaders?: string[];
  matchedGameVersions?: string[];
  file?: ModrinthJarFile;
};

export type CompatibilityResolverOptions = {
  projectId: string;
  minecraftVersion: string;
  loader: string;
  channel: ReleaseChannel;
};

export type VersionCompatibilityOptions = Omit<CompatibilityResolverOptions, "projectId">;

type CachedVersions = {
  filtered?: ModrinthVersion[];
  all?: ModrinthVersion[];
};

const compatibilityVersionCache = new Map<string, CachedVersions>();
const projectCache = new Map<string, any>();
const projectRequestCache = new Map<string, Promise<any>>();
const projectVersionsCache = new Map<string, ModrinthVersion[]>();
const projectVersionsRequestCache = new Map<string, Promise<ModrinthVersion[]>>();

export async function fetchProject(projectId: string): Promise<any> {
  let cached = projectCache.get(projectId);
  if (cached) return cached;
  const pending = projectRequestCache.get(projectId);
  if (pending) return pending;
  const url = `https://api.modrinth.com/v2/project/${encodeURIComponent(projectId)}`;
  const request = (async () => {
    const response = await modrinthFetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch project ${projectId}: ${response.statusText}`);
    }
    const data = await response.json();
    projectCache.set(projectId, data);
    return data;
  })().finally(() => {
    projectRequestCache.delete(projectId);
  });
  projectRequestCache.set(projectId, request);
  return request;
}

export function normalizeReleaseChannel(channel?: string): ReleaseChannel {
  return channel === "alpha" || channel === "beta" ? channel : "release";
}

export function versionChannel(versionType?: string): ReleaseChannel {
  return normalizeReleaseChannel(versionType);
}

export function allowedForChannel(version: ModrinthVersion, selectedChannel: ReleaseChannel) {
  return channelRank[versionChannel(version.version_type)] <= channelRank[selectedChannel];
}

export function modrinthJarFile(version?: ModrinthVersion): ModrinthJarFile | undefined {
  return version?.files.find((candidate) => candidate.primary && candidate.filename.endsWith(".jar"))
    ?? version?.files.find((candidate) => candidate.filename.endsWith(".jar"));
}

export function modrinthServerSideSupported(serverSide?: string) {
  return serverSide === undefined || serverSide === "required" || serverSide === "optional";
}

export function minecraftVersionFacetValues(minecraftVersion: string) {
  const normalized = minecraftVersion.trim();
  const values = new Set<string>();
  if (normalized) values.add(normalized);
  const parts = normalized.split(".");
  if (parts.length >= 3 && parts.slice(0, 3).every((part) => /^\d+$/.test(part))) {
    values.add(`${parts[0]}.${parts[1]}.x`);
  }
  return Array.from(values);
}

export function minecraftVersionMatches(advertisedVersion: string, minecraftVersion: string) {
  const advertised = advertisedVersion.trim();
  const target = minecraftVersion.trim();
  if (!advertised || !target) return false;
  if (advertised === target) return true;

  const advertisedParts = advertised.split(".");
  const targetParts = target.split(".");
  if (advertisedParts.length !== targetParts.length) return false;
  return advertisedParts.every((part, index) => part.toLowerCase() === "x" || part === targetParts[index]);
}

export function minecraftVersionsInclude(gameVersions: string[], minecraftVersion: string) {
  return gameVersions.some((version) => minecraftVersionMatches(version, minecraftVersion));
}

export function latestCompatibleProjectVersion(
  versions: ModrinthVersion[],
  options: VersionCompatibilityOptions
) {
  return versions.find((version) => (
    allowedForChannel(version, options.channel)
    && version.loaders.includes(options.loader)
    && minecraftVersionsInclude(version.game_versions, options.minecraftVersion)
    && modrinthJarFile(version)
  ));
}

function compatibleResult(
  version: ModrinthVersion,
  file: ModrinthJarFile,
  projectSides?: { server_side?: string; client_side?: string }
): ModrinthCompatibilityMatch {
  return {
    status: "compatible",
    compatible: true,
    reason: "Compatible server-side Fabric mod",
    matchedVersionId: version.id,
    matchedVersionNumber: version.version_number,
    matchedVersionType: versionChannel(version.version_type),
    matchedLoaders: version.loaders,
    matchedGameVersions: version.game_versions,
    file,
    serverSide: projectSides?.server_side,
    clientSide: projectSides?.client_side
  };
}

function incompatible(
  status: ModCompatibility["status"],
  reason: string,
  fallbackVersion?: ModrinthVersion,
  projectSides?: { server_side?: string; client_side?: string }
): ModrinthCompatibilityMatch {
  const file = modrinthJarFile(fallbackVersion);
  return {
    status,
    compatible: false,
    reason,
    matchedVersionId: fallbackVersion?.id,
    matchedVersionNumber: fallbackVersion?.version_number,
    matchedVersionType: fallbackVersion ? versionChannel(fallbackVersion.version_type) : undefined,
    matchedLoaders: fallbackVersion?.loaders,
    matchedGameVersions: fallbackVersion?.game_versions,
    file,
    serverSide: projectSides?.server_side,
    clientSide: projectSides?.client_side
  };
}

export function unknownCompatibility(): ModrinthCompatibilityMatch {
  return {
    status: "unknown",
    compatible: false,
    reason: "Compatibility could not be verified."
  };
}

export function resolveCompatibilityFromVersions(
  versions: ModrinthVersion[],
  options: VersionCompatibilityOptions,
  projectSides?: { server_side?: string; client_side?: string }
): ModrinthCompatibilityMatch {
  const loaderVersions = versions.filter((version) => version.loaders.includes(options.loader));
  const loaderAndGameVersions = loaderVersions.filter((version) => minecraftVersionsInclude(version.game_versions, options.minecraftVersion));
  const loaderGameJarVersions = loaderAndGameVersions.filter((version) => modrinthJarFile(version));
  const matchingVersion = loaderGameJarVersions.find((version) => allowedForChannel(version, options.channel));
  const matchingFile = modrinthJarFile(matchingVersion);

  const serverSide = projectSides?.server_side;
  const clientSide = projectSides?.client_side;

  if (matchingVersion && matchingFile) {
    if (serverSide === "unsupported") {
      return {
        status: "incompatible",
        compatible: false,
        reason: "Client-only mod; server-side support is unsupported",
        serverSide,
        clientSide,
        matchedVersionId: matchingVersion.id,
        matchedVersionNumber: matchingVersion.version_number,
        matchedVersionType: versionChannel(matchingVersion.version_type),
        matchedLoaders: matchingVersion.loaders,
        matchedGameVersions: matchingVersion.game_versions,
        file: matchingFile
      };
    }
    if (serverSide === "unknown") {
      return {
        status: "unknown",
        compatible: false,
        reason: "Server-side support could not be verified",
        serverSide,
        clientSide,
        matchedVersionId: matchingVersion.id,
        matchedVersionNumber: matchingVersion.version_number,
        matchedVersionType: versionChannel(matchingVersion.version_type),
        matchedLoaders: matchingVersion.loaders,
        matchedGameVersions: matchingVersion.game_versions,
        file: matchingFile
      };
    }
    return compatibleResult(matchingVersion, matchingFile, projectSides);
  }

  const fallbackVersion = loaderGameJarVersions[0]
    ?? loaderAndGameVersions[0]
    ?? loaderVersions[0]
    ?? versions.find((version) => minecraftVersionsInclude(version.game_versions, options.minecraftVersion) && modrinthJarFile(version))
    ?? versions.find((version) => modrinthJarFile(version));

  if (loaderVersions.length === 0) {
    return incompatible("no_fabric", "No Fabric version available", fallbackVersion, projectSides);
  }
  if (loaderAndGameVersions.length === 0) {
    return incompatible("no_minecraft_version", `Not available for Minecraft ${options.minecraftVersion}`, fallbackVersion, projectSides);
  }
  if (loaderGameJarVersions.length === 0) {
    return incompatible("incompatible", "No installable .jar file was found", fallbackVersion, projectSides);
  }
  return incompatible("incompatible", "No version matched the selected release channel", fallbackVersion, projectSides);
}

export async function fetchProjectVersions(projectId: string, filters?: { loader?: string; minecraftVersion?: string }) {
  const cacheKey = `${projectId}|${filters?.loader ?? ""}|${filters?.minecraftVersion ?? ""}`;
  const cached = projectVersionsCache.get(cacheKey);
  if (cached) return cached;
  const pending = projectVersionsRequestCache.get(cacheKey);
  if (pending) return pending;
  const url = new URL(`https://api.modrinth.com/v2/project/${encodeURIComponent(projectId)}/version`);
  url.searchParams.set("include_changelog", "false");
  if (filters?.loader) {
    url.searchParams.set("loaders", JSON.stringify([filters.loader]));
  }
  if (filters?.minecraftVersion) {
    url.searchParams.set("game_versions", JSON.stringify(minecraftVersionFacetValues(filters.minecraftVersion)));
  }
  const request = (async () => {
    const response = await modrinthFetch(url.toString());
    const versions = await response.json() as ModrinthVersion[];
    projectVersionsCache.set(cacheKey, versions);
    return versions;
  })().finally(() => {
    projectVersionsRequestCache.delete(cacheKey);
  });
  projectVersionsRequestCache.set(cacheKey, request);
  return request;
}

export async function resolveModrinthProjectCompatibility(options: CompatibilityResolverOptions): Promise<ModrinthCompatibilityMatch> {
  const cacheKey = `${options.projectId}|${options.minecraftVersion}|${options.loader}|${options.channel}`;
  const cached = compatibilityVersionCache.get(cacheKey) ?? {};
  compatibilityVersionCache.set(cacheKey, cached);

  try {
    const project = await fetchProject(options.projectId);
    const projectSides = {
      server_side: project.server_side,
      client_side: project.client_side
    };

    cached.filtered ??= await fetchProjectVersions(options.projectId, {
      loader: options.loader,
      minecraftVersion: options.minecraftVersion
    });
    const filteredResult = resolveCompatibilityFromVersions(cached.filtered, options, projectSides);
    if (filteredResult.compatible || filteredResult.matchedVersionId) {
      return filteredResult;
    }

    cached.all ??= await fetchProjectVersions(options.projectId);
    return resolveCompatibilityFromVersions(cached.all, options, projectSides);
  } catch (err) {
    console.error(err);
    return unknownCompatibility();
  }
}
