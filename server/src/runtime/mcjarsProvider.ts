import { config } from "../config.js";
import { appUserAgentFor } from "../buildInfo.js";
import { assertMcJarsArtifactUrl } from "../http/outboundUrls.js";
import type { ServerRuntimeProfile } from "../types.js";
import {
  minecraftJavaMajorVersion,
  RuntimeResolutionError,
  type RuntimeLoaderVersion,
  type RuntimeMinecraftVersion,
  type ServerJarProvider
} from "./profile.js";

type McJarsVersionEntry = {
  type?: string;
  supported?: boolean;
  java?: number;
  created?: string;
  builds?: number;
  latest?: McJarsBuild;
};

type McJarsBuild = {
  id?: number;
  uuid?: string;
  versionId?: string;
  projectVersionId?: string;
  type?: string;
  experimental?: boolean;
  name?: string;
  buildNumber?: number;
  jarUrl?: string;
  jarSize?: number;
  created?: string | null;
};

type CacheEntry<T> = {
  expiresAt: number;
  value: T;
};

const successTtlMs = 15 * 60_000;
const failureTtlMs = 30_000;
const userAgent = appUserAgentFor("MCJars runtime provider");
const mcjarsReachabilityMessage = "serverSENTINEL could not reach MCJars to fetch Fabric server files. Check internet access from the panel or node host, then try again.";

function withDetails(error: RuntimeResolutionError, details: string) {
  (error as RuntimeResolutionError & { details?: string }).details = details;
  return error;
}

export class McJarsProvider implements ServerJarProvider {
  readonly id = "mcjars" as const;
  private readonly cache = new Map<string, CacheEntry<unknown>>();

