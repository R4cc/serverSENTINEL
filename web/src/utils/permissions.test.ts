import { describe, expect, it } from "vitest";
import type { PublicUser } from "../types";
import {
  fileManagerPermissionForPath,
  hasFileManagerPermission,
  isModsPublicPath,
  isServerPropertiesPath,
  permissionsForPreset
} from "./permissions";

function userWith(permissions: PublicUser["permissions"]): PublicUser {
  return {
    id: "user-1",
    username: "operator",
    rolePreset: "custom",
    permissions,
    createdAt: new Date(0).toISOString()
  };
}

describe("file manager permissions", () => {
  it("maps regular file actions to file permissions", () => {
    expect(fileManagerPermissionForPath("/config/server.yml", "view")).toBe("files.view");
    expect(fileManagerPermissionForPath("/config/server.yml", "download")).toBe("files.download");
    expect(fileManagerPermissionForPath("/config/server.yml", "edit")).toBe("files.edit");
    expect(fileManagerPermissionForPath("/config/server.yml", "upload")).toBe("files.upload");
    expect(fileManagerPermissionForPath("/config/server.yml", "delete")).toBe("files.delete");
  });

  it("maps mods folder actions to mod permissions", () => {
    expect(isModsPublicPath("/mods")).toBe(true);
    expect(isModsPublicPath("/mods/Fabric API.jar")).toBe(true);
    expect(fileManagerPermissionForPath("/mods/Fabric API.jar", "view")).toBe("mods.view");
    expect(fileManagerPermissionForPath("/mods/Fabric API.jar", "download")).toBe("mods.view");
    expect(fileManagerPermissionForPath("/mods/Fabric API.jar", "edit")).toBe("mods.enableDisable");
    expect(fileManagerPermissionForPath("/mods/Fabric API.jar", "upload")).toBe("mods.upload");
    expect(fileManagerPermissionForPath("/mods/Fabric API.jar", "delete")).toBe("mods.remove");
    expect(fileManagerPermissionForPath("/plugins/EssentialsX.jar", "view")).toBe("mods.view");
    expect(fileManagerPermissionForPath("/plugins/EssentialsX.jar", "upload")).toBe("mods.upload");
    expect(fileManagerPermissionForPath("/plugins/EssentialsX.jar", "delete")).toBe("mods.remove");
  });

  it("requires server settings permission to edit server.properties", () => {
    expect(isServerPropertiesPath("/server.properties")).toBe(true);
    expect(fileManagerPermissionForPath("/server.properties", "view")).toBe("files.view");
    expect(fileManagerPermissionForPath("/server.properties", "edit")).toBe("servers.editSettings");
    expect(hasFileManagerPermission(userWith(["files.view", "files.edit"]), "/server.properties", "edit")).toBe(false);
    expect(hasFileManagerPermission(userWith(["servers.view", "servers.editSettings"]), "/server.properties", "edit")).toBe(true);
  });

  it("allows an admin to edit server.properties", () => {
    const admin = { ...userWith(permissionsForPreset("admin")), rolePreset: "admin" as const };

    expect(hasFileManagerPermission(admin, "/server.properties", "edit")).toBe(true);
  });
});
