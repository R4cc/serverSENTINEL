import { describe, expect, it } from "vitest";
import {
  appendCommandHistory,
  consumeTerminalTouchScroll,
  minecraftFormattingToAnsi,
  minecraftLogToTerminalText,
  recallNextCommand,
  recallPreviousCommand,
  shouldCopyTerminalSelection,
  terminalViewportAtBottom,
  type TerminalHistoryState
} from "./minecraftTerminal";

describe("Minecraft terminal helpers", () => {
  it("preserves unsupported and incomplete codes, Unicode and existing ANSI", () => {
    const text = "§k &z &#12345 §#xx1122 trailing& § 😀 \x1b[31mred\x1b[0m";
    expect(minecraftFormattingToAnsi(text)).toBe(text);
    expect(minecraftFormattingToAnsi("§Agreen&R &Oitalic&Nunderline&Mstrike"))
      .toBe("\x1b[38;2;85;255;85mgreen\x1b[0m \x1b[3mitalic\x1b[4munderline\x1b[9mstrike");
    expect(minecraftFormattingToAnsi("&&a§§L§#AABBCChex"))
      .toBe("&\x1b[38;2;85;255;85m§\x1b[1m\x1b[38;2;170;187;204mhex");
  });

  it("adds trimmed commands to history without empty or duplicate entries", () => {
    expect(appendCommandHistory(["say hi"], "   ")).toEqual(["say hi"]);
    expect(appendCommandHistory(["list", "say hi"], "/say hi")).toEqual(["list", "say hi"]);
    expect(appendCommandHistory(["say hi", "list"], "say hi")).toEqual(["list", "say hi"]);
  });

  it("copies the terminal's own selection on Ctrl+C and leaves every other copy alone", () => {
    const ctrlC = { key: "c", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false };
    const onlyTerminal = { terminal: "[12:00:00] Done (5.1s)!", input: false, document: "" };

    expect(shouldCopyTerminalSelection(ctrlC, onlyTerminal)).toBe(true);
    expect(shouldCopyTerminalSelection({ ...ctrlC, ctrlKey: false, metaKey: true }, onlyTerminal)).toBe(true);
    // Nothing selected in the terminal leaves Ctrl+C as the shell key that abandons the command line.
    expect(shouldCopyTerminalSelection(ctrlC, { ...onlyTerminal, terminal: "" })).toBe(false);
    // The browser copies what it can see itself; answering these too would copy the wrong text.
    expect(shouldCopyTerminalSelection(ctrlC, { ...onlyTerminal, input: true })).toBe(false);
    expect(shouldCopyTerminalSelection(ctrlC, { ...onlyTerminal, document: "picked with the mouse" })).toBe(false);
    expect(shouldCopyTerminalSelection({ ...ctrlC, shiftKey: true }, onlyTerminal)).toBe(false);
    expect(shouldCopyTerminalSelection({ ...ctrlC, key: "v" }, onlyTerminal)).toBe(false);
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

  it("accumulates touch movement into terminal row scrolls", () => {
    expect(consumeTerminalTouchScroll(0, 8, 20)).toEqual({ lines: 0, remainder: 8 });
    expect(consumeTerminalTouchScroll(8, 17, 20)).toEqual({ lines: 1, remainder: 5 });
    expect(consumeTerminalTouchScroll(-8, -17, 20)).toEqual({ lines: -1, remainder: -5 });
  });

  it("distinguishes the live edge from older console output", () => {
    expect(terminalViewportAtBottom(40, 40)).toBe(true);
    expect(terminalViewportAtBottom(41, 40)).toBe(true);
    expect(terminalViewportAtBottom(39, 40)).toBe(false);
  });

  it("converts Minecraft formatting codes into ANSI SGR sequences for xterm", () => {
    expect(minecraftFormattingToAnsi("\u00a7aLuckPerms &lOK&r")).toBe("\x1b[38;2;85;255;85mLuckPerms \x1b[1mOK\x1b[0m");
    expect(minecraftFormattingToAnsi("&#18a6ffblue")).toBe("\x1b[38;2;24;166;255mblue");
    expect(minecraftFormattingToAnsi("plain &x")).toBe("plain &x");
  });

  it("passes ANSI through and translates legacy formatting", () => {
    expect(minecraftLogToTerminalText("\x1b[38;5;82mLuckPerms\x1b[0m\n"))
      .toBe("\x1b[38;5;82mLuckPerms\x1b[0m\r\n");
    expect(minecraftLogToTerminalText("\u00a7aLuckPerms &lOK&r\n"))
      .toBe("\x1b[38;2;85;255;85mLuckPerms \x1b[1mOK\x1b[0m\r\n");
  });

  it("starts each row at column 0 without duplicating an existing carriage return", () => {
    expect(minecraftLogToTerminalText("first\nsecond\n")).toBe("first\r\nsecond\r\n");
    expect(minecraftLogToTerminalText("windows\r\n")).toBe("windows\r\n");
  });
});
