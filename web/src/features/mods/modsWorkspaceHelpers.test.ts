import { describe, expect, it } from "vitest";
import type { ModrinthInstallVersionsResponse } from "../../types";
import { fallbackReleaseChannel, hasInstallVersions, preferredInstallVersionId } from "./modsWorkspaceHelpers";

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
