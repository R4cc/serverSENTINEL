import { describe, expect, it } from "vitest";
import { compareMinecraftVersions, versionSwitchContentCounts, versionSwitchOutcomeCounts, type VersionSwitchContentEntry, type VersionSwitchOutcome, type VersionSwitchPlan } from "@serversentinel/contracts";
import { versionSwitchOutcomeGroups, versionSwitchPlanGroups, versionSwitchPlanSummary } from "./versionSwitchHelpers";

function entry(action: VersionSwitchContentEntry["action"], name: string, extra: Partial<VersionSwitchContentEntry> = {}): VersionSwitchContentEntry {
  return { filename: `${name}.jar`, displayName: name, enabled: action !== "unchanged", action, currentVersion: "1.0.0", reason: `${name} reason`, ...extra };
}

function plan(content: VersionSwitchContentEntry[]): VersionSwitchPlan {
  return {
    serverId: "server-1",
    generatedAt: "2026-11-16T00:00:00.000Z",
    runtimeType: "fabric",
    current: { minecraftVersion: "1.21.1", runtimeVersion: "0.16.0" },
    target: { minecraftVersion: "1.21.4", runtimeVersion: "0.16.10" },
    direction: "upgrade",
    contentKind: "mods",
    content,
    counts: versionSwitchContentCounts(content),
    warnings: []
  };
}

describe("version switch overview", () => {
  it("leads with disabled mods and collapses the unremarkable groups", () => {
    const groups = versionSwitchPlanGroups(plan([
      entry("keep", "Fabric API"),
      entry("update", "Sodium", { targetVersion: "2.0.0" }),
      entry("disable", "Lithium"),
      entry("install", "Cloth Config", { targetVersion: "15.0.0", requiredBy: ["Mod Menu"] }),
      entry("unchanged", "Old Mod")
    ]));

    expect(groups.map((group) => [group.id, group.collapsed])).toEqual([
      ["disable", false], ["install", false], ["update", false], ["keep", true], ["unchanged", true]
    ]);
    expect(groups[0].rows[0]).toMatchObject({ name: "Lithium", detail: "Lithium reason" });
    expect(groups[1].rows[0]).toMatchObject({ fromVersion: undefined, toVersion: "15.0.0", detail: "Required by Mod Menu." });
    expect(groups[2].rows[0]).toMatchObject({ fromVersion: "1.0.0", toVersion: "2.0.0" });
  });

  it("summarizes planned changes in one line", () => {
    expect(versionSwitchPlanSummary(plan([
      entry("update", "Sodium"), entry("update", "Iris"), entry("install", "Cloth"), entry("disable", "Lithium"), entry("keep", "API")
    ]))).toBe("2 mods switch version · 1 dependency added · 1 mod disabled · 1 already compatible.");
    expect(versionSwitchPlanSummary(plan([]))).toBe("No mods installed.");
  });

  it("groups results so failures and disabled mods come first", () => {
    const switched = plan([entry("update", "Sodium", { iconUrl: "https://cdn/sodium.png" }), entry("disable", "Lithium")]);
    const outcomes: VersionSwitchOutcome[] = [
      { filename: "Sodium.jar", displayName: "Sodium", plannedAction: "update", status: "updated", version: "2.0.0" },
      { filename: "Lithium.jar", displayName: "Lithium", plannedAction: "disable", status: "disabled", reason: "No version" },
      { filename: "Iris.jar", displayName: "Iris", plannedAction: "update", status: "failed", reason: "Download failed" }
    ];
    const groups = versionSwitchOutcomeGroups(switched, outcomes);
    expect(groups.map((group) => group.id)).toEqual(["failed", "disabled", "updated"]);
    expect(groups[2].rows[0]).toMatchObject({ iconUrl: "https://cdn/sodium.png", fromVersion: "1.0.0", toVersion: "2.0.0" });
    expect(versionSwitchOutcomeCounts(outcomes)).toMatchObject({ updated: 1, disabled: 1, failed: 1 });
  });

  it("orders Minecraft versions numerically, including year-based releases", () => {
    expect(compareMinecraftVersions("1.21.10", "1.21.9")).toBeGreaterThan(0);
    expect(compareMinecraftVersions("26.1", "1.21.4")).toBeGreaterThan(0);
    expect(compareMinecraftVersions("1.21", "1.21.0")).toBe(0);
    expect(compareMinecraftVersions("1.21.4-pre1", "1.21.4")).toBeLessThan(0);
    expect(compareMinecraftVersions("1.20.6", "1.21")).toBeLessThan(0);
  });
});
