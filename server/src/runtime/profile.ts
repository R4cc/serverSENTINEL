import type {
  JavaMajorVersion,
  ManagedServer,
  ServerRuntimeProfile,
  ServerRuntimeType
} from "../types.js";

export type RuntimeMinecraftVersion = {
  id: string;
  type?: "release" | "snapshot" | "unknown";
  supported: boolean;
  javaMajorVersion: JavaMajorVersion;
  recommended?: boolean;
  releasedAt?: string;
};

export type RuntimeVersion = {
  id: string;
  runtimeVersion: string;
  stable?: boolean;
  recommended?: boolean;
  buildId?: string;
};

export type ServerJarProvider = {
  listMinecraftVersions(runtimeType: ServerRuntimeType, options?: { forceRefresh?: boolean }): Promise<RuntimeMinecraftVersion[]>;
  listRuntimeVersions(runtimeType: ServerRuntimeType, minecraftVersion: string, options?: { forceRefresh?: boolean }): Promise<RuntimeVersion[]>;
  resolveServerJar(input: {
    runtimeType: ServerRuntimeType;
    minecraftVersion: string;
    runtimeVersion?: string;
    preferStable?: boolean;
    forceRefresh?: boolean;
  }): Promise<ServerRuntimeProfile>;
};

export class RuntimeResolutionError extends Error {
  constructor(
    readonly code:
      | "unsupported_minecraft_version"
      | "unsupported_runtime"
      | "provider_unavailable"
      | "no_runtime_artifact"
      | "invalid_runtime_version"
      | "unsupported_java_version",
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
  throw new RuntimeResolutionError("unsupported_minecraft_version", "serverSENTINEL currently supports Minecraft 1.18 and newer for managed runtimes");
}

export function runtimeProfileForServer(server: Pick<ManagedServer, "runtimeProfile">): ServerRuntimeProfile {
  return server.runtimeProfile;
}

export function normalizeRuntimeProfile(value: unknown): ServerRuntimeProfile {
  if (value === undefined || value === null) throw new Error("server.runtimeProfile is required");
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("server.runtimeProfile must be an object");
  }
  const profile = value as Record<string, unknown>;
  const artifact = profile.jarArtifact;
  if (typeof artifact !== "object" || artifact === null || Array.isArray(artifact)) {
    throw new Error("server.runtimeProfile.jarArtifact must be an object");
  }
  const artifactRecord = artifact as Record<string, unknown>;
  const runtimeType = profile.runtimeType ?? profile.loader;
  if (runtimeType !== "fabric" && runtimeType !== "paper") {
    throw new RuntimeResolutionError("unsupported_runtime", "server.runtimeProfile.runtimeType must be fabric or paper");
  }
  const runtimeVersion = stringField(profile.runtimeVersion ?? profile.loaderVersion, "server.runtimeProfile.runtimeVersion");
  if (profile.runtimeType !== undefined && profile.loader !== undefined && profile.runtimeType !== profile.loader) {
    throw new Error("server.runtimeProfile legacy loader does not match runtimeType");
  }
  if (profile.runtimeVersion !== undefined && profile.loaderVersion !== undefined && profile.runtimeVersion !== profile.loaderVersion) {
    throw new Error("server.runtimeProfile legacy loaderVersion does not match runtimeVersion");
  }
  const jarProvider = profile.jarProvider;
  if (jarProvider !== "mcjars" && jarProvider !== "papermc") {
    throw new Error("server.runtimeProfile.jarProvider must be mcjars or papermc");
  }
  assertRuntimeProvider(runtimeType, jarProvider, "server.runtimeProfile.jarProvider");
  const javaMajorVersion = profile.javaMajorVersion;
  if (javaMajorVersion !== 17 && javaMajorVersion !== 21 && javaMajorVersion !== 25) {
    throw new RuntimeResolutionError("unsupported_java_version", "Unsupported Java major version in runtime profile");
  }
  const compatibilityStatus = profile.compatibilityStatus;
  const normalizedCompatibility =
    compatibilityStatus === "compatible"
    || compatibilityStatus === "unsupported"
    || compatibilityStatus === "unknown"
      ? compatibilityStatus
      : "compatible";
  return {
    minecraftVersion: stringField(profile.minecraftVersion, "server.runtimeProfile.minecraftVersion"),
    runtimeType,
    runtimeVersion,
    ...(runtimeType === "fabric" ? { loader: "fabric" as const, loaderVersion: runtimeVersion } : {}),
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

export function runtimeTarget(server: Pick<ManagedServer, "runtimeProfile">) {
  const profile = runtimeProfileForServer(server);
  const runtimeType = profile.runtimeType ?? profile.loader ?? "fabric";
  const runtimeVersion = profile.runtimeVersion ?? profile.loaderVersion ?? "";
  return {
    profile,
    minecraftVersion: profile.minecraftVersion,
    runtimeType,
    runtimeVersion,
    // Compatibility aliases keep existing Fabric-only call sites and older node payloads working
    // while the rest of the application moves to runtime-neutral terminology.
    loader: runtimeType,
    loaderVersion: runtimeVersion,
    serverJar: profile.jarArtifact.filename
  };
}

export function assertRuntimeProvider(
  runtimeType: ServerRuntimeType,
  jarProvider: "mcjars" | "papermc",
  field = "jarProvider"
) {
  const expected = runtimeType === "paper" ? "papermc" : "mcjars";
  if (jarProvider !== expected) {
    throw new Error(`${field} must be ${expected} for ${runtimeType}`);
  }
  return jarProvider;
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
