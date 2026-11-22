import { describe, expect, it } from "vitest";
import type { InstalledMod } from "../../types";
import { buildModDependencyGraph, enabledDependents, formatModNames, reconcileDependencyHealth } from "./modDependencyGraph";

function mod(name: string, options: { projectId?: string; versionId?: string; enabled?: boolean; required?: Array<{ projectId?: string; versionId?: string }> } = {}): InstalledMod {
  const projectId = options.projectId ?? name.toLowerCase();
  return {
    filename: `${projectId}.jar`,
    displayName: name,
    enabled: options.enabled ?? true,
    size: 1,
    modifiedAt: "2026-01-01T00:00:00.000Z",
    modrinth: { projectId, versionId: options.versionId ?? `${projectId}-v1`, filename: `${projectId}.jar`, versionNumber: "1", gameVersions: [], loaders: [], installedAt: "2026-01-01T00:00:00.000Z", installedWithForceIncompatible: false },
    dependencyHealth: options.required ? { status: "satisfied", requiredCount: options.required.length, required: options.required, missing: [] } : undefined
  };
}

describe("buildModDependencyGraph", () => {
  it("links both directions by project and sorts by name", () => {
    const api = mod("Fabric API", { projectId: "fabric-api" });
    const sodium = mod("Sodium", { required: [{ projectId: "fabric-api" }] });
    const lithium = mod("Lithium", { required: [{ projectId: "fabric-api" }] });
    const graph = buildModDependencyGraph([api, sodium, lithium]);

    expect(graph.linksFor(api).requiredBy.map((item) => item.displayName)).toEqual(["Lithium", "Sodium"]);
    expect(graph.linksFor(sodium).requires).toEqual([api]);
    expect(graph.linksFor(lithium).requiredBy).toEqual([]);
  });

  it("falls back to an exact version, ignores self, duplicates and uninstalled dependencies", () => {
    const api = mod("Fabric API", { projectId: "fabric-api", versionId: "fapi-9" });
    const parent = mod("Parent", { required: [{ versionId: "fapi-9" }, { projectId: "fabric-api" }, { projectId: "parent" }, { projectId: "cloth-config" }] });
    const graph = buildModDependencyGraph([api, parent]);

    expect(graph.linksFor(parent).requires).toEqual([api]);
    expect(graph.linksFor(api).requiredBy).toEqual([parent]);
  });

  it("reports no links for manual uploads and panels without the required list", () => {
    const manual = { ...mod("Manual"), modrinth: undefined };
    const legacy = { ...mod("Legacy"), dependencyHealth: { status: "satisfied" as const, requiredCount: 1, missing: [] } };
    const graph = buildModDependencyGraph([manual, legacy]);

    expect(graph.linksFor(manual)).toEqual({ requires: [], requiredBy: [] });
    expect(graph.linksFor(legacy)).toEqual({ requires: [], requiredBy: [] });
  });

  it("counts only enabled dependents as broken by disabling a library", () => {
    const api = mod("Fabric API", { projectId: "fabric-api" });
    const on = mod("On", { required: [{ projectId: "fabric-api" }] });
    const off = mod("Off", { enabled: false, required: [{ projectId: "fabric-api" }] });

    expect(enabledDependents(buildModDependencyGraph([api, on, off]).linksFor(api))).toEqual([on]);
  });
});

describe("formatModNames", () => {
  const names = (...values: string[]) => values.map((value) => mod(value));

  it("lists short sets in full and summarizes long ones", () => {
    expect(formatModNames([])).toBe("");
    expect(formatModNames(names("A"))).toBe("A");
    expect(formatModNames(names("A", "B"))).toBe("A and B");
    expect(formatModNames(names("A", "B", "C"))).toBe("A, B and C");
    expect(formatModNames(names("A", "B", "C", "D"))).toBe("A, B and 2 more");
  });
});

describe("reconcileDependencyHealth", () => {
  it("marks dependents missing as soon as their library is disabled, and clears it when re-enabled", () => {
    const api = mod("Fabric API", { projectId: "fabric-api", enabled: false });
    const sodium = mod("Sodium", { required: [{ projectId: "fabric-api" }] });
    const [, reconciled] = reconcileDependencyHealth([api, sodium]);

    expect(reconciled.dependencyHealth).toMatchObject({ status: "missing", missing: [{ projectId: "fabric-api", title: "Fabric API", disabled: true }] });

    const enabledAgain = reconcileDependencyHealth([{ ...api, enabled: true }, reconciled]);
    expect(enabledAgain[1].dependencyHealth).toMatchObject({ status: "satisfied", missing: [] });
  });

  it("keeps uninstalled gaps and returns the same list when nothing changed", () => {
    const parent = mod("Parent", { required: [{ projectId: "cloth-config" }] });
    const withGap = { ...parent, dependencyHealth: { ...parent.dependencyHealth!, status: "missing" as const, missing: [{ projectId: "cloth-config", title: "Cloth Config" }] } };
    const mods = [mod("Fabric API", { projectId: "fabric-api" }), withGap];

    expect(reconcileDependencyHealth(mods)).toBe(mods);
  });
});
