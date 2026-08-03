import { describe, expect, it } from "vitest";
import { ROLE_PRESETS, normalizePermissions } from "./permissions.js";
import type { StoredUser } from "./types.js";
import { selectedExportServerIdsOrAll } from "./exportAuthorization.js";

function roleUser(rolePreset: "viewer" | "manager" | "admin"): StoredUser {
  return {
    id: `${rolePreset}-user`,
    username: rolePreset,
    passwordHash: "hash",
    salt: "salt",
    rolePreset,
    permissions: normalizePermissions(ROLE_PRESETS[rolePreset]),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

describe("export authorization", () => {
  it("assigns dedicated export permission to Manager and Admin but not Viewer", () => {
    expect(roleUser("viewer").permissions).not.toContain("servers.export");
    expect(roleUser("manager").permissions).toContain("servers.export");
    expect(roleUser("admin").permissions).toContain("servers.export");
  });

  it("normalizes a requested server selection and treats undefined as every server", () => {
    expect(selectedExportServerIdsOrAll(undefined)).toBeUndefined();
    expect(selectedExportServerIdsOrAll(["server-2", "server-2", "server-1"])).toEqual(["server-2", "server-1"]);
  });
});
