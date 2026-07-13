import { describe, expect, it } from "vitest";
import type { FileEntry } from "../../types";
import { fileMoveTargetPath, isFileMoveDestination, moveDemoFileTree } from "./fileMove";

function entry(path: string, type: FileEntry["type"] = "file"): FileEntry {
  return {
    name: path.split("/").filter(Boolean).at(-1) ?? path,
    path,
    type,
    size: 0,
    modifiedAt: "2026-01-01T00:00:00.000Z",
    status: "ok"
  };
}

describe("file manager move targets", () => {
  it("builds targets for folders and the root breadcrumb", () => {
    expect(fileMoveTargetPath(entry("/config/server.yml"), "/archive")).toBe("/archive/server.yml");
    expect(fileMoveTargetPath(entry("/config/server.yml"), "/")).toBe("/server.yml");
  });

  it("rejects no-op, self, and descendant folder drops", () => {
    expect(isFileMoveDestination(entry("/config/server.yml"), "/config")).toBe(false);
    expect(isFileMoveDestination(entry("/world", "directory"), "/world")).toBe(false);
    expect(isFileMoveDestination(entry("/world", "directory"), "/world/region")).toBe(false);
    expect(isFileMoveDestination(entry("/world", "directory"), "/backups")).toBe(true);
  });

  it("moves complete demo folder trees without changing unrelated files", () => {
    expect(moveDemoFileTree({
      "/config/.serversentinel-folder": "",
      "/config/app.yml": "enabled: true",
      "/config/nested/value.txt": "value",
      "/server.properties": "motd=Demo"
    }, "/config", "/archive/config")).toEqual({
      "/archive/config/.serversentinel-folder": "",
      "/archive/config/app.yml": "enabled: true",
      "/archive/config/nested/value.txt": "value",
      "/server.properties": "motd=Demo"
    });
  });
});
