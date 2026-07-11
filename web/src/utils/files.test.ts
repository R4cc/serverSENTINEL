import { describe, expect, it } from "vitest";
import type { FileEntry } from "../types";
import { isEditableFile } from "./files";

function file(name: string, size = 100): FileEntry {
  return { name, path: `/${name}`, type: "file", size, modifiedAt: new Date(0).toISOString(), status: "ok" };
}

describe("editable file detection", () => {
  it("allows Minecraft and general text/config formats", () => {
    for (const name of ["settings.json", "server.properties", "rules.toml", "config.yml", "ops.json", "tick.mcfunction", "messages.lang", "custom.unknown-text-format"]) {
      expect(isEditableFile(file(name)), name).toBe(true);
    }
  });

  it("rejects known binary formats and files above the editor limit", () => {
    for (const name of ["mod.jar", "world.dat", "region.mca", "icon.png", "backup.zip"]) {
      expect(isEditableFile(file(name)), name).toBe(false);
    }
    expect(isEditableFile(file("large.json", 2 * 1024 * 1024 + 1))).toBe(false);
  });
});
