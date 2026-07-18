import { serverRuntimeDefinition } from "@serversentinel/contracts";
import { appUserAgentFor } from "../buildInfo.js";
import { assertPaperMcArtifactUrl } from "../http/outboundUrls.js";
import type { ServerRuntimeProfile, ServerRuntimeType } from "../types.js";
import {
  minecraftJavaMajorVersion,
  RuntimeResolutionError,
  type RuntimeMinecraftVersion,
  type RuntimeVersion,
  type ServerJarProvider
} from "./profile.js";

type PaperProjectResponse = {
  project?: { id?: string; name?: string };
  versions?: Record<string, string[]>;
  ok?: boolean;
  message?: string;
};

type PaperDownload = {
  name?: string;
  checksums?: { sha256?: string };
  size?: number;
  url?: string;
};

type PaperBuild = {
  id?: number;
  time?: string;
  channel?: string;
  downloads?: Record<string, PaperDownload>;
};

type CacheEntry<T> = {
  expiresAt: number;
  value: T;
};

const paperBaseUrl = "https://fill.papermc.io";
const successTtlMs = 15 * 60_000;
const failureTtlMs = 30_000;
const userAgent = appUserAgentFor("PaperMC runtime provider");
const runtime = serverRuntimeDefinition("paper");

function withDetails(error: RuntimeResolutionError, details: string) {
  (error as RuntimeResolutionError & { details?: string }).details = details;
  return error;
}

export class PaperDownloadsProvider implements ServerJarProvider {
  readonly id = "papermc" as const;
  private readonly cache = new Map<string, CacheEntry<unknown>>();

  constructor(
    private readonly baseUrl = paperBaseUrl,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async listMinecraftVersions(runtimeType: ServerRuntimeType, options?: { forceRefresh?: boolean }): Promise<RuntimeMinecraftVersion[]> {
    this.requirePaper(runtimeType);
    const body = await this.cached("paper-project", () => this.request<PaperProjectResponse>("/v3/projects/paper"), options?.forceRefresh);
    if (!body.versions || typeof body.versions !== "object") {
      throw new RuntimeResolutionError("provider_unavailable", "PaperMC did not return a usable Minecraft version list");
    }
    const seen = new Set<string>();
    const versions = Object.values(body.versions)
      .flat()
      .filter((version) => {
        if (seen.has(version)) return false;
        seen.add(version);
        return true;
      })
      .map((version) => this.minecraftVersion(version))
      .filter((version) => version.supported);
    for (const candidate of versions.filter((version) => version.type === "release").slice(0, 12)) {
      const builds = await this.buildsForVersion(candidate.id, options?.forceRefresh).catch(() => []);
      if (builds.some((build) => build.channel === "STABLE")) {
        candidate.recommended = true;
        break;
      }
    }
    return versions;
  }

  async listRuntimeVersions(runtimeType: ServerRuntimeType, minecraftVersion: string, options?: { forceRefresh?: boolean }): Promise<RuntimeVersion[]> {
    this.requirePaper(runtimeType);
    const builds = await this.buildsForVersion(minecraftVersion, options?.forceRefresh);
    const firstStableId = builds.find((build) => build.channel === "STABLE")?.id;
    return builds.map((build) => ({
      id: String(build.id),
      runtimeVersion: String(build.id),
      stable: build.channel === "STABLE",
      recommended: build.id === firstStableId,
      buildId: String(build.id)
    }));
  }

  async resolveServerJar(input: {
    runtimeType: ServerRuntimeType;
    minecraftVersion: string;
    runtimeVersion?: string;
    preferStable?: boolean;
    forceRefresh?: boolean;
  }): Promise<ServerRuntimeProfile> {
    this.requirePaper(input.runtimeType);
    const minecraftVersion = input.minecraftVersion.trim();
    if (!minecraftVersion) throw new RuntimeResolutionError("unsupported_minecraft_version", "Minecraft version is required");
    const javaMajorVersion = minecraftJavaMajorVersion(minecraftVersion);
    const builds = await this.buildsForVersion(minecraftVersion, input.forceRefresh);
    const requested = paperBuildNumber(input.runtimeVersion, minecraftVersion);
    const selected = requested
      ? builds.find((build) => String(build.id) === requested)
      : input.preferStable === false
        ? builds[0]
        : builds.find((build) => build.channel === "STABLE");
    if (!selected) {
      throw new RuntimeResolutionError(
        requested ? "invalid_runtime_version" : "no_runtime_artifact",
        requested
          ? `Paper build ${requested} is not available for Minecraft ${minecraftVersion}`
          : `PaperMC has no stable Paper build for Minecraft ${minecraftVersion}`
      );
    }
    const download = selected.downloads?.["server:default"];
    const downloadUrl = assertPaperMcArtifactUrl(stringValue(download?.url, "PaperMC server download URL"));
    const sha256 = stringValue(download?.checksums?.sha256, "PaperMC server SHA-256").toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(sha256)) {
      throw new RuntimeResolutionError("no_runtime_artifact", "PaperMC returned an invalid server SHA-256 checksum");
    }
    if (!Number.isSafeInteger(download?.size) || Number(download?.size) <= 0) {
      throw new RuntimeResolutionError("no_runtime_artifact", "PaperMC returned an invalid server artifact size");
    }
    return {
      minecraftVersion,
      runtimeType: "paper",
      runtimeVersion: String(selected.id),
      javaMajorVersion,
      jarProvider: this.id,
      jarArtifact: {
        id: `${minecraftVersion}:${selected.id}`,
        filename: runtime.serverJarFilename,
        downloadUrl,
        sha256,
        sizeBytes: download?.size
      },
      compatibilityStatus: "compatible",
      resolvedAt: new Date().toISOString()
    };
  }

