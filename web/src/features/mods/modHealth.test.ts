import { describe, expect, it } from "vitest";
import type { InstalledMod, ModCompatibility } from "../../types";
import { getInstalledModHealth } from "./modHealth";

const compatible: ModCompatibility = {
  status: "compatible",
  compatible: true,
  reason: "Compatible with this server",
  serverSide: "optional",
  clientSide: "optional"
};

function managedMod(overrides: Partial<InstalledMod> = {}): InstalledMod {
  return {
    filename: "example.jar",
    displayName: "Example",
    enabled: true,
    size: 1024,
    modifiedAt: "2026-01-01T00:00:00.000Z",
    compatibility: compatible,
    modrinth: {
      projectId: "example",
      versionId: "v1",
      filename: "example.jar",
      versionNumber: "1.0.0",
      gameVersions: ["1.21.4"],
      loaders: ["fabric"],
      installedAt: "2026-01-01T00:00:00.000Z",
      installedWithForceIncompatible: false
    },
    versionInfo: { currentVersion: "1.0.0", upToDate: true },
    ...overrides
  };
}

describe("getInstalledModHealth", () => {
  it("marks a compatible current mod as healthy", () => {
    expect(getInstalledModHealth(managedMod()).key).toBe("healthy");
  });

  it("offers a direct safe update for a compatible mod", () => {
    const health = getInstalledModHealth(managedMod({ versionInfo: { currentVersion: "1.0.0", latestVersion: "1.1.0", upToDate: false } }));
    expect(health).toMatchObject({ key: "safe_update_available", hasSafeUpdate: true, recommendedAction: "update", safeToRunDirectly: true });
  });

  it("does not treat missing update metadata as attention", () => {
    const health = getInstalledModHealth(managedMod({ versionInfo: null }));
    expect(health).toMatchObject({ key: "healthy", needsAttention: false, hasSafeUpdate: false, hasReviewUpdate: false });
  });

  it("requires review when an update exists for an uncertain mod", () => {
    const health = getInstalledModHealth(managedMod({
      compatibility: { ...compatible, status: "unknown", reason: "Server-side support unknown", serverSide: "unknown" },
      versionInfo: { currentVersion: "1.0.0", latestVersion: "1.1.0", upToDate: false }
    }));
    expect(health).toMatchObject({ key: "review_update_available", hasReviewUpdate: true, recommendedAction: "review_update", safeToRunDirectly: false });
  });

  it("marks unknown server-side support as needing review", () => {
    expect(getInstalledModHealth(managedMod({ compatibility: { ...compatible, status: "unknown", serverSide: "unknown" } })).key).toBe("needs_review");
  });

  it("marks an unidentified manual upload as unknown", () => {
    const mod = managedMod({ modrinth: undefined, compatibility: undefined, versionInfo: null });
    expect(getInstalledModHealth(mod)).toMatchObject({ key: "unknown", recommendedAction: "review_mod" });
  });

  it("marks client-only or server-unsupported mods as not recommended", () => {
    const health = getInstalledModHealth(managedMod({ compatibility: { ...compatible, compatible: false, status: "incompatible", reason: "Client-only mod", serverSide: "unsupported", clientSide: "required" } }));
    expect(health).toMatchObject({ key: "not_recommended", recommendedAction: "remove_or_disable" });
  });

  it("marks a Minecraft version mismatch as not recommended", () => {
    const health = getInstalledModHealth(managedMod({ compatibility: { ...compatible, compatible: false, status: "no_minecraft_version", reason: "Not marked for Minecraft 1.21.4" } }));
    expect(health.key).toBe("not_recommended");
  });

  it("keeps a force-installed mod not recommended even with otherwise compatible metadata", () => {
    const base = managedMod();
    const health = getInstalledModHealth({ ...base, modrinth: { ...base.modrinth!, installedWithForceIncompatible: true, incompatibilityReason: "Version mismatch acknowledged" } });
    expect(health).toMatchObject({ key: "not_recommended", safeToRunDirectly: false });
  });

  it("does not change health solely because a mod is disabled", () => {
    expect(getInstalledModHealth(managedMod({ enabled: false })).key).toBe("healthy");
  });
});
