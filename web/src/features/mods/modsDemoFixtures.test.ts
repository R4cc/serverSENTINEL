import { describe, expect, it } from "vitest";
import { createDemoUpdatePlan } from "./modUpdatePlan";
import { demoFixtureFailureMessage, demoFixtureModrinthConfigured, modsForDemoFixture, readModsDemoFixture } from "./modsDemoFixtures";
import { filterInstalledMods } from "./modsWorkspaceHelpers";

describe("Mods demo fixtures", () => {
  it("reads only known fixture names", () => {
    expect(readModsDemoFixture("?mods-fixture=large")).toBe("large");
    expect(readModsDemoFixture("?mods-fixture=not-real")).toBe("default");
  });

  it("provides empty and realistically large installed sets", () => {
    expect(modsForDemoFixture("empty")).toEqual([]);
    const large = modsForDemoFixture("large");
    expect(large).toHaveLength(50);
    expect(new Set(large.map((mod) => mod.filename)).size).toBe(50);
    expect(filterInstalledMods(large, "Utility 42").map((mod) => mod.displayName)).toEqual(["Demo Utility 42"]);
  });

  it("covers every update-plan health state deterministically", () => {
    const mods = modsForDemoFixture("mixed");
    const plan = createDemoUpdatePlan("demo", mods, "2026-01-01T00:00:00.000Z");
    expect(plan.updates.map((entry) => entry.status)).toEqual(["safe_update", "needs_review", "blocked", "unknown", "up_to_date"]);
    expect(plan.counts).toMatchObject({ totalInstalled: 5, safeUpdates: 1, reviewUpdates: 1, blockedUpdates: 1, unknown: 1, upToDate: 1 });
    expect(mods.find((mod) => mod.displayName === "Missing Dependency Fixture")?.dependencyHealth?.missing[0].title).toBe("Cloth Config API");
  });

  it("exposes missing configuration and deterministic request failures", () => {
    expect(demoFixtureModrinthConfigured("missing-modrinth")).toBe(false);
    expect(demoFixtureFailureMessage("fail-update-plan", "update-plan")).toContain("update plan");
    expect(demoFixtureFailureMessage("fail-search", "search")).toContain("search request");
    expect(demoFixtureFailureMessage("fail-versions", "versions")).toContain("version lookup");
    expect(demoFixtureFailureMessage("fail-search", "versions")).toBe("");
    expect(demoFixtureFailureMessage("default", "search")).toBe("");
  });
});
