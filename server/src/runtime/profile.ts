import type {
  JavaMajorVersion,
  LoaderType,
  ManagedServer,
  RuntimeCompatibilityStatus,
  ServerJarProviderId,
  ServerRuntimeProfile
} from "../types.js";

export type RuntimeMinecraftVersion = {
  id: string;
  type?: "release" | "snapshot" | "unknown";
  supported: boolean;
  javaMajorVersion: JavaMajorVersion;
  releasedAt?: string;
};

export type RuntimeLoaderVersion = {
  id: string;
  loaderVersion: string;
  stable?: boolean;
  recommended?: boolean;
  buildId?: string;
};

export type ServerJarProvider = {
  id: ServerJarProviderId;
  listMinecraftVersions(options?: { forceRefresh?: boolean }): Promise<RuntimeMinecraftVersion[]>;
  listFabricLoaderVersions(minecraftVersion: string, options?: { forceRefresh?: boolean }): Promise<RuntimeLoaderVersion[]>;
  resolveFabricServerJar(input: {
    minecraftVersion: string;
    loaderVersion?: string;
    preferStable?: boolean;
    forceRefresh?: boolean;
  }): Promise<ServerRuntimeProfile>;
};

export class RuntimeResolutionError extends Error {
  constructor(
    readonly code:
      | "unsupported_minecraft_version"
      | "unsupported_loader"
      | "provider_unavailable"
      | "no_fabric_artifact"
      | "invalid_loader_version"
      | "unsupported_java_version"
      | "legacy_runtime",
    message: string
  ) {
    super(message);
    this.name = "RuntimeResolutionError";
  }
}

export function minecraftJavaMajorVersion(minecraftVersion: string): JavaMajorVersion {
  const trimmed = minecraftVersion.trim();
  const modernMajor = trimmed.match(/^(\d+)\.(\d+)(?:\.(\d+))?(?:[-\w.]*)?$/);
  if (modernMajor && Number(modernMajor[1]) >= 26) {
    return 25;
  }
  const match = trimmed.match(/^1\.(\d+)(?:\.(\d+))?(?:[-\w.]*)?$/);
  if (!match) {
    throw new RuntimeResolutionError("unsupported_minecraft_version", `Minecraft ${minecraftVersion} is not a supported release version`);
  }
  const minor = Number(match[1]);
  const patch = Number(match[2] ?? "0");
  if (!Number.isInteger(minor) || !Number.isInteger(patch)) {
    throw new RuntimeResolutionError("unsupported_minecraft_version", `Minecraft ${minecraftVersion} is not a supported release version`);
  }
  if (minor > 20 || (minor === 20 && patch >= 5)) return 21;
  if (minor >= 18) return 17;
  throw new RuntimeResolutionError("unsupported_minecraft_version", "ServerSentinel currently supports Minecraft 1.18 and newer for Fabric servers");
}

export function runtimeProfileForServer(server: Pick<ManagedServer, "runtimeProfile" | "minecraftVersion" | "loaderVersion" | "serverJar">): ServerRuntimeProfile | undefined {
  if (server.runtimeProfile) return server.runtimeProfile;
  if (!server.minecraftVersion || !server.loaderVersion || !server.serverJar) return undefined;
  let javaMajorVersion: JavaMajorVersion = 17;
  let compatibilityStatus: RuntimeCompatibilityStatus = "legacy";
  try {
    javaMajorVersion = minecraftJavaMajorVersion(server.minecraftVersion);
  } catch {
    compatibilityStatus = "unknown";
  }
  return {
    minecraftVersion: server.minecraftVersion,
    loader: "fabric",
    loaderVersion: server.loaderVersion,
    javaMajorVersion,
    jarProvider: "legacy",
    jarArtifact: {
      filename: server.serverJar
    },
    compatibilityStatus,
    resolvedAt: new Date(0).toISOString()
  };
}

