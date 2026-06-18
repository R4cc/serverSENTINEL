import type { InstalledMod, ModUpdatePlan, ModUpdatePlanEntry } from "../../types";
import { getInstalledModHealth, modVersion } from "./modHealth";

export function updatePlanEntryForMod(plan: ModUpdatePlan | null, mod: InstalledMod) {
  return plan?.updates.find((entry) => entry.filename === mod.filename) ?? null;
}

export function canUpdateAllSafe(plan: ModUpdatePlan | null, changesAllowed: boolean, batchRunning: boolean) {
  return Boolean(plan && plan.counts.safeUpdates > 0 && changesAllowed && !batchRunning);
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
      channel: mod.versionInfo?.latestChannel || mod.preferredChannel || "release",
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
