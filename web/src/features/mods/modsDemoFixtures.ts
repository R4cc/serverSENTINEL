import { initialDemoMods } from "../../demo";
import type { InstalledMod } from "../../types";

const modsDemoFixtureQuery = "mods-fixture";
const modsDemoFixtureNames = ["default", "empty", "large", "mixed", "missing-modrinth", "fail-update-plan", "fail-search", "fail-versions"] as const;
export type ModsDemoFixtureName = typeof modsDemoFixtureNames[number];

export type ModsDemoFailure = "update-plan" | "search" | "versions";

export function readModsDemoFixture(search = window.location.search): ModsDemoFixtureName {
  const requested = new URLSearchParams(search).get(modsDemoFixtureQuery);
  return modsDemoFixtureNames.includes(requested as ModsDemoFixtureName) ? requested as ModsDemoFixtureName : "default";
}

function cloneMod(mod: InstalledMod): InstalledMod {
  return {
    ...mod,
    compatibility: mod.compatibility ? { ...mod.compatibility } : undefined,
    dependencyHealth: mod.dependencyHealth ? { ...mod.dependencyHealth, missing: mod.dependencyHealth.missing.map((dependency) => ({ ...dependency })) } : undefined,
    versionInfo: mod.versionInfo ? { ...mod.versionInfo } : mod.versionInfo,
    modrinth: mod.modrinth ? { ...mod.modrinth, gameVersions: [...mod.modrinth.gameVersions], loaders: [...mod.modrinth.loaders] } : undefined
  };
}

function largeMods(count = 50): InstalledMod[] {
  return Array.from({ length: count }, (_, index) => {
    const number = index + 1;
    const projectId = `demo-large-${String(number).padStart(2, "0")}`;
    const filename = `${projectId}-1.0.${number}.jar`;
    return {
      filename,
      displayName: `Demo Utility ${String(number).padStart(2, "0")}`,
      description: `Deterministic large-list fixture mod ${number}.`,
      enabled: number % 7 !== 0,
      size: 180_000 + number * 7_500,
      modifiedAt: new Date(Date.UTC(2026, 0, 1, 12, number % 60)).toISOString(),
      compatibility: { status: "compatible", compatible: true, reason: "Compatible with this server", serverSide: "optional", clientSide: "optional", matchedGameVersions: ["1.21.4"], matchedLoaders: ["fabric"] },
      versionInfo: { currentVersion: `1.0.${number}`, latestVersion: `1.0.${number}`, latestChannel: "release", upToDate: true },
      modrinth: {
        projectId,
        versionId: `${projectId}-v1`,
        filename,
        versionNumber: `1.0.${number}`,
        gameVersions: ["1.21.4"],
        loaders: ["fabric"],
        installedAt: new Date(Date.UTC(2026, 0, 1, 12, number % 60)).toISOString(),
        installedWithForceIncompatible: false
      }
    };
  });
}

function mixedHealthMods(): InstalledMod[] {
  const [upToDate, dependency, review, safe, manual] = initialDemoMods.map(cloneMod);
  return [
    { ...safe, displayName: "Safe Update Fixture" },
    {
      ...review,
      displayName: "Review Update Fixture",
      compatibility: { status: "unknown", compatible: false, reason: "Server-side support could not be verified", serverSide: "unknown", clientSide: "unknown" },
      versionInfo: { ...review.versionInfo, currentVersion: "0.3.0", latestVersion: "0.4.0", latestChannel: "release", upToDate: false }
    },
    {
      ...upToDate,
      displayName: "Blocked Update Fixture",
      compatibility: { status: "incompatible", compatible: false, reason: "Client-only mod", serverSide: "unsupported", clientSide: "required" },
      versionInfo: { ...upToDate.versionInfo, currentVersion: "3.0.3", latestVersion: "3.1.0", latestChannel: "release", upToDate: false }
    },
    { ...manual, filename: "manual-unknown-fixture.jar", displayName: "Manual Unknown Fixture", compatibility: undefined, versionInfo: null, modrinth: undefined },
    {
      ...dependency,
      displayName: "Missing Dependency Fixture",
      dependencyHealth: {
        status: "missing",
        requiredCount: 1,
        missing: [{ projectId: "cloth-config", title: "Cloth Config API" }]
      }
    }
  ];
}

export function modsForDemoFixture(fixture: ModsDemoFixtureName): InstalledMod[] {
  if (fixture === "empty") return [];
  if (fixture === "large") return largeMods();
  if (fixture === "mixed") return mixedHealthMods();
  return initialDemoMods.map(cloneMod);
}

export function demoFixtureModrinthConfigured(fixture: ModsDemoFixtureName) {
  return fixture !== "missing-modrinth";
}

export function demoFixtureFailureMessage(fixture: ModsDemoFixtureName, failure: ModsDemoFailure) {
  if (fixture !== `fail-${failure}`) return "";
  if (failure === "update-plan") return "Demo fixture: the update plan request failed.";
  if (failure === "search") return "Demo fixture: the Modrinth search request failed.";
  return "Demo fixture: version lookup failed for this project.";
}
