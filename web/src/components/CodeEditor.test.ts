import { describe, expect, it } from "vitest";
import { EditorState, StateEffect } from "@codemirror/state";
import { getSearchQuery, SearchQuery, setSearchQuery } from "@codemirror/search";
import { editorLanguageKind, editorSearchExtension } from "./CodeEditor";

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

describe("editor search lifecycle", () => {
  it("preserves the find and replace query when the editor is reconfigured", () => {
    let state = EditorState.create({ doc: "alpha beta alpha", extensions: [editorSearchExtension] });
    state = state.update({
      effects: setSearchQuery.of(new SearchQuery({ search: "alpha", replace: "omega" }))
    }).state;
    state = state.update({ effects: StateEffect.reconfigure.of([editorSearchExtension]) }).state;

    expect(getSearchQuery(state).search).toBe("alpha");
    expect(getSearchQuery(state).replace).toBe("omega");
  });
});
