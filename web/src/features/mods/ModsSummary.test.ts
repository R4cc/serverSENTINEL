import { describe, expect, it } from "vitest";
import type { InstalledMod } from "../../types";
import { createDemoUpdatePlan } from "./modUpdatePlan";
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
    const items = buildModsSummary([current], createDemoUpdatePlan("demo", [current]));
    expect(items[1]).toMatchObject({ value: "Up to date", detail: "No updates available" });
    expect(items[2]).toMatchObject({ value: "All clear", detail: "No action needed" });
  });

  it("counts unknown manual mods as needing attention", () => {
    const manual = mod({ filename: "manual.jar", modrinth: undefined, compatibility: undefined, versionInfo: null });
    const items = buildModsSummary([manual], createDemoUpdatePlan("demo", [manual]));
    expect(items[2]).toMatchObject({ value: 1, detail: "Review recommended" });
  });
});
