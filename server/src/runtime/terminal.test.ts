import { describe, expect, it } from "vitest";
import {
  minecraftTerminalConfigFingerprint,
  minecraftTerminalContainerConfig,
  minecraftTerminalProfile
} from "./terminal.js";

describe("Minecraft runtime terminal profile", () => {
  it("advertises the capabilities rendered by the browser terminal", () => {
    expect(minecraftTerminalProfile).toEqual({
      tty: true,
      env: ["TERM=xterm-256color", "COLORTERM=truecolor"]
    });
    expect(minecraftTerminalContainerConfig()).toEqual({
      Tty: true,
      Env: ["TERM=xterm-256color", "COLORTERM=truecolor"]
    });
  });

  it("changes the runtime fingerprint when terminal capabilities change", () => {
    expect(minecraftTerminalConfigFingerprint({
      tty: true,
      env: ["TERM=xterm-256color"]
    })).not.toBe(minecraftTerminalConfigFingerprint());
  });
});
