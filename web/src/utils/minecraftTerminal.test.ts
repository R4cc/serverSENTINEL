import { describe, expect, it } from "vitest";
import {
  appendCommandHistory,
  minecraftFormattingToAnsi,
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

  it("converts Minecraft formatting codes into ANSI SGR sequences for xterm", () => {
    expect(minecraftFormattingToAnsi("\u00a7aLuckPerms &lOK&r")).toBe("\x1b[38;2;85;255;85mLuckPerms \x1b[1mOK\x1b[0m");
    expect(minecraftFormattingToAnsi("&#18a6ffblue")).toBe("\x1b[38;2;24;166;255mblue");
    expect(minecraftFormattingToAnsi("plain &x")).toBe("plain &x");
  });
});
