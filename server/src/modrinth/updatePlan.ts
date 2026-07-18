export type ModUpdatePlanStatus = "up_to_date" | "safe_update" | "needs_review" | "blocked" | "unknown";

export type ModUpdatePlanSource = {
  filename?: unknown;
  displayName?: unknown;
  iconUrl?: unknown;
  enabled?: unknown;
  preferredChannel?: unknown;
  compatibility?: unknown;
  modrinth?: unknown;
  versionInfo?: unknown;
};

export type ModUpdatePlanEntry = {
  filename: string;
  displayName: string;
  iconUrl?: string;
  projectId?: string;
  currentVersion?: string;
  currentFilename: string;
  targetVersion?: string;
  targetFilename?: string;
  channel: "release" | "beta" | "alpha";
  status: ModUpdatePlanStatus;
  reason: string;
  compatibility?: {
    status?: string;
    compatible: boolean;
    reason?: string;
    serverSide?: string;
    clientSide?: string;
  };
  safeBatchEligible: boolean;
  acknowledgementRequired: boolean;
  enabled: boolean;
};

export type ModUpdatePlan = {
  serverId: string;
  generatedAt: string;
  counts: {
    totalInstalled: number;
    safeUpdates: number;
    reviewUpdates: number;
    blockedUpdates: number;
    upToDate: number;
    unknown: number;
  };
  updates: ModUpdatePlanEntry[];
};

type ObjectValue = Record<string, unknown>;

function objectValue(value: unknown): ObjectValue | undefined {
  return value && typeof value === "object" ? value as ObjectValue : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function channelValue(value: unknown): "release" | "beta" | "alpha" {
  return value === "beta" || value === "alpha" ? value : "release";
}

export function classifyModUpdatePlanEntry(source: ModUpdatePlanSource): ModUpdatePlanEntry {
  const filename = stringValue(source.filename) ?? "unknown.jar";
  const displayName = stringValue(source.displayName) ?? filename.replace(/\.jar(?:\.disabled)?$/i, "");
  const metadata = objectValue(source.modrinth);
  const compatibility = objectValue(source.compatibility);
  const versionInfo = objectValue(source.versionInfo);
  const projectId = stringValue(metadata?.projectId);
  const iconUrl = stringValue(source.iconUrl) ?? stringValue(metadata?.iconUrl);
  const currentVersion = stringValue(versionInfo?.currentVersion) ?? stringValue(metadata?.versionNumber);
  const targetVersion = stringValue(versionInfo?.latestVersion);
  const targetFilename = stringValue(versionInfo?.latestFilename);
  const compatibilityStatus = stringValue(compatibility?.status);
  const compatibilityReason = stringValue(compatibility?.reason);
  const serverSide = stringValue(compatibility?.serverSide) ?? stringValue(metadata?.serverSide);
  const clientSide = stringValue(compatibility?.clientSide) ?? stringValue(metadata?.clientSide);
  const compatible = compatibility?.compatible === true;
  const forced = metadata?.installedWithForceIncompatible === true
    || metadata?.forceIncompatible === true
    || metadata?.overrideMinecraftVersion === true;
  const risky = forced
    || serverSide === "unsupported"
    || compatibilityStatus === "no_fabric"
    || compatibilityStatus === "no_compatible_loader"
    || compatibilityStatus === "no_minecraft_version"
    || compatibilityStatus === "incompatible";
  const uncertain = !compatibility
    || compatibilityStatus === "unknown"
    || serverSide === "unknown"
    || (!compatible && !risky);

  const base = {
    filename,
    displayName,
    iconUrl,
    projectId,
    currentVersion,
    currentFilename: filename,
    targetVersion,
    targetFilename,
    channel: channelValue(source.preferredChannel ?? versionInfo?.latestChannel ?? metadata?.versionType),
    compatibility: compatibility ? {
      status: compatibilityStatus,
      compatible,
      reason: compatibilityReason,
      serverSide,
      clientSide
    } : undefined,
    enabled: source.enabled !== false
  };

  if (!metadata || !projectId) {
    return { ...base, status: "unknown", reason: "This mod has no verified Modrinth metadata, so updates cannot be planned safely.", safeBatchEligible: false, acknowledgementRequired: false };
  }
  if (risky) {
    const reason = forced
      ? stringValue(metadata.overrideReason) ?? stringValue(metadata.incompatibilityReason) ?? "Compatibility safeguards were overridden for the installed mod."
      : compatibilityReason ?? "The installed mod is not recommended for this server target.";
    return { ...base, status: "blocked", reason, safeBatchEligible: false, acknowledgementRequired: false };
  }
  if (!versionInfo) {
    return { ...base, status: "unknown", reason: "Update metadata could not be resolved from Modrinth.", safeBatchEligible: false, acknowledgementRequired: false };
  }
  if (versionInfo.upToDate === true) {
    return { ...base, status: "up_to_date", reason: "The installed version is the latest compatible version for this server.", safeBatchEligible: false, acknowledgementRequired: false };
  }
  if (!targetVersion) {
    return { ...base, status: "blocked", reason: "No compatible installable target version was found for this server.", safeBatchEligible: false, acknowledgementRequired: false };
  }
  if (uncertain) {
    return { ...base, status: "needs_review", reason: compatibilityReason ?? "Server-side compatibility cannot be fully verified.", safeBatchEligible: false, acknowledgementRequired: true };
  }
  return { ...base, status: "safe_update", reason: "The target version matches this server’s Fabric and Minecraft runtime.", safeBatchEligible: true, acknowledgementRequired: false };
}

export function createModUpdatePlan(serverId: string, mods: ModUpdatePlanSource[], generatedAt = new Date().toISOString()): ModUpdatePlan {
  const updates = mods.map(classifyModUpdatePlanEntry);
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

export type SafeBatchUpdateResult = {
  updated: Array<{ filename: string; result: unknown }>;
  skipped: Array<{ filename: string; reason: string }>;
  failed: Array<{ filename: string; reason: string }>;
  counts: { requested: number; updated: number; skipped: number; failed: number };
};

export async function executeSafeUpdatePlan(
  plan: ModUpdatePlan,
  filenames: string[] | undefined,
  update: (entry: ModUpdatePlanEntry) => Promise<unknown>
): Promise<SafeBatchUpdateResult> {
  const requested = filenames?.length ? [...new Set(filenames)] : plan.updates.map((entry) => entry.filename);
  const byFilename = new Map(plan.updates.map((entry) => [entry.filename, entry]));
  const updated: SafeBatchUpdateResult["updated"] = [];
  const skipped: SafeBatchUpdateResult["skipped"] = [];
  const failed: SafeBatchUpdateResult["failed"] = [];

  for (const filename of requested) {
    const entry = byFilename.get(filename);
    if (!entry) {
      skipped.push({ filename, reason: "The requested mod is not installed." });
      continue;
    }
    if (!entry.safeBatchEligible || entry.status !== "safe_update") {
      skipped.push({ filename, reason: entry.reason });
      continue;
    }
    try {
      updated.push({ filename, result: await update(entry) });
    } catch (error) {
      failed.push({ filename, reason: error instanceof Error ? error.message : "Update failed" });
    }
  }

  return {
    updated,
    skipped,
    failed,
    counts: { requested: requested.length, updated: updated.length, skipped: skipped.length, failed: failed.length }
  };
}
