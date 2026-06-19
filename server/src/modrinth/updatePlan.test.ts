import { describe, expect, it } from "vitest";
import { createModUpdatePlan, executeSafeUpdatePlan, type ModUpdatePlanSource } from "./updatePlan.js";

function mod(overrides: Partial<ModUpdatePlanSource> = {}): ModUpdatePlanSource {
  return {
    filename: "example.jar",
    displayName: "Example",
    enabled: true,
    preferredChannel: "release",
    compatibility: { status: "compatible", compatible: true, reason: "Compatibility verified", serverSide: "optional" },
    modrinth: { projectId: "example", versionId: "v1", versionNumber: "1.0.0", installedWithForceIncompatible: false },
    versionInfo: { currentVersion: "1.0.0", latestVersion: "1.0.0", latestFilename: "example.jar", upToDate: true },
    ...overrides
  };
}

describe("mod update planning", () => {
  it("classifies a compatible current mod as up to date", () => {
    expect(createModUpdatePlan("server", [mod()]).updates[0].status).toBe("up_to_date");
  });

  it("classifies a compatible target as a safe update", () => {
    const plan = createModUpdatePlan("server", [mod({ versionInfo: { currentVersion: "1.0.0", latestVersion: "1.1.0", latestFilename: "example-1.1.jar", upToDate: false } })]);
    expect(plan.updates[0]).toMatchObject({ status: "safe_update", safeBatchEligible: true, targetVersion: "1.1.0" });
    expect(plan.counts.safeUpdates).toBe(1);
  });

  it("classifies manual mods as unknown", () => {
    expect(createModUpdatePlan("server", [mod({ modrinth: undefined, versionInfo: undefined })]).updates[0].status).toBe("unknown");
  });

  it("requires review for uncertain server support and blocks risky mods", () => {
    const plan = createModUpdatePlan("server", [
      mod({ filename: "review.jar", compatibility: { status: "unknown", compatible: false, reason: "Server-side support unknown", serverSide: "unknown" }, versionInfo: { currentVersion: "1.0.0", latestVersion: "1.1.0", upToDate: false } }),
      mod({ filename: "blocked.jar", compatibility: { status: "incompatible", compatible: false, reason: "Client-only", serverSide: "unsupported" }, versionInfo: { currentVersion: "1.0.0", latestVersion: "1.1.0", upToDate: false } })
    ]);
    expect(plan.updates.map((entry) => entry.status)).toEqual(["needs_review", "blocked"]);
  });
});

describe("safe batch updates", () => {
  it("updates only safe entries and skips review, blocked, and unknown entries", async () => {
    const plan = createModUpdatePlan("server", [
      mod({ filename: "safe.jar", versionInfo: { currentVersion: "1", latestVersion: "2", upToDate: false } }),
      mod({ filename: "review.jar", compatibility: { status: "unknown", compatible: false, serverSide: "unknown" }, versionInfo: { currentVersion: "1", latestVersion: "2", upToDate: false } }),
      mod({ filename: "blocked.jar", compatibility: { status: "incompatible", compatible: false, serverSide: "unsupported" }, versionInfo: { currentVersion: "1", latestVersion: "2", upToDate: false } }),
      mod({ filename: "manual.jar", modrinth: undefined, versionInfo: undefined })
    ]);
    const called: string[] = [];
    const result = await executeSafeUpdatePlan(plan, undefined, async (entry) => { called.push(entry.filename); return { ok: true }; });
    expect(called).toEqual(["safe.jar"]);
    expect(result.counts).toEqual({ requested: 4, updated: 1, skipped: 3, failed: 0 });
  });

  it("continues after a partial failure", async () => {
    const plan = createModUpdatePlan("server", [
      mod({ filename: "first.jar", versionInfo: { currentVersion: "1", latestVersion: "2", upToDate: false } }),
      mod({ filename: "second.jar", versionInfo: { currentVersion: "1", latestVersion: "2", upToDate: false } })
    ]);
    const result = await executeSafeUpdatePlan(plan, undefined, async (entry) => {
      if (entry.filename === "first.jar") throw new Error("network failed");
      return { ok: true };
    });
    expect(result.counts).toEqual({ requested: 2, updated: 1, skipped: 0, failed: 1 });
    expect(result.failed[0].reason).toBe("network failed");
  });

  it("reports updated, skipped, and failed entries in one deterministic batch", async () => {
    const plan = createModUpdatePlan("server", [
      mod({ filename: "updated.jar", versionInfo: { currentVersion: "1", latestVersion: "2", upToDate: false } }),
      mod({ filename: "failed.jar", versionInfo: { currentVersion: "1", latestVersion: "2", upToDate: false } }),
      mod({ filename: "blocked.jar", compatibility: { status: "incompatible", compatible: false, reason: "Client-only", serverSide: "unsupported" }, versionInfo: { currentVersion: "1", latestVersion: "2", upToDate: false } })
    ]);
    const result = await executeSafeUpdatePlan(plan, ["updated.jar", "blocked.jar", "failed.jar", "missing.jar"], async (entry) => {
      if (entry.filename === "failed.jar") throw new Error("download failed");
      return { ok: true };
    });
    expect(result.counts).toEqual({ requested: 4, updated: 1, skipped: 2, failed: 1 });
    expect(result.updated.map((entry) => entry.filename)).toEqual(["updated.jar"]);
    expect(result.skipped.map((entry) => entry.filename)).toEqual(["blocked.jar", "missing.jar"]);
    expect(result.failed).toEqual([{ filename: "failed.jar", reason: "download failed" }]);
  });
});
