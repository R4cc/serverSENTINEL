import { describe, expect, it } from "vitest";
import type { InstalledMod, ModrinthInstallVersion, ModrinthInstallVersionsResponse } from "../../types";
import { fallbackReleaseChannel, hasInstallVersions, installedModKey, pendingRequiredDependencies, preferredInstallVersionId, safeBatchUpdateFeedback, uploadedManualMod, validateModUploadSelection } from "./modsWorkspaceHelpers";

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
});
