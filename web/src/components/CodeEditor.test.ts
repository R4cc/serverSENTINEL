import { describe, expect, it } from "vitest";
import { editorLanguageKind } from "./CodeEditor";

describe("editorLanguageKind", () => {
  it("detects common Minecraft and config formats", () => {
    expect(editorLanguageKind("/world/server.properties")).toBe("properties");
    expect(editorLanguageKind("/config/app.yml")).toBe("yaml");
    expect(editorLanguageKind("/data/pack.mcmeta")).toBe("json");
    expect(editorLanguageKind("/mods/config.toml")).toBe("toml");
  });

  it("detects script formats", () => {
    expect(editorLanguageKind("/scripts/start.sh")).toBe("shell");
    expect(editorLanguageKind("/scripts/repair.ps1")).toBe("shell");
    expect(editorLanguageKind("/plugins/tool.ts")).toBe("javascript");
    expect(editorLanguageKind("/plugins/tool.jsx")).toBe("javascript");
  });

  it("falls back to plain text for unknown files", () => {
    expect(editorLanguageKind("/notes/readme.txt")).toBe("plain");
    expect(editorLanguageKind("/unknown/file")).toBe("plain");
  });
});
