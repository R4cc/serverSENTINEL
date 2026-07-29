import { describe, expect, it } from "vitest";
import { categoryTargets, normalizeExportSelection } from "./exportSelection.js";
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

  it("covers every world folder variant under one category", () => {
    expect(categoryTargets(server("fabric"), "world").directories)
      .toEqual(["world", "world_nether", "world_the_end", "worlds"]);
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
