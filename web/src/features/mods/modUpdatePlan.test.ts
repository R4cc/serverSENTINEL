import { describe, expect, it } from "vitest";
import type { InstalledMod, ModUpdatePlan } from "../../types";
import { applyUpdatePlanEntry, canUpdateAllSafe, createDemoUpdatePlan, modUpdateCheckProgressLabel, modUpdateCheckProgressPercent, retainNewestUpdatePlan, safeUpdateRequestGroups, updatePlanEntryForMod } from "./modUpdatePlan";

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

  it("uses a cached plan as the installed row's update metadata", () => {
    const installed = mod({ versionInfo: null });
    const entry = createDemoUpdatePlan("demo", [mod()]).updates[0];
    expect(applyUpdatePlanEntry(installed, entry).versionInfo).toMatchObject({
      currentVersion: "1",
      latestVersion: "2",
      upToDate: false
    });
  });

  it("keeps plan entries matched when an installed jar is toggled disabled", () => {
    const installed = mod({ filename: "example.jar" });
    const plan = createDemoUpdatePlan("demo", [installed]);
    expect(updatePlanEntryForMod(plan, { ...installed, filename: "example.jar.disabled", enabled: false })?.filename).toBe("example.jar");
  });

  it("keeps the user-selected update channel in demo plans", () => {
    const plan = createDemoUpdatePlan("demo", [mod({
      preferredChannel: "beta",
      versionInfo: { currentVersion: "1", latestVersion: "2", latestChannel: "release", upToDate: false }
    })]);
    expect(plan.updates[0].channel).toBe("beta");
  });

  it("retains visible results until a newer successful plan is available", () => {
    const current = createDemoUpdatePlan("demo", [mod()], "2026-09-20T12:00:00.000Z");
    const older = createDemoUpdatePlan("demo", [], "2026-09-20T11:00:00.000Z");
    const newer = createDemoUpdatePlan("demo", [], "2026-09-20T13:00:00.000Z");

    expect(retainNewestUpdatePlan(current, null)).toBe(current);
    expect(retainNewestUpdatePlan(current, older)).toBe(current);
    expect(retainNewestUpdatePlan(current, newer)).toBe(newer);
  });

  it("formats measured manual-check progress", () => {
    const progress = { active: true, checked: 12, total: 28 };
    expect(modUpdateCheckProgressLabel(progress, "mods")).toBe("Checking 12/28 mods");
    expect(modUpdateCheckProgressPercent(progress)).toBeCloseTo(42.86, 2);
    expect(modUpdateCheckProgressLabel(null, "plugins")).toBe("Checking plugins…");
  });

  it("groups safe batch requests by planned channel", () => {
    const release = mod({ filename: "release.jar", displayName: "Release" });
    const beta = mod({ filename: "beta.jar", displayName: "Beta", preferredChannel: "beta" });
    const review = mod({
      filename: "review.jar",
      displayName: "Review",
      preferredChannel: "alpha",
      compatibility: { status: "unknown", compatible: false, reason: "Server-side support unknown", serverSide: "unknown" }
    });
    const plan = createDemoUpdatePlan("demo", [release, beta, review]);
    expect(safeUpdateRequestGroups(plan)).toEqual([
      { channel: "release", filenames: ["release.jar"] },
      { channel: "beta", filenames: ["beta.jar"] }
    ]);
  });

  it("shows Update all safe only when changes are allowed", () => {
    const plan = createDemoUpdatePlan("demo", [mod()]);
    expect(canUpdateAllSafe(plan, true, false)).toBe(true);
    expect(canUpdateAllSafe(plan, false, false)).toBe(false);
    expect(canUpdateAllSafe(plan, true, true)).toBe(false);
    expect(canUpdateAllSafe({ ...plan, counts: { ...plan.counts, safeUpdates: 0 } } as ModUpdatePlan, true, false)).toBe(false);
  });
});
