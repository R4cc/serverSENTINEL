import { safeInstalledModFilename } from "./core.js";
import { requireStrictBoolean } from "./http/validation.js";
import { normalizeReleaseChannel } from "./modrinth/compatibility.js";
import { asArray, asObject, optionalString, requiredString } from "./storage/valueValidation.js";
import type { InstalledModMetadata } from "./types.js";

export function normalizeInstalledModMetadata(value: unknown): InstalledModMetadata {
  const metadata = asObject(value, "installed mod metadata");
  return {
    projectId: requiredString(metadata.projectId, "modrinth.projectId"),
    versionId: requiredString(metadata.versionId, "modrinth.versionId"),
    filename: safeInstalledModFilename(requiredString(metadata.filename, "modrinth.filename")),
    versionNumber: requiredString(metadata.versionNumber, "modrinth.versionNumber"),
    versionType: metadata.versionType === undefined ? undefined : normalizeReleaseChannel(optionalString(metadata.versionType, "modrinth.versionType")),
    gameVersions: asArray(metadata.gameVersions, "modrinth.gameVersions").map((version) => requiredString(version, "modrinth.gameVersions[]")),
    loaders: asArray(metadata.loaders, "modrinth.loaders").map((loader) => requiredString(loader, "modrinth.loaders[]")),
    hashes: metadata.hashes === undefined ? undefined : normalizeStringRecord(metadata.hashes, "modrinth.hashes"),
    installedAt: requiredString(metadata.installedAt, "modrinth.installedAt"),
    installedWithForceIncompatible: requireStrictBoolean(metadata.installedWithForceIncompatible, "modrinth.installedWithForceIncompatible"),
    incompatibilityReason: optionalString(metadata.incompatibilityReason, "modrinth.incompatibilityReason"),
    overrideMinecraftVersion: metadata.overrideMinecraftVersion === undefined ? undefined : requireStrictBoolean(metadata.overrideMinecraftVersion, "modrinth.overrideMinecraftVersion"),
    overrideReason: optionalString(metadata.overrideReason, "modrinth.overrideReason"),
    clientSide: optionalString(metadata.clientSide, "modrinth.clientSide"),
    serverSide: optionalString(metadata.serverSide, "modrinth.serverSide"),
    iconUrl: optionalString(metadata.iconUrl, "modrinth.iconUrl"),
    forceIncompatible: metadata.forceIncompatible === undefined ? undefined : requireStrictBoolean(metadata.forceIncompatible, "modrinth.forceIncompatible"),
    reviewAcknowledgedVersionId: optionalString(metadata.reviewAcknowledgedVersionId, "modrinth.reviewAcknowledgedVersionId"),
    reviewAcknowledgedAt: optionalString(metadata.reviewAcknowledgedAt, "modrinth.reviewAcknowledgedAt")
  };
}

function normalizeStringRecord(value: unknown, label: string) {
  const raw = asObject(value, label);
  const normalized: Record<string, string> = {};
  for (const [key, item] of Object.entries(raw)) {
    normalized[key] = requiredString(item, `${label}.${key}`);
  }
  return normalized;
}

/**
 * The lenient counterpart of `normalizeInstalledModMetadata`, for metadata that arrives with a
 * runtime's mod listing rather than from storage: a record missing its identifying fields reads as
 * "no Modrinth metadata" instead of failing the whole listing. It deliberately omits the review
 * acknowledgement, which only the panel's own preferences carry.
 */
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

/** The `mods` array of a runtime's list-mods result, or an empty list for any other shape. */
export function modsFromListResult(result: unknown) {
  if (!result || typeof result !== "object" || !Array.isArray((result as { mods?: unknown }).mods)) return [];
  return (result as { mods: Array<Record<string, unknown>> }).mods;
}
