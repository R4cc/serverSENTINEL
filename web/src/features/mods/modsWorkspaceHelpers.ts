import type { InstalledMod, ModrinthInstallVersion, ModrinthInstallVersionsResponse, ReleaseChannel, SafeBatchUpdateResult } from "../../types";
import { validateJarFilename } from "../../utils/validation";

export type ModUploadCandidate = Pick<File, "name" | "size">;
export type ModUploadSelection = { kind: "cancelled" } | { kind: "error"; message: string } | { kind: "ready"; file: ModUploadCandidate };

export function filterInstalledMods(mods: InstalledMod[], query: string) {
  const normalized = query.trim().toLowerCase();
  return [...mods]
    .filter((mod) => !normalized || `${mod.displayName} ${mod.filename} ${mod.description || ""}`.toLowerCase().includes(normalized))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export function validateModUploadSelection(file: ModUploadCandidate | undefined, installedMods: InstalledMod[]): ModUploadSelection {
  if (!file) return { kind: "cancelled" };
  const filenameError = validateJarFilename(file.name);
  if (filenameError) return { kind: "error", message: filenameError };
  if (file.size <= 0 || file.size > 128 * 1024 * 1024) return { kind: "error", message: "Uploaded mod must be between 1 byte and 128 MiB." };
  if (installedMods.some((mod) => mod.filename === file.name || mod.filename === `${file.name}.disabled`)) return { kind: "error", message: "A mod with that filename is already installed." };
  return { kind: "ready", file };
}

export function uploadedManualMod(file: ModUploadCandidate, modifiedAt = new Date().toISOString()): InstalledMod {
  return { filename: file.name, displayName: file.name.replace(/\.jar$/i, "").replace(/[-_]/g, " "), enabled: true, size: file.size, modifiedAt };
}

export function safeBatchUpdateFeedback(result: SafeBatchUpdateResult) {
  const { updated, skipped, failed } = result.counts;
  const hasIssues = skipped > 0 || failed > 0;
  return {
    status: failed > 0 ? "failed" as const : "succeeded" as const,
    title: hasIssues
      ? updated > 0 ? "Safe updates partially completed" : "No safe updates were applied"
      : `${updated} safe ${updated === 1 ? "mod" : "mods"} updated`,
    summary: `${updated} updated · ${skipped} skipped · ${failed} failed`
  };
}

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