  constructor(
    private readonly baseUrl = config.mcjarsBaseUrl,
    private readonly apiKey = config.mcjarsApiKey,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async listMinecraftVersions(options?: { forceRefresh?: boolean }): Promise<RuntimeMinecraftVersion[]> {
    const body = await this.cached("fabric-builds", () => this.request<{ success?: boolean; builds?: Record<string, McJarsVersionEntry> }>("/api/v2/builds/FABRIC"), options?.forceRefresh);
    if (!body.success || !body.builds || typeof body.builds !== "object") {
      throw new RuntimeResolutionError("provider_unavailable", "MCJars did not return a usable Fabric version list");
    }
    return Object.entries(body.builds)
      .map(([id, entry]) => this.normalizeMinecraftVersion(id, entry))
      .filter((version) => version.supported)
      .sort((a, b) => (b.releasedAt ?? "").localeCompare(a.releasedAt ?? ""));
  }

  async listFabricLoaderVersions(minecraftVersion: string, options?: { forceRefresh?: boolean }): Promise<RuntimeLoaderVersion[]> {
    const builds = await this.fabricBuildsForVersion(minecraftVersion, options?.forceRefresh);
    return builds.map((build, index) => ({
      id: String(build.id ?? build.uuid ?? `${build.projectVersionId ?? build.name}-${build.buildNumber ?? index}`),
      loaderVersion: stringValue(build.projectVersionId ?? build.name, "MCJars Fabric loader version"),
      stable: build.experimental !== true,
      recommended: index === 0,
      buildId: build.uuid ?? (build.id === undefined ? undefined : String(build.id))
    }));
  }

  async resolveFabricServerJar(input: {
    minecraftVersion: string;
    loaderVersion?: string;
    preferStable?: boolean;
    forceRefresh?: boolean;
  }): Promise<ServerRuntimeProfile> {
    const minecraftVersion = input.minecraftVersion.trim();
    if (!minecraftVersion) {
      throw new RuntimeResolutionError("unsupported_minecraft_version", "Minecraft version is required");
    }
    const builds = await this.fabricBuildsForVersion(minecraftVersion, input.forceRefresh);
    const wantedLoader = input.loaderVersion?.trim();
    const selected = wantedLoader && wantedLoader !== "latest"
      ? builds.find((build) => build.projectVersionId === wantedLoader || build.name === wantedLoader || String(build.id) === wantedLoader || build.uuid === wantedLoader)
      : builds.find((build) => input.preferStable === false || build.experimental !== true) ?? builds[0];
    if (!selected) {
      throw new RuntimeResolutionError(
        wantedLoader ? "invalid_loader_version" : "no_fabric_artifact",
        wantedLoader ? `Fabric loader ${wantedLoader} is not available for Minecraft ${minecraftVersion}` : `MCJars has no Fabric server artifact for Minecraft ${minecraftVersion}`
      );
    }
    const downloadUrl = assertMcJarsArtifactUrl(this.fabricDownloadUrl(selected), this.baseUrl);
    const loaderVersion = stringValue(selected.projectVersionId ?? selected.name, "MCJars Fabric loader version");
    const javaMajorVersion = minecraftJavaMajorVersion(minecraftVersion);
    const artifactId = selected.uuid ?? (selected.id === undefined ? undefined : String(selected.id));
    return {
      minecraftVersion,
      loader: "fabric",
      loaderVersion,
      javaMajorVersion,
      jarProvider: this.id,
      jarArtifact: {
        id: artifactId,
        filename: "fabric-server-launch.jar",
        downloadUrl,
        sizeBytes: typeof selected.jarSize === "number" ? selected.jarSize : undefined
      },
      compatibilityStatus: "compatible",
      resolvedAt: new Date().toISOString()
    };
  }

  private async fabricBuildsForVersion(minecraftVersion: string, forceRefresh?: boolean) {
    const body = await this.cached(`fabric-builds:${minecraftVersion}`, () => this.request<{ success?: boolean; builds?: McJarsBuild[] }>(`/api/v2/builds/FABRIC/${encodeURIComponent(minecraftVersion)}`), forceRefresh);
    if (!body.success || !Array.isArray(body.builds)) {
      throw new RuntimeResolutionError("provider_unavailable", `MCJars did not return Fabric builds for Minecraft ${minecraftVersion}`);
    }
    const builds = body.builds.filter((build) => build.type === undefined || build.type === "FABRIC");
    if (builds.length === 0) {
      throw new RuntimeResolutionError("no_fabric_artifact", `MCJars has no Fabric builds for Minecraft ${minecraftVersion}`);
    }
    return builds;
  }

  private normalizeMinecraftVersion(id: string, entry: McJarsVersionEntry): RuntimeMinecraftVersion {
    const apiJava = entry.java;
    let javaMajorVersion: 17 | 21 | 25 | undefined = apiJava === 17 || apiJava === 21 || apiJava === 25 ? apiJava : undefined;
    try {
      javaMajorVersion ??= minecraftJavaMajorVersion(id);
    } catch {
      javaMajorVersion = 17;
    }
    return {
      id,
      type: entry.type === "RELEASE" ? "release" : entry.type === "SNAPSHOT" ? "snapshot" : "unknown",
      supported: entry.supported === true && (apiJava === 17 || apiJava === 21 || apiJava === 25),
      javaMajorVersion,
      releasedAt: typeof entry.created === "string" ? entry.created : undefined
    };
  }

  private fabricDownloadUrl(build: McJarsBuild) {
    const mcJarsUrl = stringValue(build.jarUrl, "MCJars Fabric jar URL");
    if (!mcJarsUrl.startsWith("https://")) {
      throw new RuntimeResolutionError("no_fabric_artifact", "MCJars returned a Fabric artifact without a HTTPS download URL");
    }
    return mcJarsUrl;
  }

  private async cached<T>(key: string, load: () => Promise<T>, forceRefresh = false): Promise<T> {
    const now = Date.now();
    const cached = this.cache.get(key) as CacheEntry<T> | undefined;
    if (!forceRefresh && cached && cached.expiresAt > now) return cached.value;
    try {
      const value = await load();
      this.cache.set(key, { value, expiresAt: now + successTtlMs });
      return value;
    } catch (error) {
      if (cached) {
        cached.expiresAt = now + failureTtlMs;
        return cached.value;
      }
      throw error;
    }
  }

  private async request<T>(path: string): Promise<T> {
    const url = new URL(path, this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`);
    const headers: Record<string, string> = { "User-Agent": userAgent };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        headers,
        signal: AbortSignal.timeout(15_000),
        redirect: "error"
      });
    } catch (error) {
      throw withDetails(
        new RuntimeResolutionError("provider_unavailable", mcjarsReachabilityMessage),
        `MCJars API request failed\nurl=${url.toString()}\nerror=${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw withDetails(
        new RuntimeResolutionError("provider_unavailable", `MCJars is currently unavailable (${response.status}). Try again in a moment.`),
        `MCJars API request failed\nurl=${url.toString()}\nstatus=${response.status} ${response.statusText}\nbody=${body || "(empty)"}`
      );
    }
    return await response.json() as T;
  }
}

function stringValue(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new RuntimeResolutionError("no_fabric_artifact", `${field} is missing`);
  }
  return value.trim();
}

export const defaultServerJarProvider = new McJarsProvider();
