import { describe, expect, it } from "vitest";
import {
  ROLE_PRESETS,
  expandPermissions,
  inferRolePreset,
  isFullAccessUser,
  normalizePermissions,
  requirePermission
} from "./permissions.js";

describe("permission model", () => {
  it("expands preset dependencies", () => {
    expect(ROLE_PRESETS.operator).toContain("servers.control");
    expect(expandPermissions(["servers.control"])).toEqual(["servers.view", "servers.control"]);
    expect(expandPermissions(["console.command"])).toEqual(["console.view", "console.command"]);
  });

  it("normalizes duplicates and rejects unknown permission keys", () => {
    expect(normalizePermissions(["mods.install", "mods.install"])).toEqual(["mods.view", "mods.install"]);
    expect(() => normalizePermissions(["mods.install", "mods.destroy"])).toThrow("Unknown permission");
  });

  it("infers custom when permissions do not exactly match a preset", () => {
    expect(inferRolePreset(ROLE_PRESETS.viewer)).toBe("viewer");
    expect(inferRolePreset(["servers.view", "servers.control"])).toBe("custom");
  });

  it("checks required permissions against the permission array", () => {
    const user = { permissions: normalizePermissions(["servers.control"]) };
    expect(() => requirePermission("servers.control")(user)).not.toThrow();
    expect(() => requirePermission("users.manage")(user)).toThrow("You do not have permission");
  });

  it("identifies full-access admins for last-admin protection", () => {
    expect(isFullAccessUser({ permissions: normalizePermissions(ROLE_PRESETS.admin) })).toBe(true);
    expect(isFullAccessUser({ permissions: normalizePermissions(["users.manage"]) })).toBe(false);
  });
});
