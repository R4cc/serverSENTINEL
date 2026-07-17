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
const responsiveStyles = readFileSync(new URL("./styles/responsive.css", import.meta.url), "utf8");
const overviewStyles = readFileSync(new URL("./styles/overview.css", import.meta.url), "utf8");

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

  it("keeps the overview loading summary on the same five-column desktop grid", () => {
    expect(primitiveStyles).toMatch(/\.applicationSkeletonSummary\s*\{[^}]*grid-template-columns:\s*repeat\(5,/s);
    expect(primitiveStyles).toMatch(/\.applicationSkeletonWideTile\s*\{[^}]*display:\s*none;/s);
  });

  it("aligns the compact automation rail with every timeline node", () => {
    expect(overviewStyles).toMatch(/\.automationTimeline::before\s*\{[^}]*top:\s*41px;[^}]*bottom:\s*41px;[^}]*left:\s*13px;/s);
    expect(overviewStyles).toMatch(/\.automationTimelineItem\s*\{[^}]*grid-template-columns:\s*20px[^}]*border:\s*var\(--border-subtle\)[^}]*padding:\s*9px 8px 9px 3px;/s);
    expect(overviewStyles).toMatch(/\.automationTimelineNow\s*\{[^}]*grid-template-columns:\s*20px[^}]*padding-left:\s*4px;/s);
    expect(overviewStyles).not.toMatch(/@container[^\{]*\{[^}]*\.automationTimeline/s);
  });

  it("expands mod update previews progressively on large overview layouts", () => {
    expect(overviewStyles).toMatch(/\.modUpdatesList\s*\{[^}]*grid-auto-rows:\s*minmax\(52px, 1fr\);[^}]*align-content:\s*stretch;/s);
    expect(overviewStyles).toMatch(/@media \(min-width: 1440px\) and \(max-width: 2559px\)\s*\{[\s\S]*?\.modUpdatesCard\s*\{[^}]*min-height:\s*136px;[\s\S]*?\.modUpdatesListItem:nth-child\(n \+ 2\),\s*\.modUpdatesRemaining\s*\{[^}]*display:\s*none;/s);
    expect(overviewStyles).toMatch(/@media \(min-width: 2560px\)\s*\{[\s\S]*?\.modUpdatesCard\s*\{[^}]*min-height:\s*280px;[\s\S]*?\.modUpdatesWide\s*\{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\);[^}]*align-content:\s*stretch;/s);
  });

  it("reserves the unified timeline for widths that can support it", () => {
    expect(overviewStyles).toContain(".overviewDashboardGrid > .serverTimelinePanel { grid-area: timeline;");
    expect(overviewStyles).toMatch(/@media \(min-width: 721px\) and \(max-width: 980px\)[\s\S]*?\.overviewDashboardGrid > \.resourcePanel \{ grid-area: resource; \}/s);
    expect(overviewStyles).toMatch(/\.serverTimelineChart\s*\{[^}]*min-height:\s*340px;/s);
    expect(overviewStyles).toMatch(/\.serverTimelineEChart\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;/s);
    expect(overviewStyles).not.toContain(".serverTimelineChart .recharts-");
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

  it("keeps phone action menus inside the edge they are aligned to", () => {
    expect(responsiveStyles).toMatch(/\.actionMenuPopover--end\s*\{[^}]*right:\s*0;[^}]*left:\s*auto;/s);
    expect(responsiveStyles).toMatch(/\.actionMenuPopover--start\s*\{[^}]*right:\s*auto;[^}]*left:\s*0;/s);
  });

  it("uses the document as the final phone scroll surface", () => {
    const nativeScrollRules = responsiveStyles.slice(responsiveStyles.lastIndexOf("/* Native document scrolling"));
    expect(nativeScrollRules).toMatch(/html,\s*body\s*\{[^}]*height:\s*auto;[^}]*overflow-y:\s*auto;/s);
    expect(nativeScrollRules).toMatch(/\.appShell,[^{]*\{[^}]*height:\s*auto;[^}]*overflow:\s*visible;/s);
    expect(nativeScrollRules).toMatch(/\.mobileNavigationOpen\.appShell\s*\{[^}]*position:\s*fixed;[^}]*inset:\s*0;/s);
    expect(nativeScrollRules).toMatch(/\.nodesPage\s*>\s*\.nodeDrawerBackdrop\s+\.nodeDrawerBody\s*\{[^}]*overflow:\s*visible;/s);
  });
});
