// @ts-expect-error Vitest runs this assertion in Node, while the browser build intentionally omits Node types.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const motionStyles = readFileSync(new URL("./styles/motion.css", import.meta.url), "utf8");

describe("global stylesheet entry point", () => {
  it.each([
    "server-properties.css",
    "files-console.css",
    "schedules.css",
    "mods.css",
    "file-manager.css",
    "settings.css"
  ])("loads %s before lazy pages render", (fileName) => {
    expect(stylesheet).toContain(`@import "./styles/${fileName}";`);
  });

  it("does not animate page containers that host fixed dialogs", () => {
    expect(motionStyles).not.toContain("sentinelPageEnter");
    expect(motionStyles).not.toMatch(/\.workspace\s*>\s*\.(?:tabPage|pageStack|createServerPanel|settingsList)[^{]*\{[^}]*animation\s*:/s);
  });
});
