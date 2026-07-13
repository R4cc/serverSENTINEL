import { describe, expect, it } from "vitest";
import type { InstalledMod, ModUpdatePlan } from "../../types";
import { buildModsSummary } from "./ModsSummary";

function mod(overrides: Partial<InstalledMod> = {}): InstalledMod {
  return {
    filename: "example.jar",
    displayName: "Example",
    enabled: true,
    size: 1,
    modifiedAt: "2026-01-01T00:00:00.000Z",
    compatibility: { status: "compatible", compatible: true, reason: "Compatible", serverSide: "optional" },
    modrinth: { projectId: "example", versionId: "v1", filename: "example.jar", versionNumber: "1", gameVersions: ["1.21.4"], loaders: ["fabric"], installedAt: "2026-01-01T00:00:00.000Z", installedWithForceIncompatible: false },
    versionInfo: { currentVersion: "1", latestVersion: "1", upToDate: true },
    ...overrides
  };
}

function updatePlan(mods: InstalledMod[], statuses: ModUpdatePlan["updates"][number]["status"][]): ModUpdatePlan {
  return {
    serverId: "server",
    generatedAt: "2026-01-01T00:00:00.000Z",
    counts: { totalInstalled: mods.length, safeUpdates: 0, reviewUpdates: 0, blockedUpdates: 0, upToDate: 0, unknown: 0 },
    updates: mods.map((installedMod, index) => ({
      filename: installedMod.filename,
      displayName: installedMod.displayName,
      currentFilename: installedMod.filename,
      currentVersion: installedMod.versionInfo?.currentVersion,
      channel: "release",
      status: statuses[index],
      reason: "Update check result",
      safeBatchEligible: statuses[index] === "safe_update",
      acknowledgementRequired: statuses[index] === "needs_review",
      enabled: installedMod.enabled
    }))
  };
}

describe("Mods summary", () => {
  it("uses calm copy when everything is current", () => {
    const current = mod();
    const items = buildModsSummary([current]);
    expect(items[1]).toMatchObject({ label: "Updates", value: "Up to date", tone: "green" });
    expect(items[2]).toMatchObject({ label: "Needs attention", value: "All clear" });
    expect(items[1]).not.toHaveProperty("detail");
    expect(items[2]).not.toHaveProperty("detail");
  });

  it("counts unknown manual mods as needing attention", () => {
    const manual = mod({ filename: "manual.jar", modrinth: undefined, compatibility: undefined, versionInfo: null });
    const items = buildModsSummary([manual]);
    expect(items[2]).toMatchObject({ label: "Needs attention", value: 1 });
    expect(items[2]).not.toHaveProperty("detail");
  });

  it("counts updates and attention from the visible mod statuses", () => {
    const current = mod();
    const updateAvailable = mod({
      filename: "lithium.jar",
      displayName: "Lithium",
      versionInfo: { currentVersion: "1", latestVersion: "2", upToDate: false }
    });
    const items = buildModsSummary([current, updateAvailable]);

    expect(items[1]).toMatchObject({ label: "Updates", value: 1, tone: "orange" });
    expect(items[2]).toMatchObject({ label: "Needs attention", value: "All clear" });
  });

  it("uses the update plan when cached mod metadata says the mod is current", () => {
    const cached = mod();
    const items = buildModsSummary([cached], updatePlan([cached], ["safe_update"]));

    expect(items[1]).toMatchObject({ label: "Updates", value: 1, tone: "orange" });
  });

  it("falls back to mod metadata for entries missing from an incomplete plan", () => {
    const updateAvailable = mod({
      filename: "lithium.jar",
      displayName: "Lithium",
      versionInfo: { currentVersion: "1", latestVersion: "2", upToDate: false }
    });
    const items = buildModsSummary([updateAvailable], updatePlan([], []));

    expect(items[1]).toMatchObject({ label: "Updates", value: 1, tone: "orange" });
  });
});