export function normalizeRuntimeProfile(value: unknown): ServerRuntimeProfile | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("server.runtimeProfile must be an object");
  }
  const profile = value as Record<string, unknown>;
  const artifact = profile.jarArtifact;
  if (typeof artifact !== "object" || artifact === null || Array.isArray(artifact)) {
    throw new Error("server.runtimeProfile.jarArtifact must be an object");
  }
  const artifactRecord = artifact as Record<string, unknown>;
  const loader = profile.loader;
  if (loader !== "fabric") {
    throw new RuntimeResolutionError("unsupported_loader", "Only Fabric runtime profiles are supported");
  }
  const jarProvider = profile.jarProvider;
  if (jarProvider !== "mcjars" && jarProvider !== "manual" && jarProvider !== "legacy") {
    throw new Error("server.runtimeProfile.jarProvider must be mcjars, manual, or legacy");
  }
  const javaMajorVersion = profile.javaMajorVersion;
  if (javaMajorVersion !== 17 && javaMajorVersion !== 21 && javaMajorVersion !== 25) {
    throw new RuntimeResolutionError("unsupported_java_version", "Unsupported Java major version in runtime profile");
  }
  const compatibilityStatus = profile.compatibilityStatus;
  const normalizedCompatibility: RuntimeCompatibilityStatus =
    compatibilityStatus === "compatible"
    || compatibilityStatus === "legacy"
    || compatibilityStatus === "manual"
    || compatibilityStatus === "unsupported"
    || compatibilityStatus === "unknown"
      ? compatibilityStatus
      : jarProvider === "mcjars" ? "compatible" : jarProvider;
  return {
    minecraftVersion: stringField(profile.minecraftVersion, "server.runtimeProfile.minecraftVersion"),
    loader,
    loaderVersion: stringField(profile.loaderVersion, "server.runtimeProfile.loaderVersion"),
    javaMajorVersion,
    jarProvider,
    jarArtifact: {
      id: optionalStringField(artifactRecord.id, "server.runtimeProfile.jarArtifact.id"),
      filename: runtimeJarFilename(artifactRecord.filename, "server.runtimeProfile.jarArtifact.filename"),
      downloadUrl: optionalStringField(artifactRecord.downloadUrl, "server.runtimeProfile.jarArtifact.downloadUrl"),
      sha1: optionalStringField(artifactRecord.sha1, "server.runtimeProfile.jarArtifact.sha1"),
      sha256: optionalStringField(artifactRecord.sha256, "server.runtimeProfile.jarArtifact.sha256"),
      sizeBytes: optionalNumberField(artifactRecord.sizeBytes, "server.runtimeProfile.jarArtifact.sizeBytes")
    },
    compatibilityStatus: normalizedCompatibility,
    resolvedAt: stringField(profile.resolvedAt, "server.runtimeProfile.resolvedAt")
  };
}

export function runtimeTarget(server: Pick<ManagedServer, "runtimeProfile" | "minecraftVersion" | "loaderVersion" | "serverJar">) {
  const profile = runtimeProfileForServer(server);
  return {
    profile,
    minecraftVersion: profile?.minecraftVersion ?? server.minecraftVersion,
    loader: profile?.loader ?? "fabric" as LoaderType,
    loaderVersion: profile?.loaderVersion ?? server.loaderVersion,
    serverJar: profile?.jarArtifact.filename ?? server.serverJar
  };
}

function stringField(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function runtimeJarFilename(value: unknown, field: string) {
  const filename = stringField(value, field);
  if (!filename.endsWith(".jar") || filename.includes("/") || filename.includes("\\") || filename === "." || filename === "..") {
    throw new Error(`${field} must be a local .jar filename`);
  }
  return filename;
}

function optionalStringField(value: unknown, field: string) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value.trim() || undefined;
}

function optionalNumberField(value: unknown, field: string) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${field} must be a positive number`);
  return value;
}
