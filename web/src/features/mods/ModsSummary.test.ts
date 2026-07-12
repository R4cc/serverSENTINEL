import { describe, expect, it } from "vitest";
import type { InstalledMod } from "../../types";
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
});
