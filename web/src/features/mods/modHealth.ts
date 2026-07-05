import type { InstalledMod, ModCompatibility, ModrinthHit, ModrinthInstallVersion } from "../../types";

export type ModHealthKey =
  | "healthy"
  | "safe_update_available"
  | "review_update_available"
  | "needs_review"
  | "not_recommended"
  | "unknown";

export type ModHealthTone = "ready" | "update" | "review" | "not-recommended" | "unknown";

export type InstalledModHealth = {
  key: ModHealthKey;
  label: string;
  shortDescription: string;
  detailDescription: string;
  tone: ModHealthTone;
  needsAttention: boolean;
  hasSafeUpdate: boolean;
  hasReviewUpdate: boolean;
  primaryActionLabel?: string;
  safeToRunDirectly: boolean;
};

type CompatibilityAssessment = {
  kind: "healthy" | "review" | "not_recommended" | "unknown";
  shortDescription: string;
  detailDescription: string;
};

const riskyReasonPattern = /client[- ]only|wrong loader|version mismatch|not marked for minecraft|unsupported|incompatible/i;

function compatibilityAssessment(compatibility?: ModCompatibility, hasManagedMetadata = true): CompatibilityAssessment {
  if (!compatibility) {
    return {
      kind: "unknown",
      shortDescription: "Compatibility is unknown.",
      detailDescription: hasManagedMetadata
        ? "serverSENTINEL could not load enough compatibility metadata for this mod."
        : "This manually uploaded mod has no verified Modrinth compatibility metadata."
    };
  }

  const explicitlyRisky = ["no_fabric", "no_minecraft_version", "incompatible"].includes(compatibility.status)
    || compatibility.serverSide === "unsupported"
    || riskyReasonPattern.test(compatibility.reason || "");
  if (explicitlyRisky) {
    return {
      kind: "not_recommended",
      shortDescription: "This mod may not be safe for this server.",
      detailDescription: compatibility.reason || "The loader, Minecraft version, or server-side support does not match this server."
    };
  }

  const uncertain = compatibility.status === "unknown"
    || compatibility.serverSide === "unknown"
    || compatibility.reason === "Server-side support unknown";
  if (uncertain) {
    return {
      kind: "review",
      shortDescription: "Compatibility needs review.",
      detailDescription: compatibility.reason || "serverSENTINEL cannot fully verify server-side support for this mod."
    };
  }

  if (compatibility.compatible) {
    return {
      kind: "healthy",
      shortDescription: "Compatible with this server.",
      detailDescription: compatibility.reason || "The installed version matches this server’s Fabric and Minecraft target."
    };
  }

  return {
    kind: hasManagedMetadata ? "review" : "unknown",
    shortDescription: hasManagedMetadata ? "Compatibility needs review." : "Compatibility is unknown.",
    detailDescription: compatibility.reason || "serverSENTINEL cannot verify this mod’s compatibility."
  };
}

function hasForcedRisk(mod: InstalledMod) {
  return Boolean(
    mod.modrinth?.installedWithForceIncompatible
    || mod.modrinth?.forceIncompatible
    || mod.modrinth?.overrideMinecraftVersion
    || mod.modrinth?.incompatibilityReason
    || mod.modrinth?.overrideReason
  );
}

function hasAvailableUpdate(mod: InstalledMod) {
  return mod.versionInfo?.upToDate === false && Boolean(mod.versionInfo.latestVersion);
}

