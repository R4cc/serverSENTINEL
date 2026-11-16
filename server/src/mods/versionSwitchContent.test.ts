import { describe, expect, it } from "vitest";
import { planVersionSwitchContent, type VersionSwitchInstalledContent, type VersionSwitchLookups } from "./versionSwitchContent.js";
import type { ModrinthVersion } from "../types.js";

const context = {
  minecraftVersion: "1.21.4",
  loaders: ["fabric"],
  runtimeName: "Fabric",
  versionMatches: (gameVersions: string[], minecraftVersion: string) => gameVersions.includes(minecraftVersion),
  iconUrl: (url?: string | null) => url ?? undefined
};

function version(projectId: string, id: string, dependencies: string[] = []): ModrinthVersion {
  return {
    id,
    project_id: projectId,
    version_number: id,
    version_type: "release",
    game_versions: ["1.21.4"],
    loaders: ["fabric"],
    files: [{ url: `https://cdn.modrinth.com/${id}.jar`, filename: `${projectId}-${id}.jar`, primary: true }],
    dependencies: dependencies.map((project_id) => ({ project_id, dependency_type: "required" }))
  };
}

function mod(projectId: string, options: Partial<VersionSwitchInstalledContent> & { gameVersions?: string[] } = {}): VersionSwitchInstalledContent {
  return {
    filename: `${projectId}.jar`,
    enabled: true,
    channel: "release",
    metadata: {
      projectId,
      versionId: `${projectId}-old`,
      versionNumber: "1.0.0",
      gameVersions: options.gameVersions ?? ["1.21.1"],
      loaders: ["fabric"]
    },
    ...options
  };
}

function lookups(targets: Record<string, ModrinthVersion | undefined>, installedVersions: Record<string, ModrinthVersion> = {}): VersionSwitchLookups {
  return {
    latestForTarget: async (projectId) => targets[projectId],
    versions: async (ids) => new Map(ids.flatMap((id) => installedVersions[id] ? [[id, installedVersions[id]] as const] : [])),
    projects: async (ids) => new Map(ids.map((id) => [id, { id, title: `${id[0].toUpperCase()}${id.slice(1)}` }] as const))
  };
}

describe("planVersionSwitchContent", () => {
  it("updates mods with a version for the target and disables those without one", async () => {
    const plan = await planVersionSwitchContent(
      [mod("sodium"), mod("lithium")],
      context,
      lookups({ sodium: version("sodium", "2.0.0") })
    );
    const byProject = Object.fromEntries(plan.map((entry) => [entry.projectId, entry]));

    expect(byProject.sodium).toMatchObject({ action: "update", targetVersion: "2.0.0", targetFilename: "sodium-2.0.0.jar", displayName: "Sodium" });
    expect(byProject.lithium).toMatchObject({ action: "disable", displayName: "Lithium" });
    expect(byProject.lithium.reason).toContain("No Fabric version for Minecraft 1.21.4");
    // Disabled mods lead, so the overview opens on what needs attention.
    expect(plan[0].projectId).toBe("lithium");
  });

  it("keeps a mod whose installed version already supports the target", async () => {
    const plan = await planVersionSwitchContent(
      [mod("fabric-api", { gameVersions: ["1.21.1", "1.21.4"] })],
      context,
      lookups({})
    );
    expect(plan).toMatchObject([{ action: "keep", targetVersion: "1.0.0" }]);
  });

  it("disables unidentified jars and leaves already disabled ones alone", async () => {
    const plan = await planVersionSwitchContent(
      [
        { filename: "custom.jar", enabled: true, channel: "release" },
        { filename: "old.jar.disabled", enabled: false, channel: "release" },
        mod("lithium", { filename: "lithium.jar.disabled", enabled: false })
      ],
      context,
      lookups({})
    );
    expect(plan.find((entry) => entry.filename === "custom.jar")).toMatchObject({ action: "disable" });
    expect(plan.find((entry) => entry.filename === "old.jar.disabled")).toMatchObject({ action: "unchanged" });
    expect(plan.find((entry) => entry.filename === "lithium.jar.disabled")).toMatchObject({ action: "unchanged" });
  });

  it("treats a failed lookup as an issue and disables the mod", async () => {
    const plan = await planVersionSwitchContent([mod("sodium")], context, {
      ...lookups({}),
      latestForTarget: async () => { throw new Error("Modrinth request timed out"); }
    });
    expect(plan[0].action).toBe("disable");
    expect(plan[0].reason).toContain("Modrinth request timed out");
  });

  it("installs a newly required dependency that is available for the target", async () => {
    const plan = await planVersionSwitchContent(
      [mod("iris")],
      context,
      lookups({ iris: version("iris", "1.8.0", ["sodium"]), sodium: version("sodium", "0.6.0") })
    );
    expect(plan.find((entry) => entry.projectId === "sodium")).toMatchObject({
      action: "install",
      targetVersionId: "0.6.0",
      requiredBy: ["Iris"]
    });
    expect(plan.find((entry) => entry.projectId === "iris")?.action).toBe("update");
  });

  it("cascades a disable to mods whose required dependency is disabled", async () => {
    const plan = await planVersionSwitchContent(
      [mod("fabric-api"), mod("modmenu")],
      context,
      lookups({ modmenu: version("modmenu", "12.0.0", ["fabric-api"]) })
    );
    const modmenu = plan.find((entry) => entry.projectId === "modmenu");
    expect(modmenu).toMatchObject({ action: "disable", targetVersionId: undefined });
    expect(modmenu?.reason).toBe("Requires Fabric-api, which this switch disables.");
  });

  it("disables a mod whose new dependency has no target version, and installs nothing for it", async () => {
    const plan = await planVersionSwitchContent(
      [mod("iris")],
      context,
      lookups({ iris: version("iris", "1.8.0", ["sodium"]) })
    );
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ action: "disable" });
    expect(plan[0].reason).toBe("Requires Sodium, which has no Minecraft 1.21.4 version.");
  });

  it("drops a new dependency whose own dependency is unavailable and disables what needed it", async () => {
    const plan = await planVersionSwitchContent(
      [mod("iris")],
      context,
      lookups({ iris: version("iris", "1.8.0", ["sodium"]), sodium: version("sodium", "0.6.0", ["missing-lib"]) })
    );
    expect(plan.map((entry) => [entry.projectId, entry.action])).toEqual([["iris", "disable"]]);
  });

  it("checks a kept mod's dependencies against what the switch disables", async () => {
    const kept = mod("modmenu", { gameVersions: ["1.21.4"] });
    const plan = await planVersionSwitchContent(
      [kept, mod("fabric-api")],
      context,
      lookups({}, { "modmenu-old": version("modmenu", "modmenu-old", ["fabric-api"]) })
    );
    expect(plan.find((entry) => entry.projectId === "modmenu")?.action).toBe("disable");
  });
});
