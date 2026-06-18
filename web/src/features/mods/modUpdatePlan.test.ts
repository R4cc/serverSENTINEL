import { describe, expect, it } from "vitest";
import type { InstalledMod, ModUpdatePlan } from "../../types";
import { canUpdateAllSafe, createDemoUpdatePlan, updatePlanEntryForMod } from "./modUpdatePlan";

function mod(overrides: Partial<InstalledMod> = {}): InstalledMod {
  return {
    filename: "example.jar",
    displayName: "Example",
    enabled: true,
    size: 1,
    modifiedAt: "2026-01-01T00:00:00.000Z",
    compatibility: { status: "compatible", compatible: true, reason: "Compatible", serverSide: "optional" },
    modrinth: { projectId: "example", versionId: "v1", filename: "example.jar", versionNumber: "1", gameVersions: ["1.21.4"], loaders: ["fabric"], installedAt: "2026-01-01T00:00:00.000Z", installedWithForceIncompatible: false },
    versionInfo: { currentVersion: "1", latestVersion: "2", upToDate: false },
    ...overrides
  };
}

describe("frontend mod update plan helpers", () => {
  it("maps demo mods into coherent plan counts", () => {
    const plan = createDemoUpdatePlan("demo", [mod(), mod({ filename: "current.jar", versionInfo: { currentVersion: "1", latestVersion: "1", upToDate: true } })]);
    expect(plan.counts).toMatchObject({ totalInstalled: 2, safeUpdates: 1, upToDate: 1 });
  });

  it("maps plan entries back to installed rows", () => {
    const installed = mod();
    const plan = createDemoUpdatePlan("demo", [installed]);
    expect(updatePlanEntryForMod(plan, installed)?.status).toBe("safe_update");
  });

  it("shows Update all safe only when changes are allowed", () => {
    const plan = createDemoUpdatePlan("demo", [mod()]);
    expect(canUpdateAllSafe(plan, true, false)).toBe(true);
    expect(canUpdateAllSafe(plan, false, false)).toBe(false);
    expect(canUpdateAllSafe(plan, true, true)).toBe(false);
    expect(canUpdateAllSafe({ ...plan, counts: { ...plan.counts, safeUpdates: 0 } } as ModUpdatePlan, true, false)).toBe(false);
  });
});
