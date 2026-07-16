import type { ModUpdatePlan, ModUpdatePlanEntry } from "../modrinth/updatePlan.js";
import type { StorageDatabase } from "./database.js";

const metadataKeyPrefix = "mod-update-plan:";
const releaseChannels = new Set(["release", "beta", "alpha"]);
const updateStatuses = new Set(["up_to_date", "safe_update", "needs_review", "blocked", "unknown"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isOptionalString(value: unknown) {
  return value === undefined || typeof value === "string";
}

function isUpdatePlanEntry(value: unknown): value is ModUpdatePlanEntry {
  if (!isRecord(value)) return false;
  if (
    typeof value.filename !== "string"
    || typeof value.displayName !== "string"
    || typeof value.currentFilename !== "string"
    || typeof value.reason !== "string"
    || !releaseChannels.has(String(value.channel))
    || !updateStatuses.has(String(value.status))
    || typeof value.safeBatchEligible !== "boolean"
    || typeof value.acknowledgementRequired !== "boolean"
    || typeof value.enabled !== "boolean"
    || !isOptionalString(value.iconUrl)
    || !isOptionalString(value.projectId)
    || !isOptionalString(value.currentVersion)
    || !isOptionalString(value.targetVersion)
    || !isOptionalString(value.targetFilename)
  ) return false;
  if (value.compatibility === undefined) return true;
  return isRecord(value.compatibility)
    && typeof value.compatibility.compatible === "boolean"
    && isOptionalString(value.compatibility.status)
    && isOptionalString(value.compatibility.reason)
    && isOptionalString(value.compatibility.serverSide)
    && isOptionalString(value.compatibility.clientSide);
}

function isModUpdatePlan(value: unknown, serverId: string): value is ModUpdatePlan {
  if (!isRecord(value) || value.serverId !== serverId || typeof value.generatedAt !== "string" || !isRecord(value.counts) || !Array.isArray(value.updates)) return false;
  const counts = value.counts;
  const countKeys = ["totalInstalled", "safeUpdates", "reviewUpdates", "blockedUpdates", "upToDate", "unknown"];
  return countKeys.every((key) => typeof counts[key] === "number" && Number.isFinite(counts[key]) && counts[key] >= 0)
    && value.updates.every(isUpdatePlanEntry);
}

export class ModUpdatePlanRepository {
  constructor(private readonly storage: StorageDatabase) {}

  get(serverId: string): ModUpdatePlan | null {
    const serialized = this.storage.metadata(`${metadataKeyPrefix}${serverId}`);
    if (!serialized) return null;
    try {
      const parsed: unknown = JSON.parse(serialized);
      return isModUpdatePlan(parsed, serverId) ? parsed : null;
    } catch {
      return null;
    }
  }

  set(plan: ModUpdatePlan) {
    this.storage.setMetadata(`${metadataKeyPrefix}${plan.serverId}`, JSON.stringify(plan));
  }
}
