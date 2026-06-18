import type { InstalledMod, ModCompatibility, ModrinthHit } from "../../types";

export type ModUiStatus = "ready" | "review" | "not-recommended" | "unknown";

export type ModUiStatusInfo = {
  key: ModUiStatus;
  label: "Ready" | "Needs review" | "Not recommended" | "Unknown";
  description: string;
};

function fromCompatibility(compatibility?: ModCompatibility, hasManagedMetadata = true): ModUiStatusInfo {
  if (!compatibility || (!hasManagedMetadata && compatibility.status === "unknown")) {
    return { key: "unknown", label: "Unknown", description: "Compatibility metadata is not available." };
  }
  if (compatibility.compatible && compatibility.serverSide !== "unknown") {
    return { key: "ready", label: "Ready", description: compatibility.reason || "Safe for this server." };
  }
  if (
    compatibility.status === "unknown"
    || compatibility.serverSide === "unknown"
    || compatibility.reason === "Server-side support unknown"
  ) {
    return { key: "review", label: "Needs review", description: compatibility.reason || "ServerSentinel cannot fully verify this mod." };
  }
  return { key: "not-recommended", label: "Not recommended", description: compatibility.reason || "This mod is not recommended for this server." };
}

export function installedModStatus(mod: InstalledMod) {
  return fromCompatibility(mod.compatibility, Boolean(mod.modrinth));
}

export function searchResultStatus(mod: ModrinthHit) {
  return fromCompatibility(mod.compatibility, true);
}

export function installedModUpdateState(mod: InstalledMod) {
  if (mod.versionInfo?.upToDate === false && mod.versionInfo.latestVersion) return "available" as const;
  if (mod.versionInfo?.upToDate === true) return "current" as const;
  return "unknown" as const;
}

export function modVersion(mod: InstalledMod) {
  return mod.versionInfo?.currentVersion || mod.modrinth?.versionNumber || "Unknown";
}
