import { describe, expect, it } from "vitest";
import {
  appendCommandHistory,
  deleteNextTerminalWordAtCursor,
  deletePreviousTerminalWord,
  deletePreviousTerminalWordAtCursor,
  MinecraftLogStreamDecoder,
  minecraftFormattingToAnsi,
  nextTerminalWordBoundary,
  previousTerminalWordBoundary,
  recallNextCommand,
  recallPreviousCommand,
  type TerminalHistoryState
} from "./minecraftTerminal";

describe("Minecraft terminal helpers", () => {
  it("adds trimmed commands to history without empty or duplicate entries", () => {
    expect(appendCommandHistory(["say hi"], "   ")).toEqual(["say hi"]);
    expect(appendCommandHistory(["list", "say hi"], "/say hi")).toEqual(["list", "say hi"]);
    expect(appendCommandHistory(["say hi", "list"], "say hi")).toEqual(["list", "say hi"]);
  });

  it("recalls previous and next commands while preserving the typed draft", () => {
    const initial: TerminalHistoryState = { value: "sa", historyIndex: null, draft: "" };
    const previous = recallPreviousCommand(["list", "say hello"], initial);
    expect(previous).toEqual({ value: "say hello", historyIndex: 1, draft: "sa" });

    const older = recallPreviousCommand(["list", "say hello"], previous);
    expect(older).toEqual({ value: "list", historyIndex: 0, draft: "sa" });

    const newer = recallNextCommand(["list", "say hello"], older);
    expect(newer).toEqual({ value: "say hello", historyIndex: 1, draft: "sa" });

    const draft = recallNextCommand(["list", "say hello"], newer);
    expect(draft).toEqual({ value: "sa", historyIndex: null, draft: "" });
  });

  it("deletes the previous word like terminal Ctrl+Backspace", () => {
    expect(deletePreviousTerminalWord("say hello world")).toBe("say hello ");
    expect(deletePreviousTerminalWord("say hello   ")).toBe("say ");
    expect(deletePreviousTerminalWord("single")).toBe("");
    expect(deletePreviousTerminalWord("   ")).toBe("");
  });

  it("deletes the word before the cursor without changing text after it", () => {
    expect(deletePreviousTerminalWordAtCursor("say hello world", 9)).toEqual({
      value: "say  world",
      cursor: 4
    });
  });

  it("finds PowerShell-style word navigation boundaries", () => {
    expect(previousTerminalWordBoundary("say hello world", 15)).toBe(10);
    expect(previousTerminalWordBoundary("say hello   world", 12)).toBe(4);
    expect(nextTerminalWordBoundary("say hello   world", 4)).toBe(12);
    expect(nextTerminalWordBoundary("say hello", 9)).toBe(9);
  });

  it("deletes the next word like terminal Ctrl+Delete", () => {
    expect(deleteNextTerminalWordAtCursor("say hello   world", 4)).toEqual({
      value: "say world",
      cursor: 4
    });
  });

  it("converts Minecraft formatting codes into ANSI SGR sequences for xterm", () => {
    expect(minecraftFormattingToAnsi("\u00a7aLuckPerms &lOK&r")).toBe("\x1b[38;2;85;255;85mLuckPerms \x1b[1mOK\x1b[0m");
    expect(minecraftFormattingToAnsi("&#18a6ffblue")).toBe("\x1b[38;2;24;166;255mblue");
    expect(minecraftFormattingToAnsi("plain &x")).toBe("plain &x");
  });

  it("preserves ANSI and legacy formatting split across stream chunks", () => {
    const ansi = new MinecraftLogStreamDecoder();
    expect(ansi.write("\x1b[38;5;")).toBe("");
    expect(ansi.write("82mLuckPerms\x1b[0m")).toBe("");
    expect(ansi.write("\n")).toBe("\x1b[38;5;82mLuckPerms\x1b[0m\r\n");

    const legacy = new MinecraftLogStreamDecoder();
    expect(legacy.write("\u00a7")).toBe("");
    expect(legacy.write("aLuckPerms &")).toBe("");
    expect(legacy.write("lOK&r\n")).toBe("\x1b[38;2;85;255;85mLuckPerms \x1b[1mOK\x1b[0m\r\n");
  });

  it("does not invent line endings for partial chunks or duplicate split CRLF", () => {
    const decoder = new MinecraftLogStreamDecoder();
    expect(decoder.write("partial")).toBe("");
    expect(decoder.write(" line\r")).toBe("");
    expect(decoder.write("\nnext\n")).toBe("partial line\r\nnext\r\n");
  });

  it("discards pending stream text when reset before a history replay", () => {
    const decoder = new MinecraftLogStreamDecoder();
    expect(decoder.write("stale partial")).toBe("");
    decoder.reset();
    expect(decoder.write("fresh\n")).toBe("fresh\r\n");
  });
});
