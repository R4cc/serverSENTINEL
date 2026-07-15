// @ts-expect-error Vitest runs this assertion in Node, while the browser build intentionally omits Node types.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const motionStyles = readFileSync(new URL("./styles/motion.css", import.meta.url), "utf8");
const tokenStyles = readFileSync(new URL("./styles/tokens.css", import.meta.url), "utf8");
const primitiveStyles = readFileSync(new URL("./styles/primitives.css", import.meta.url), "utf8");
const serverPropertiesStyles = readFileSync(new URL("./styles/server-properties.css", import.meta.url), "utf8");
const fileManagerStyles = readFileSync(new URL("./styles/file-manager.css", import.meta.url), "utf8");
const canonicalLayoutStyles = readFileSync(new URL("./styles/canonical-layout.css", import.meta.url), "utf8");
const modsStyles = readFileSync(new URL("./styles/mods.css", import.meta.url), "utf8");

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

  it("reserves the desktop scrollbar gutter before async content changes page height", () => {
    expect(tokenStyles).toMatch(/html\s*\{[^}]*scrollbar-gutter:\s*stable;/s);
  });

  it("keeps the overview loading summary on the same six-column desktop grid", () => {
    expect(primitiveStyles).toMatch(/\.applicationSkeletonSummary\s*\{[^}]*grid-template-columns:\s*repeat\(6,/s);
    expect(primitiveStyles).toMatch(/\.applicationSkeletonWideTile\s*\{[^}]*display:\s*none;/s);
  });

  it("keeps mod loading values and scrollbars from resizing the workspace", () => {
    expect(modsStyles).toMatch(/\.modsWorkspaceMetric strong\s*\{[^}]*display:\s*flex;[^}]*min-height:\s*20px;/s);
    expect(modsStyles).toMatch(/\.modsMetricValueSkeleton\s*\{[^}]*height:\s*17px;[^}]*margin:\s*0;/s);
    expect(modsStyles).toMatch(/\.modsWorkspaceTable\s*\{[^}]*scrollbar-gutter:\s*stable;/s);
  });

  it("keeps the Files page layout owned by the file-manager stylesheet", () => {
    expect(serverPropertiesStyles).not.toMatch(/\.filesPage\s*\{/);
    expect(canonicalLayoutStyles).not.toMatch(/\.filesPage\s*\{[^}]*grid-template-columns:/s);
    expect(fileManagerStyles).toMatch(/\.filesPage\s*\{[^}]*min-height:\s*520px;/s);
  });
});
