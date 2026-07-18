import { config } from "../config.js";
import { appUserAgentFor } from "../buildInfo.js";
import { assertMcJarsArtifactUrl } from "../http/outboundUrls.js";
import { serverRuntimeDefinition } from "@serversentinel/contracts";
import type { ServerRuntimeProfile, ServerRuntimeType } from "../types.js";
import {
  minecraftJavaMajorVersion,
  RuntimeResolutionError,
  type RuntimeVersion,
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

type McJarsRuntimeAdapter = {
  runtimeType: ServerRuntimeType;
  apiProject: string;
  displayName: string;
  versionName: string;
  artifactFilename: string;
};

const runtimeAdapters: Partial<Record<ServerRuntimeType, McJarsRuntimeAdapter>> = {
  fabric: {
    runtimeType: "fabric",
    apiProject: "FABRIC",
    displayName: "Fabric",
    versionName: "Fabric loader",
    artifactFilename: serverRuntimeDefinition("fabric").serverJarFilename
  }
};

const successTtlMs = 15 * 60_000;
const failureTtlMs = 30_000;
const userAgent = appUserAgentFor("MCJars runtime provider");
const mcjarsReachabilityMessage = "serverSENTINEL could not reach MCJars to fetch Minecraft server files. Check internet access from the panel or node host, then try again.";

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

  async listMinecraftVersions(runtimeType: ServerRuntimeType, options?: { forceRefresh?: boolean }): Promise<RuntimeMinecraftVersion[]> {
    const adapter = this.adapter(runtimeType);
    const body = await this.cached(`${runtimeType}-builds`, () => this.request<{ success?: boolean; builds?: Record<string, McJarsVersionEntry> }>(`/api/v2/builds/${adapter.apiProject}`), options?.forceRefresh);
    if (!body.success || !body.builds || typeof body.builds !== "object") {
      throw new RuntimeResolutionError("provider_unavailable", `MCJars did not return a usable ${adapter.displayName} version list`);
    }
    return Object.entries(body.builds)
      .map(([id, entry]) => this.normalizeMinecraftVersion(id, entry))
      .filter((version) => version.supported)
      .sort((a, b) => (b.releasedAt ?? "").localeCompare(a.releasedAt ?? ""));
  }

  async listRuntimeVersions(runtimeType: ServerRuntimeType, minecraftVersion: string, options?: { forceRefresh?: boolean }): Promise<RuntimeVersion[]> {
    const adapter = this.adapter(runtimeType);
    const builds = await this.buildsForVersion(adapter, minecraftVersion, options?.forceRefresh);
    return builds.map((build, index) => ({
      id: String(build.id ?? build.uuid ?? `${build.projectVersionId ?? build.name}-${build.buildNumber ?? index}`),
      runtimeVersion: stringValue(build.projectVersionId ?? build.name, `MCJars ${adapter.versionName} version`),
      stable: build.experimental !== true,
      recommended: index === 0,
      buildId: build.uuid ?? (build.id === undefined ? undefined : String(build.id))
    }));
  }

  async resolveServerJar(input: {
    runtimeType: ServerRuntimeType;
    minecraftVersion: string;
    runtimeVersion?: string;
    preferStable?: boolean;
    forceRefresh?: boolean;
  }): Promise<ServerRuntimeProfile> {
    const adapter = this.adapter(input.runtimeType);
    const minecraftVersion = input.minecraftVersion.trim();
    if (!minecraftVersion) {
      throw new RuntimeResolutionError("unsupported_minecraft_version", "Minecraft version is required");
    }
    const builds = await this.buildsForVersion(adapter, minecraftVersion, input.forceRefresh);
    const wantedRuntimeVersion = input.runtimeVersion?.trim();
    const selected = wantedRuntimeVersion && wantedRuntimeVersion !== "latest"
      ? builds.find((build) => build.projectVersionId === wantedRuntimeVersion || build.name === wantedRuntimeVersion || String(build.id) === wantedRuntimeVersion || build.uuid === wantedRuntimeVersion)
      : builds.find((build) => input.preferStable === false || build.experimental !== true) ?? builds[0];
    if (!selected) {
      throw new RuntimeResolutionError(
        wantedRuntimeVersion ? "invalid_runtime_version" : "no_runtime_artifact",
        wantedRuntimeVersion ? `${adapter.versionName} ${wantedRuntimeVersion} is not available for Minecraft ${minecraftVersion}` : `MCJars has no ${adapter.displayName} server artifact for Minecraft ${minecraftVersion}`
      );
    }
    const downloadUrl = assertMcJarsArtifactUrl(this.downloadUrl(selected, adapter), this.baseUrl);
    const runtimeVersion = stringValue(selected.projectVersionId ?? selected.name, `MCJars ${adapter.versionName} version`);
    const javaMajorVersion = minecraftJavaMajorVersion(minecraftVersion);
    const artifactId = selected.uuid ?? (selected.id === undefined ? undefined : String(selected.id));
    return {
      minecraftVersion,
      runtimeType: adapter.runtimeType,
      runtimeVersion,
      ...(adapter.runtimeType === "fabric" ? { loader: "fabric" as const, loaderVersion: runtimeVersion } : {}),
      javaMajorVersion,
      jarProvider: this.id,
      jarArtifact: {
        id: artifactId,
        filename: adapter.artifactFilename,
        downloadUrl,
        sizeBytes: typeof selected.jarSize === "number" ? selected.jarSize : undefined
      },
      compatibilityStatus: "compatible",
      resolvedAt: new Date().toISOString()
    };
  }

  /** @deprecated Compatibility wrapper for older internal callers. */
  async listFabricLoaderVersions(minecraftVersion: string, options?: { forceRefresh?: boolean }) {
    const versions = await this.listRuntimeVersions("fabric", minecraftVersion, options);
    return versions.map((version) => ({ ...version, loaderVersion: version.runtimeVersion }));
  }

  /** @deprecated Compatibility wrapper for older internal callers. */
  resolveFabricServerJar(input: { minecraftVersion: string; loaderVersion?: string; preferStable?: boolean; forceRefresh?: boolean }) {
    return this.resolveServerJar({
      runtimeType: "fabric",
      minecraftVersion: input.minecraftVersion,
      runtimeVersion: input.loaderVersion,
      preferStable: input.preferStable,
      forceRefresh: input.forceRefresh
    });
  }

  private adapter(runtimeType: ServerRuntimeType) {
    const adapter = runtimeAdapters[runtimeType];
    if (!adapter) throw new RuntimeResolutionError("unsupported_runtime", `MCJars provisioning for ${runtimeType} is not enabled yet`);
    return adapter;
  }

  private async buildsForVersion(adapter: McJarsRuntimeAdapter, minecraftVersion: string, forceRefresh?: boolean) {
    const body = await this.cached(`${adapter.runtimeType}-builds:${minecraftVersion}`, () => this.request<{ success?: boolean; builds?: McJarsBuild[] }>(`/api/v2/builds/${adapter.apiProject}/${encodeURIComponent(minecraftVersion)}`), forceRefresh);
    if (!body.success || !Array.isArray(body.builds)) {
      throw new RuntimeResolutionError("provider_unavailable", `MCJars did not return ${adapter.displayName} builds for Minecraft ${minecraftVersion}`);
    }
    const builds = body.builds.filter((build) => build.type === undefined || build.type === adapter.apiProject);
    if (builds.length === 0) {
      throw new RuntimeResolutionError("no_runtime_artifact", `MCJars has no ${adapter.displayName} builds for Minecraft ${minecraftVersion}`);
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

  private downloadUrl(build: McJarsBuild, adapter: McJarsRuntimeAdapter) {
    const mcJarsUrl = stringValue(build.jarUrl, `MCJars ${adapter.displayName} jar URL`);
    if (!mcJarsUrl.startsWith("https://")) {
      throw new RuntimeResolutionError("no_runtime_artifact", `MCJars returned a ${adapter.displayName} artifact without a HTTPS download URL`);
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
    throw new RuntimeResolutionError("no_runtime_artifact", `${field} is missing`);
  }
  return value.trim();
}
