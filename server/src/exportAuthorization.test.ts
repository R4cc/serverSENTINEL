import { describe, expect, it } from "vitest";
import { ROLE_PRESETS, normalizePermissions } from "./permissions.js";
import type { StoredUser } from "./types.js";
import {
  assertExportServerAccess,
  assertInstanceExportAllowed,
  scopedExportServerIds
} from "./exportAuthorization.js";

function roleUser(rolePreset: "viewer" | "manager" | "admin", serverIds?: string[]): StoredUser {
  return {
    id: `${rolePreset}-user`,
    username: rolePreset,
    passwordHash: "hash",
    salt: "salt",
    rolePreset,
    permissions: normalizePermissions(ROLE_PRESETS[rolePreset]),
    serverAccess: serverIds ? { mode: "selected", serverIds } : { mode: "all", serverIds: [] },
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

  it("limits selected and full exports to a server-scoped user's assignments", () => {
    const manager = roleUser("manager", ["server-2", "server-missing"]);

    expect(scopedExportServerIds(manager, undefined, ["server-1", "server-2", "server-3"]))
      .toEqual(["server-2"]);
    expect(scopedExportServerIds(manager, ["server-2"], ["server-1", "server-2", "server-3"]))
      .toEqual(["server-2"]);
    expect(() => scopedExportServerIds(manager, ["server-1"], ["server-1", "server-2", "server-3"]))
      .toThrow("do not have access");
    expect(() => assertExportServerAccess(manager, ["server-2", "server-3"]))
      .toThrow("no longer have access");
  });

  it("reserves instance-wide exports for unscoped administrators", () => {
    expect(() => assertInstanceExportAllowed(roleUser("manager"))).toThrow("manage integrations");
    expect(() => assertInstanceExportAllowed(roleUser("admin", ["server-1"]))).toThrow("Server-scoped users");
    expect(() => assertInstanceExportAllowed(roleUser("admin"))).not.toThrow();
  });
});
