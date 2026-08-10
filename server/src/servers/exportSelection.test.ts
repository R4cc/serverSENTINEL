import { describe, expect, it } from "vitest";
import { categoryTargets, collectServerCategories, isMissingPathError, measureWorldSize, normalizeExportSelection, worldDirectories } from "./exportSelection.js";
import { inaccessibleServerRootMessage, missingParentMessage, missingPathMessage } from "../core.js";
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
    // A node raises its path-safety refusal before it touches the filesystem, so the message is the
    // panel's own wording and the errno is gone by the time the protocol delivers it.
    expect(isMissingPathError(Object.assign(new Error(missingPathMessage), { code: "command_failed" }))).toBe(true);
    expect(isMissingPathError(Object.assign(new Error(missingParentMessage), { code: "command_failed" }))).toBe(true);
    expect(isMissingPathError(Object.assign(new Error("denied"), { code: "EACCES" }))).toBe(false);
    expect(isMissingPathError(new Error("Node node-1 is offline"))).toBe(false);
    expect(isMissingPathError(undefined)).toBe(false);
    // An unreadable server root is not an absent optional folder: every file would go missing from
    // the archive, so it has to fail the export rather than be skipped.
    expect(isMissingPathError(new Error(inaccessibleServerRootMessage))).toBe(false);
  });

  it("skips world folders a remote node reports as missing", async () => {
    // A node answers `files.list` for an absent dimension folder with the panel's own path-safety
    // wording, and the protocol replaces the ENOENT code with `command_failed`. Fabric keeps its
    // dimensions inside the level folder, so `world_nether` is absent on a perfectly healthy server
    // and must not fail the export.
    const listed: string[] = [];
    const runtime = {
      resolveExistingPath: async (_server: ManagedServer, path: string) => path,
      listFiles: async (_server: ManagedServer, target: string) => {
        listed.push(target);
        if (target !== "/world") {
          throw Object.assign(new Error("Path does not exist inside the managed server directory"), { code: "command_failed" });
        }
        return { path: target, entries: [{ name: "level.dat", path: "/world/level.dat", type: "file", size: 12, modifiedAt: "2026-01-01T00:00:00.000Z" }] };
      },
      readFile: async () => ({ content: "level-name=world\n" })
    } as unknown as Parameters<typeof collectServerCategories>[0];

    const [world] = await collectServerCategories(runtime, server("fabric"), ["world"]);

    expect(listed).toEqual(["/world", "/world_nether", "/world_the_end", "/worlds"]);
    expect(world.files.map((file) => file.relativePath)).toEqual(["world/level.dat"]);
    expect(world.totalBytes).toBe(12);
    expect(await measureWorldSize(runtime, server("fabric"))).toBe(12);
  });

  it("still fails the export when a node reports a real error", async () => {
    const runtime = {
      resolveExistingPath: async (_server: ManagedServer, path: string) => path,
      listFiles: async () => {
        throw Object.assign(new Error("Node node-1 is offline"), { code: "command_failed" });
      },
      readFile: async () => ({ content: "level-name=world\n" })
    } as unknown as Parameters<typeof collectServerCategories>[0];

    await expect(collectServerCategories(runtime, server("fabric"), ["world"])).rejects.toThrow(/offline/);
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
