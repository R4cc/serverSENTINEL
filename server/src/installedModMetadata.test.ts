import { describe, expect, it } from "vitest";
import { normalizeInstalledModMetadata } from "./installedModMetadata.js";

describe("installed mod metadata persistence", () => {
  it("retains the icon URL populated by an update check", () => {
    expect(normalizeInstalledModMetadata({
      projectId: "fabric-api",
      versionId: "v1",
      filename: "fabric-api.jar",
      versionNumber: "1.0.0",
      versionType: "release",
      gameVersions: ["1.21.4"],
      loaders: ["fabric"],
      installedAt: "2026-01-01T00:00:00.000Z",
      installedWithForceIncompatible: false,
      iconUrl: "/api/modrinth/icon?url=https%3A%2F%2Fcdn.modrinth.com%2Fdata%2Ffabric-api.png"
    })).toMatchObject({
      iconUrl: "/api/modrinth/icon?url=https%3A%2F%2Fcdn.modrinth.com%2Fdata%2Ffabric-api.png"
    });
  });
});
