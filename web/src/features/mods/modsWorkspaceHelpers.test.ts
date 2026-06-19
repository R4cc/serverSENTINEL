import { describe, expect, it } from "vitest";
import type { InstalledMod, ModrinthInstallVersion, ModrinthInstallVersionsResponse } from "../../types";
import { fallbackReleaseChannel, hasInstallVersions, installedModKey, pendingRequiredDependencies, preferredInstallVersionId } from "./modsWorkspaceHelpers";

function response(): ModrinthInstallVersionsResponse {
  return {
    project: { id: "project" },
    target: { serverId: "server", serverName: "Server", minecraftVersion: "1.21.4", loader: "Fabric" },
    channel: "release",
    compatibleVersions: [],
    otherVersions: []
  };
}

describe("Mods workspace helpers", () => {
  it("keeps a stable details key when an enabled jar is renamed", () => {
    const enabled = { filename: "manual.jar" } as InstalledMod;
    const disabled = { filename: "manual.jar.disabled" } as InstalledMod;
    expect(installedModKey(enabled)).toBe(installedModKey(disabled));
  });

  it("excludes required dependencies that are already installed", () => {
    const version = {
      dependencies: [
        { projectId: "fabric-api", dependencyType: "required", title: "Fabric API" },
        { projectId: "cloth-config", dependencyType: "required", title: "Cloth Config" },
        { projectId: "optional", dependencyType: "optional", title: "Optional" }
      ]
    } as ModrinthInstallVersion;
    const installed = [{ filename: "fabric-api.jar", modrinth: { projectId: "fabric-api" } }] as InstalledMod[];
    expect(pendingRequiredDependencies(version, installed).map((dependency) => dependency.projectId)).toEqual(["cloth-config"]);
  });

  it("walks release channels in safe fallback order", () => {
    expect(fallbackReleaseChannel("release")).toBe("beta");
    expect(fallbackReleaseChannel("beta")).toBe("alpha");
    expect(fallbackReleaseChannel("alpha")).toBeNull();
  });

  it("detects versions in either visible group", () => {
    expect(hasInstallVersions(response())).toBe(false);
    expect(hasInstallVersions({ ...response(), otherVersions: [{ id: "other" } as never] })).toBe(true);
  });

  it("prefers the recommended version over list order", () => {
    const base = { id: "first", status: "compatible" } as never;
    const recommended = { id: "recommended", status: "recommended" } as never;
    expect(preferredInstallVersionId({ ...response(), compatibleVersions: [base, recommended] })).toBe("recommended");
  });
});