  private requirePaper(runtimeType: ServerRuntimeType) {
    if (runtimeType !== "paper") {
      throw new RuntimeResolutionError("unsupported_runtime", `PaperMC provisioning does not support ${runtimeType}`);
    }
  }

  private async buildsForVersion(minecraftVersion: string, forceRefresh?: boolean) {
    const normalized = minecraftVersion.trim();
    if (!normalized) throw new RuntimeResolutionError("unsupported_minecraft_version", "Minecraft version is required");
    minecraftJavaMajorVersion(normalized);
    const body = await this.cached(
      `paper-builds:${normalized}`,
      () => this.request<PaperBuild[] | { ok?: boolean; message?: string }>(`/v3/projects/paper/versions/${encodeURIComponent(normalized)}/builds`),
      forceRefresh
    );
    if (!Array.isArray(body)) {
      const message = typeof body.message === "string" && body.message.trim() ? `: ${body.message.trim()}` : "";
      throw new RuntimeResolutionError("provider_unavailable", `PaperMC did not return Paper builds for Minecraft ${normalized}${message}`);
    }
    const builds = body
      .filter((build): build is PaperBuild & { id: number } => Number.isSafeInteger(build.id) && build.id! > 0 && Boolean(build.downloads?.["server:default"]?.url))
      .sort((left, right) => right.id - left.id);
    if (!builds.length) {
      throw new RuntimeResolutionError("no_runtime_artifact", `PaperMC has no downloadable Paper builds for Minecraft ${normalized}`);
    }
    return builds;
  }

  private minecraftVersion(version: string): RuntimeMinecraftVersion {
    let javaMajorVersion: 17 | 21 | 25 | undefined;
    try {
      javaMajorVersion = minecraftJavaMajorVersion(version);
    } catch {
      return { id: version, type: paperMinecraftVersionType(version), supported: false, javaMajorVersion: 17 };
    }
    return {
      id: version,
      type: paperMinecraftVersionType(version),
      supported: true,
      javaMajorVersion
    };
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
    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        headers: { "User-Agent": userAgent },
        signal: AbortSignal.timeout(15_000),
        redirect: "error"
      });
    } catch (error) {
      throw withDetails(
        new RuntimeResolutionError("provider_unavailable", "serverSENTINEL could not reach PaperMC to fetch Paper server files. Check internet access from the panel or node host, then try again."),
        `PaperMC API request failed\nurl=${url.toString()}\nerror=${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (!response.ok) {
      const body = (await response.text().catch(() => "")).slice(0, 4096);
      throw withDetails(
        new RuntimeResolutionError("provider_unavailable", `PaperMC is currently unavailable (${response.status}). Try again in a moment.`),
        `PaperMC API request failed\nurl=${url.toString()}\nstatus=${response.status} ${response.statusText}\nbody=${body || "(empty)"}`
      );
    }
    return await response.json() as T;
  }
}

export function paperBuildNumber(value: string | undefined, minecraftVersion: string) {
  const normalized = value?.trim();
  if (!normalized || normalized === "latest") return undefined;
  if (/^\d+$/.test(normalized)) return normalized;
  const escapedVersion = minecraftVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return normalized.match(new RegExp(`^(?:paper-)?${escapedVersion}-(\\d+)(?:\\.jar)?$`, "i"))?.[1] ?? normalized;
}

function paperMinecraftVersionType(version: string): "release" | "snapshot" {
  return /^\d+(?:\.\d+){1,2}$/.test(version) ? "release" : "snapshot";
}

function stringValue(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new RuntimeResolutionError("no_runtime_artifact", `${field} is missing`);
  }
  return value.trim();
}
