import type { InstalledMod, ModUpdatePlan, ModUpdatePlanEntry } from "../../types";
import { getInstalledModHealth, modVersion } from "./modHealth";

function modFilenameIdentity(filename: string) {
  return filename.replace(/\.disabled$/, "");
}

export function updatePlanEntryForMod(plan: ModUpdatePlan | null, mod: InstalledMod) {
  const filename = modFilenameIdentity(mod.filename);
  return plan?.updates.find((entry) => modFilenameIdentity(entry.filename) === filename || modFilenameIdentity(entry.currentFilename) === filename) ?? null;
}

export function applyUpdatePlanEntry(mod: InstalledMod, entry: ModUpdatePlanEntry | null) {
  if (!entry || entry.status === "unknown") return mod;
  return {
    ...mod,
    versionInfo: {
      currentVersion: entry.currentVersion,
      latestVersion: entry.targetVersion,
      latestFilename: entry.targetFilename,
      latestChannel: entry.channel,
      upToDate: entry.status === "up_to_date"
    }
  };
}

export function canUpdateAllSafe(plan: ModUpdatePlan | null, changesAllowed: boolean, batchRunning: boolean) {
  return Boolean(plan && plan.counts.safeUpdates > 0 && changesAllowed && !batchRunning);
}

export function safeUpdateRequestGroups(plan: ModUpdatePlan | null) {
  const groups = new Map<ModUpdatePlanEntry["channel"], string[]>();
  for (const entry of plan?.updates ?? []) {
    if (entry.status !== "safe_update" || !entry.safeBatchEligible) continue;
    groups.set(entry.channel, [...(groups.get(entry.channel) ?? []), entry.filename]);
  }
  return [...groups].map(([channel, filenames]) => ({ channel, filenames }));
}

export function createDemoUpdatePlan(serverId: string, mods: InstalledMod[], generatedAt = new Date().toISOString()): ModUpdatePlan {
  const updates: ModUpdatePlanEntry[] = mods.map((mod) => {
    const health = getInstalledModHealth(mod);
    const status: ModUpdatePlanEntry["status"] = health.hasSafeUpdate
      ? "safe_update"
      : health.hasReviewUpdate
        ? "needs_review"
        : health.key === "not_recommended"
          ? "blocked"
          : health.key === "unknown"
            ? "unknown"
            : "up_to_date";
    return {
      filename: mod.filename,
      displayName: mod.displayName,
      projectId: mod.modrinth?.projectId,
      currentVersion: modVersion(mod),
      currentFilename: mod.filename,
      targetVersion: mod.versionInfo?.latestVersion,
      targetFilename: mod.versionInfo?.latestFilename,
      channel: mod.preferredChannel || mod.versionInfo?.latestChannel || "release",
      status,
      reason: health.detailDescription,
      compatibility: mod.compatibility ? {
        status: mod.compatibility.status,
        compatible: mod.compatibility.compatible,
        reason: mod.compatibility.reason,
        serverSide: mod.compatibility.serverSide,
        clientSide: mod.compatibility.clientSide
      } : undefined,
      safeBatchEligible: status === "safe_update",
      acknowledgementRequired: status === "needs_review",
      enabled: mod.enabled
    };
  });
  return {
    serverId,
    generatedAt,
    counts: {
      totalInstalled: updates.length,
      safeUpdates: updates.filter((entry) => entry.status === "safe_update").length,
      reviewUpdates: updates.filter((entry) => entry.status === "needs_review").length,
      blockedUpdates: updates.filter((entry) => entry.status === "blocked").length,
      upToDate: updates.filter((entry) => entry.status === "up_to_date").length,
      unknown: updates.filter((entry) => entry.status === "unknown").length
    },
    updates
  };
}
