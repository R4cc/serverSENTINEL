import { describe, expect, it } from "vitest";
import { categoryTargets, isMissingPathError, normalizeExportSelection, worldDirectories } from "./exportSelection.js";
import type { ManagedServer } from "../types.js";

function server(runtimeType: "fabric" | "paper"): ManagedServer {
  return {
    id: "00000000-0000-4000-8000-000000000101",
    nodeId: "local",
    displayName: "Survival",
    serverDir: "/data/servers/survival",
    runtimeProfile: {
      minecraftVersion: "1.21.1",
      runtimeType,
      runtimeVersion: "1",
      javaMajorVersion: 21,
      jarProvider: runtimeType === "paper" ? "papermc" : "mcjars",
      jarArtifact: { filename: "server.jar" },
      compatibilityStatus: "compatible",
      resolvedAt: "2026-01-01T00:00:00.000Z"
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

describe("export selection", () => {
  it("resolves the content directory from the runtime rather than a fixed name", () => {
    expect(categoryTargets(server("fabric"), "content").directories).toEqual(["mods"]);
    expect(categoryTargets(server("paper"), "content").directories).toEqual(["plugins"]);
  });

  it("treats panel settings as database-only", () => {
    expect(categoryTargets(server("fabric"), "panelSettings")).toEqual({ files: [], directories: [] });
  });

  it("covers the conventional world layout when level-name is unset", () => {
    expect(categoryTargets(server("fabric"), "world").directories)
      .toEqual(["world", "world_nether", "world_the_end", "worlds"]);
  });

  it("follows a renamed level without losing the conventional fallback", () => {
    // A server with level-name=survival keeps none of its data in world/, but an unreadable
    // properties file must still produce a usable default layout.
    expect(categoryTargets(server("fabric"), "world", "survival").directories)
      .toEqual(["survival", "survival_nether", "survival_the_end", "world", "world_nether", "world_the_end", "worlds"]);
    expect(worldDirectories("  spaced  ")).toContain("spaced");
    expect(worldDirectories("world")).toEqual(["world", "world_nether", "world_the_end", "worlds"]);
    expect(worldDirectories(undefined)).toEqual(["world", "world_nether", "world_the_end", "worlds"]);
  });

  it("treats only a missing path as a non-failure", () => {
    expect(isMissingPathError(Object.assign(new Error("nope"), { code: "ENOENT" }))).toBe(true);
    // A remote node flattens filesystem errors into command_failed, keeping only the message.
    expect(isMissingPathError(new Error("ENOENT: no such file or directory, scandir '/data/world'"))).toBe(true);
    expect(isMissingPathError(Object.assign(new Error("denied"), { code: "EACCES" }))).toBe(false);
    expect(isMissingPathError(new Error("Node node-1 is offline"))).toBe(false);
    expect(isMissingPathError(undefined)).toBe(false);
  });

  it("normalizes a selection into canonical order and rejects unknown input", () => {
    expect(normalizeExportSelection({ categories: ["world", "serverConfig"], contentStrategy: "jars" }))
      .toEqual({ categories: ["serverConfig", "world"], contentStrategy: "jars" });
    expect(normalizeExportSelection({ categories: ["serverConfig", "serverConfig"] }))
      .toEqual({ categories: ["serverConfig"], contentStrategy: "lockfile" });
    expect(() => normalizeExportSelection({ categories: [] })).toThrow(/at least one category/);
    expect(() => normalizeExportSelection({ categories: ["backups"] })).toThrow(/Unknown export category/);
    expect(() => normalizeExportSelection({ categories: ["world"], contentStrategy: "torrent" }))
      .toThrow(/lockfile or jars/);
    expect(() => normalizeExportSelection({})).toThrow(/must be an array/);
  });
});
