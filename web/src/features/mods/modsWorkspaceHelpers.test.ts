import { describe, expect, it } from "vitest";
import type { InstalledMod, ModrinthHit, ModrinthInstallVersion, ModrinthInstallVersionsResponse } from "../../types";
import { buildModrinthSearchPath, fallbackReleaseChannel, filterDemoSearchResults, hasInstallVersions, installedModKey, pendingRequiredDependencies, preferredInstallVersionId, safeBatchUpdateFeedback, selectedInstallFlags, uploadedManualMod, validateModUploadSelection } from "./modsWorkspaceHelpers";

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

  it("excludes required dependencies that match an installed version id", () => {
    const version = {
      dependencies: [
        { versionId: "fabric-api-1.0.0", dependencyType: "required", title: "Fabric API" },
        { versionId: "cloth-config-1.0.0", dependencyType: "required", title: "Cloth Config" }
      ]
    } as ModrinthInstallVersion;
    const installed = [{ filename: "fabric-api.jar", modrinth: { versionId: "fabric-api-1.0.0" } }] as InstalledMod[];
    expect(pendingRequiredDependencies(version, installed).map((dependency) => dependency.versionId)).toEqual(["cloth-config-1.0.0"]);
  });

  it("covers upload cancellation, validation, duplicates, and successful manual metadata", () => {
    const installed = [{ filename: "existing.jar" }, { filename: "disabled.jar.disabled" }] as InstalledMod[];
    expect(validateModUploadSelection(undefined, installed)).toEqual({ kind: "cancelled" });
    expect(validateModUploadSelection({ name: "not-a-jar.txt", size: 10 }, installed)).toMatchObject({ kind: "error" });
    expect(validateModUploadSelection({ name: "empty.jar", size: 0 }, installed)).toMatchObject({ kind: "error" });
    expect(validateModUploadSelection({ name: "too-large.jar", size: 128 * 1024 * 1024 + 1 }, installed)).toMatchObject({ kind: "error" });
    expect(validateModUploadSelection({ name: "existing.jar", size: 10 }, installed)).toMatchObject({ kind: "error", message: "A mod with that filename is already installed." });
    expect(validateModUploadSelection({ name: "disabled.jar", size: 10 }, installed)).toMatchObject({ kind: "error", message: "A mod with that filename is already installed." });
    const ready = validateModUploadSelection({ name: "new-helper.jar", size: 2048 }, installed);
    expect(ready).toMatchObject({ kind: "ready" });
    expect(uploadedManualMod({ name: "new-helper.jar", size: 2048 }, "2026-01-01T00:00:00.000Z")).toMatchObject({ filename: "new-helper.jar", displayName: "new helper", enabled: true, size: 2048 });
  });

  it("summarizes safe batch success and partial results clearly", () => {
    expect(safeBatchUpdateFeedback({ updated: [{} as never], skipped: [], failed: [], counts: { requested: 1, updated: 1, skipped: 0, failed: 0 } })).toMatchObject({ status: "succeeded", title: "1 safe mod updated", summary: "1 updated · 0 skipped · 0 failed" });
    expect(safeBatchUpdateFeedback({ updated: [{} as never], skipped: [{} as never], failed: [{} as never], counts: { requested: 3, updated: 1, skipped: 1, failed: 1 } })).toMatchObject({ status: "failed", title: "Safe updates partially completed", summary: "1 updated · 1 skipped · 1 failed" });
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

  it("builds compatible search requests by default and all-results requests for the risky toggle", () => {
    expect(buildModrinthSearchPath({ query: "fabric api", serverId: "server-1", showIncompatibleResults: false })).toBe("/api/modrinth/search?query=fabric+api&serverId=server-1&channel=release&compatibility=compatible");
    expect(buildModrinthSearchPath({ query: "api", serverId: "server-1", showIncompatibleResults: true })).toBe("/api/modrinth/search?query=api&serverId=server-1&channel=release&compatibility=all");
    expect(buildModrinthSearchPath({ query: "api", serverId: "server-1", showIncompatibleResults: true, offset: 20, limit: 20 })).toContain("offset=20&limit=20");
  });

  it("uses an offset-free all-results request when the compatibility toggle refreshes search", () => {
    expect(buildModrinthSearchPath({ query: "api", serverId: "server-1", showIncompatibleResults: true })).not.toContain("offset=");
  });

  it("hides non-compatible demo search results until risky matches are enabled", () => {
    const results = [
      { project_id: "safe", title: "Safe", description: "", downloads: 1, compatibility: { compatible: true } },
      { project_id: "old", title: "Old", description: "", downloads: 1, compatibility: { compatible: false } },
      { project_id: "unknown", title: "Unknown", description: "", downloads: 1, compatibility: { compatible: false, status: "unknown" } }
    ] as ModrinthHit[];
    expect(filterDemoSearchResults(results, false).map((mod) => mod.project_id)).toEqual(["safe"]);
    expect(filterDemoSearchResults(results, true).map((mod) => mod.project_id)).toEqual(["safe", "old", "unknown"]);
  });

  it("sends explicit override flags only for selected versions that need them", () => {
    expect(selectedInstallFlags({ compatible: true, requiresMinecraftAcknowledgement: false } as ModrinthInstallVersion)).toEqual({ forceIncompatible: false, overrideMinecraftVersion: false });
    expect(selectedInstallFlags({ compatible: false, requiresMinecraftAcknowledgement: true } as ModrinthInstallVersion)).toEqual({ forceIncompatible: true, overrideMinecraftVersion: true });
    expect(selectedInstallFlags({ compatible: false, requiresMinecraftAcknowledgement: false } as ModrinthInstallVersion)).toEqual({ forceIncompatible: true, overrideMinecraftVersion: false });
  });
});