export function getInstalledModHealth(mod: InstalledMod): InstalledModHealth {
  const forcedRisk = hasForcedRisk(mod);
  const assessment = forcedRisk
    ? {
      kind: "not_recommended" as const,
      shortDescription: "This mod was installed with a compatibility override.",
      detailDescription: mod.modrinth?.overrideReason || mod.modrinth?.incompatibilityReason || "Compatibility safeguards were overridden when this mod was installed."
    }
    : compatibilityAssessment(mod.compatibility, Boolean(mod.modrinth));
  const updateAvailable = hasAvailableUpdate(mod);
  const latestVersion = mod.versionInfo?.latestVersion;

  if (assessment.kind === "not_recommended") {
    return {
      key: "not_recommended",
      label: "Not recommended",
      shortDescription: assessment.shortDescription,
      detailDescription: assessment.detailDescription,
      tone: "not-recommended",
      needsAttention: true,
      hasSafeUpdate: false,
      hasReviewUpdate: false,
      safeToRunDirectly: false
    };
  }

  if (updateAvailable && assessment.kind === "healthy") {
    return {
      key: "safe_update_available",
      label: "Update available",
      shortDescription: `A safe update${latestVersion ? ` to ${latestVersion}` : ""} is available.`,
      detailDescription: "The available update matches this server’s verified Fabric and Minecraft target.",
      tone: "update",
      needsAttention: false,
      hasSafeUpdate: true,
      hasReviewUpdate: false,
      primaryActionLabel: "Update",
      safeToRunDirectly: true
    };
  }

  if (updateAvailable && (assessment.kind === "review" || assessment.kind === "unknown")) {
    return {
      key: "review_update_available",
      label: "Review update",
      shortDescription: "An update is available, but it needs review.",
      detailDescription: `${assessment.detailDescription} Review the available update before applying it.`,
      tone: "review",
      needsAttention: true,
      hasSafeUpdate: false,
      hasReviewUpdate: true,
      primaryActionLabel: "Review update",
      safeToRunDirectly: false
    };
  }

  if (assessment.kind === "review") {
    return {
      key: "needs_review",
      label: "Needs review",
      shortDescription: assessment.shortDescription,
      detailDescription: assessment.detailDescription,
      tone: "review",
      needsAttention: true,
      hasSafeUpdate: false,
      hasReviewUpdate: false,
      safeToRunDirectly: false
    };
  }

  if (assessment.kind === "unknown") {
    return {
      key: "unknown",
      label: "Unknown",
      shortDescription: assessment.shortDescription,
      detailDescription: assessment.detailDescription,
      tone: "unknown",
      needsAttention: true,
      hasSafeUpdate: false,
      hasReviewUpdate: false,
      safeToRunDirectly: false
    };
  }

  return {
    key: "healthy",
    label: "Healthy",
    shortDescription: assessment.shortDescription,
    detailDescription: assessment.detailDescription,
    tone: "ready",
    needsAttention: false,
    hasSafeUpdate: false,
    hasReviewUpdate: false,
    safeToRunDirectly: true
  };
}

export type ModChoiceHealth = Pick<InstalledModHealth, "label" | "shortDescription" | "detailDescription" | "tone" | "safeToRunDirectly"> & {
  requiresAcknowledgement: boolean;
  primaryActionLabel: "Review and install" | "Review" | "Review risk";
};

function choiceHealth(assessment: CompatibilityAssessment): ModChoiceHealth {
  if (assessment.kind === "healthy") return { label: "Compatible", shortDescription: assessment.shortDescription, detailDescription: assessment.detailDescription, tone: "ready", safeToRunDirectly: true, requiresAcknowledgement: false, primaryActionLabel: "Review and install" };
  if (assessment.kind === "not_recommended") return { label: "Not recommended", shortDescription: assessment.shortDescription, detailDescription: assessment.detailDescription, tone: "not-recommended", safeToRunDirectly: false, requiresAcknowledgement: true, primaryActionLabel: "Review risk" };
  if (assessment.kind === "review") return { label: "Needs review", shortDescription: assessment.shortDescription, detailDescription: assessment.detailDescription, tone: "review", safeToRunDirectly: false, requiresAcknowledgement: true, primaryActionLabel: "Review" };
  return { label: "Unknown", shortDescription: assessment.shortDescription, detailDescription: assessment.detailDescription, tone: "unknown", safeToRunDirectly: false, requiresAcknowledgement: true, primaryActionLabel: "Review" };
}

export function getSearchResultHealth(mod: ModrinthHit): ModChoiceHealth {
  return choiceHealth(compatibilityAssessment(mod.compatibility, true));
}

export function getInstallVersionHealth(version: ModrinthInstallVersion): ModChoiceHealth {
  if (version.status === "recommended" || version.status === "compatible") {
    return choiceHealth({ kind: "healthy", shortDescription: "Recommended for this server.", detailDescription: version.reason || "This version matches the server target." });
  }
  if (version.status === "server_support_unknown") {
    return choiceHealth({ kind: "review", shortDescription: "Server support needs review.", detailDescription: version.reason });
  }
  return choiceHealth({ kind: "not_recommended", shortDescription: "This version is not recommended.", detailDescription: version.reason });
}

export function modVersion(mod: InstalledMod) {
  return mod.versionInfo?.currentVersion || mod.modrinth?.versionNumber || "Unknown";
}
