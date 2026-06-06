import { describe, expect, it } from "vitest";
import { parseConsoleText, stripConsoleFormatting } from "./consoleFormatting";

describe("console formatting", () => {
  it("renders ANSI SGR colors and reset without raw escape characters", () => {
    const lines = parseConsoleText(["[docker] \u001b[32mBetter Fabric Console\u001b[0m ready"]);

    expect(lines[0].map((segment) => segment.text).join("")).toBe("[docker] Better Fabric Console ready");
    expect(lines[0].some((segment) => segment.text === "Better Fabric Console" && segment.style.color === "#55ff55")).toBe(true);
    expect(stripConsoleFormatting("\u001b[31merror\u001b[0m")).toBe("error");
  });

  it("keeps ANSI formatting across chunked websocket messages", () => {
    const lines = parseConsoleText(["[docker] \u001b[38;2;42;", "180;90mLuckPerms", " loaded\u001b[0m"]);

    expect(lines[0].map((segment) => segment.text).join("")).toBe("[docker] LuckPerms loaded");
    expect(lines[0].some((segment) => segment.text === "LuckPerms" && segment.style.color === "rgb(42 180 90)")).toBe(true);
    expect(lines[0].flatMap((segment) => segment.text).join("")).not.toContain("\u001b");
  });

  it("keeps separately stored plain lines readable", () => {
    const lines = parseConsoleText(["[demo] first\n", "[demo] second\n"]);

    expect(lines[0].map((segment) => segment.text).join("")).toBe("[demo] first");
    expect(lines[1].map((segment) => segment.text).join("")).toBe("[demo] second");
  });

  it("supports Minecraft section and ampersand formatting codes", () => {
    const lines = parseConsoleText(["[latest.log] \u00a7aLuckPerms &lOK&r plain &x"]);

    expect(lines[0].map((segment) => segment.text).join("")).toBe("[latest.log] LuckPerms OK plain &x");
    expect(lines[0].some((segment) => segment.text === "LuckPerms " && segment.style.color === "#55ff55")).toBe(true);
    expect(lines[0].some((segment) => segment.text === "OK" && segment.style.fontWeight === 800)).toBe(true);
  });

  it("supports Minecraft hex colors without treating plain hash text as formatting", () => {
    const lines = parseConsoleText(["&#18a6ffblue #123456 literal"]);

    expect(lines[0].map((segment) => segment.text).join("")).toBe("blue #123456 literal");
    expect(lines[0][0].style.color).toBe("#18a6ff");
  });
});
