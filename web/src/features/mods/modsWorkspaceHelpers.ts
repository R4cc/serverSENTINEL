import type { InstalledMod, ModrinthInstallVersion, ModrinthInstallVersionsResponse, ReleaseChannel } from "../../types";

export function installedModKey(mod: InstalledMod) {
  return mod.modrinth?.projectId || mod.filename.replace(/\.disabled$/, "");
}

export function pendingRequiredDependencies(version: ModrinthInstallVersion | null, installedMods: InstalledMod[]) {
  const installedProjectIds = new Set(installedMods.map((mod) => mod.modrinth?.projectId).filter(Boolean));
  return version?.dependencies.filter((dependency) => dependency.dependencyType === "required" && (!dependency.projectId || !installedProjectIds.has(dependency.projectId))) ?? [];
}

export function preferredInstallVersionId(data: ModrinthInstallVersionsResponse) {
  return data.compatibleVersions.find((version) => version.status === "recommended")?.id
    ?? data.compatibleVersions[0]?.id
    ?? "";
}

export function hasInstallVersions(data: ModrinthInstallVersionsResponse) {
  return data.compatibleVersions.length > 0 || data.otherVersions.length > 0;
}

export function fallbackReleaseChannel(channel: ReleaseChannel): ReleaseChannel | null {
  if (channel === "release") return "beta";
  if (channel === "beta") return "alpha";
  return null;
}
