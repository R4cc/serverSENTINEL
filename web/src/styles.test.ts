// @ts-expect-error Vitest runs this assertion in Node, while the browser build intentionally omits Node types.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const fontStyles = readFileSync(new URL("./styles/fonts.css", import.meta.url), "utf8");
const minecraftTerminal = readFileSync(new URL("./components/MinecraftTerminal.tsx", import.meta.url), "utf8");
const motionStyles = readFileSync(new URL("./styles/motion.css", import.meta.url), "utf8");
const tokenStyles = readFileSync(new URL("./styles/tokens.css", import.meta.url), "utf8");
const primitiveStyles = readFileSync(new URL("./styles/primitives.css", import.meta.url), "utf8");
const serverPropertiesStyles = readFileSync(new URL("./styles/server-properties.css", import.meta.url), "utf8");
const filesConsoleStyles = readFileSync(new URL("./styles/files-console.css", import.meta.url), "utf8");
const fileManagerStyles = readFileSync(new URL("./styles/file-manager.css", import.meta.url), "utf8");
const canonicalLayoutStyles = readFileSync(new URL("./styles/canonical-layout.css", import.meta.url), "utf8");
const modsStyles = readFileSync(new URL("./styles/mods.css", import.meta.url), "utf8");
const responsiveStyles = readFileSync(new URL("./styles/responsive.css", import.meta.url), "utf8");
const overviewStyles = readFileSync(new URL("./styles/overview.css", import.meta.url), "utf8");
const authStyles = readFileSync(new URL("./styles/auth.css", import.meta.url), "utf8");

describe("global stylesheet entry point", () => {
  it("loads the design system in an intentional cascade", () => {
    const orderedImports = [
      './styles/tokens.css',
      './styles/themes.css',
      './styles/typography.css',
      './styles/primitives.css',
      './styles/canonical-layout.css',
      './styles/layout.css',
      './styles/mods.css',
      './styles/responsive.css',
      './styles/motion.css'
    ];

    const positions = orderedImports.map((entry) => stylesheet.indexOf(entry));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(stylesheet).not.toContain("core-adoption.css");
  });

  it("keeps global primitives in the shared primitive stylesheet", () => {
    expect(primitiveStyles).toContain(".uiSurface");
    expect(primitiveStyles).toContain(".uiToolbar");
    expect(primitiveStyles).toContain(".uiFormField");
    expect(primitiveStyles).toContain(".uiBanner");
    expect(primitiveStyles).toContain(".uiMetricTile");
    expect(modsStyles).not.toContain("Shared UI foundation");
    expect(modsStyles).not.toMatch(/(^|\n)\.uiButton--primary\s*\{/);
    expect(modsStyles).not.toMatch(/#[0-9a-fA-F]{3,8}|rgba?\(/);
    expect(authStyles).not.toMatch(/:root\.themeDark[\s\S]*?--surface:/);
  });

  it("uses vertical disclosure arrows for the mobile top navigation", () => {
    expect(responsiveStyles).toMatch(/@media \(max-width: 720px\)\s*\{\s*\.sidebarToggleIconDesktop\s*\{[^}]*display:\s*none;[^}]*\}\s*\.sidebarToggleIconMobile\s*\{[^}]*display:\s*inline-flex;/s);
  });

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
    expect(motionStyles).not.toMatch(/\.workspace\s*>\s*\.(?:tabPage|pageStack|createServerPanel)[^{]*\{[^}]*animation\s*:/s);
  });

  it("reserves the desktop scrollbar gutter before async content changes page height", () => {
    expect(tokenStyles).toMatch(/html\s*\{[^}]*scrollbar-gutter:\s*stable;/s);
  });

  it("bundles JetBrains Mono specifically for the Console", () => {
    expect(fontStyles).toMatch(/font-family:\s*"JetBrains Mono";[\s\S]*?jetbrains-mono-400\.woff2/);
    expect(tokenStyles).toMatch(/--font-console:\s*"JetBrains Mono",\s*var\(--font-mono\);/);
    expect(filesConsoleStyles).toMatch(/\.terminal\s*\{[^}]*font-family:\s*var\(--font-console\);/s);
    expect(minecraftTerminal).toContain('getPropertyValue("--font-console")');
  });

  it("keeps the overview loading skeleton on the final seven-metric desktop geometry", () => {
    expect(primitiveStyles).toMatch(/@media \(min-width: 981px\)\s*\{[\s\S]*?\.applicationSkeletonSummary\s*\{[^}]*grid-template-columns:\s*repeat\(7,/s);
    expect(primitiveStyles).toMatch(/@media \(min-width: 981px\)\s*\{[\s\S]*?\.applicationSkeletonWideTile\s*\{[^}]*display:\s*block;/s);
    expect(primitiveStyles).toMatch(/\.applicationOverviewPanelGrid\s*\{[^}]*"players players players players players mods mods mods mods mods mods mods"[^}]*"players players players players players automation automation automation automation automation automation automation"/s);
  });

  it("keeps upcoming schedules in a compact borderless list", () => {
    expect(overviewStyles).toMatch(/\.scheduleUpcomingItem\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto 16px;[^}]*border:\s*0;[^}]*border-bottom:\s*var\(--border-subtle\)[^}]*background:\s*transparent;/s);
    expect(overviewStyles).toMatch(/\.scheduleUpcomingMore\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent;/s);
    expect(overviewStyles).not.toContain(".automationTimeline");
  });

  it("leaves room for descenders in truncated overview metric values", () => {
    expect(overviewStyles).toMatch(
      /\.overviewSummary \.uiMetricTileCopy > strong\s*\{[^}]*overflow:\s*hidden;[^}]*padding-bottom:\s*2px;[^}]*text-overflow:\s*ellipsis;/s
    );
  });

  it("uses pointer-positioned glow colors for every overview status family", () => {
    expect(overviewStyles).toMatch(/\.overviewSummary \.statusGlowTile\s*\{[^}]*cursor:\s*default;/s);
    expect(overviewStyles).toMatch(/\.statusGlowTile\.running\s*\{\s*--status-glow-color:\s*var\(--sentinel-success\);/s);
    expect(overviewStyles).toMatch(/\.statusGlowTile\.warning\s*\{\s*--status-glow-color:\s*var\(--sentinel-warning\);/s);
    expect(overviewStyles).toMatch(/\.statusGlowTile\.stopped,\s*\.overviewSummary \.statusGlowTile\.danger\s*\{\s*--status-glow-color:\s*var\(--sentinel-danger\);/s);
    expect(overviewStyles).toMatch(/\.statusGlowTile::before\s*\{[^}]*display:\s*block;[^}]*z-index:\s*0;[^}]*radial-gradient\(\s*circle 150px at var\(--status-glow-x\) var\(--status-glow-y\)/s);
    expect(overviewStyles).toMatch(/\.statusGlowTile > \.uiMetricTileMarker,\s*\.overviewSummary \.statusGlowTile > \.uiMetricTileCopy\s*\{[^}]*z-index:\s*1;/s);
    expect(overviewStyles).toMatch(/\.statusGlowTile:hover,\s*\.overviewSummary \.statusGlowTile\[data-glow-active="true"\]\s*\{[^}]*translateY\(-2px\)[^}]*rotateX\(var\(--status-tilt-x\)\)/s);
    expect(overviewStyles).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.statusGlowTile\[data-glow-active="true"\],[\s\S]*?transform:\s*none;/s);
  });

  it("keeps upcoming schedule hover states subtle with clean outer corners", () => {
    expect(overviewStyles).toMatch(/\.scheduleUpcomingItem:first-child\s*\{[^}]*border-radius:\s*var\(--radius-sm\) var\(--radius-sm\) 0 0;/s);
    expect(overviewStyles).toMatch(/\.scheduleUpcomingItem:last-child\s*\{[^}]*border-radius:\s*0 0 var\(--radius-sm\) var\(--radius-sm\);/s);
    expect(overviewStyles).toMatch(/\.scheduleUpcomingItem:only-child\s*\{[^}]*border-radius:\s*var\(--radius-sm\);/s);
    expect(overviewStyles).toMatch(/\.scheduleUpcomingItem:hover:not\(:disabled\)\s*\{[^}]*background:\s*color-mix\(in srgb, var\(--sentinel-accent-soft\) 54%, var\(--surface-raised\)\);[^}]*color:\s*var\(--text\);[^}]*transform:\s*none;/s);
  });

  it("uses one desktop card and row language without obsolete Mods branches", () => {
    expect(overviewStyles).toMatch(/\.overviewCard\s*\{[^}]*border-color:\s*var\(--border-panel\);[^}]*border-radius:\s*var\(--radius-md\);[^}]*box-shadow:\s*none;/s);
    expect(overviewStyles).toMatch(/\.modUpdatesList\s*\{[^}]*grid-auto-rows:\s*52px;[^}]*align-content:\s*start;/s);
    expect(overviewStyles).toMatch(/\.modUpdatesListItem\s*\{[^}]*grid-template-columns:\s*36px minmax\(0, 1fr\) 16px;[^}]*border-bottom:\s*var\(--border-subtle\) solid var\(--border-muted\);[^}]*background:\s*transparent;[^}]*padding:\s*7px 2px;/s);
    expect(overviewStyles).toMatch(/\.modUpdatesListCopy > strong\s*\{[^}]*line-height:\s*17px;/s);
    expect(overviewStyles).toMatch(/\.modUpdatesListItem,\s*\.scheduleUpcomingItem\s*\{[^}]*min-height:\s*52px;[^}]*height:\s*52px;/s);
    expect(overviewStyles).not.toContain("modUpdatesCardOpen");
    expect(overviewStyles).not.toContain("modUpdatesCompact");
    expect(overviewStyles).not.toContain("modUpdatesWide");
    expect(overviewStyles).not.toContain("modUpdatesRefreshLabel");
  });

  it("uses the full desktop width for support cards after the timeline replaces Active Players", () => {
    expect(overviewStyles).toMatch(/@media \(min-width: 981px\)\s*\{[\s\S]*?"support support support support support support support support support support support support"/s);
    expect(overviewStyles).toMatch(/\.overviewSupportStack\s*\{[^}]*grid-area:\s*support;[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/s);
    expect(overviewStyles).toMatch(/\.overviewPage \.eventsPanel \.eventRow,\s*[\s\S]*?\.eventRow\.eventKind--player_reconnected\s*\{[^}]*border-color:\s*var\(--border-row\);[^}]*background:\s*transparent;/s);
    expect(overviewStyles).toMatch(/\.overviewPage \.eventsPanel \.eventRow\.error\s*\{[^}]*background:\s*color-mix\(in srgb, var\(--sentinel-danger\) 3\.5%, var\(--surface-raised\)\);/s);
  });

  it("uses the unified timeline for desktop and compact landscape layouts", () => {
    expect(overviewStyles).toContain(".overviewDashboardGrid > .serverTimelinePanel { grid-area: timeline;");
    expect(overviewStyles).toMatch(/\.serverTimelinePlayerChart\s*\{[^}]*max-height:\s*270px;[^}]*touch-action:\s*pan-y;/s);
    expect(overviewStyles).toMatch(/\.serverTimelinePlayers\s*\{[^}]*border-color:\s*color-mix\(in srgb, var\(--timeline-join\) 24%, var\(--border-muted\)\);[^}]*box-shadow:\s*inset 3px 0 0/s);
    expect(overviewStyles).toMatch(/\.serverTimelinePlayerHeader\s*\{[^}]*border-bottom:\s*var\(--border-subtle\) solid[^}]*background:\s*color-mix\(in srgb, var\(--timeline-join\) 6%, var\(--surface-muted\)\);/s);
    expect(overviewStyles).toMatch(/\.serverTimelineMetricBand\.is-prominent\s*\{\s*height:\s*clamp\(172px, 11vw, 190px\);\s*\}/s);
    expect(overviewStyles).toMatch(/@media \(min-width: 981px\) and \(max-width: 1180px\)[\s\S]*?\.serverTimelinePlayerChart\s*\{\s*max-height:\s*228px;/s);
    expect(overviewStyles).toMatch(/\.serverTimelineAnnotationStage\s*\{[^}]*min-height:\s*48px;/s);
    expect(overviewStyles).toMatch(/\.timelineAnnotationCluster\s*\{[^}]*height:\s*30px;[^}]*min-height:\s*30px;/s);
    expect(overviewStyles).toMatch(/\.timelineAnnotationCluster:hover:not\(:disabled\)[\s\S]*?background:\s*transparent;[\s\S]*?transform:\s*translateX\(-14px\);/s);
    expect(overviewStyles).toMatch(/\.overviewDashboardGrid--chartless\s*\{[^}]*"summary summary[^}]*"players players/s);
    expect(overviewStyles).toMatch(/@media \(max-width: 980px\) and \(orientation: landscape\)[\s\S]*?\.serverTimelineToolbar\s*\{[^}]*display:\s*grid;/s);
    expect(overviewStyles).toMatch(/@media \(max-width: 980px\) and \(orientation: landscape\)[\s\S]*?\.serverTimelineChart,[\s\S]*?height:\s*320px;[^}]*min-height:\s*320px;/s);
    expect(overviewStyles).toMatch(/\.serverTimelineChart\s*\{[^}]*min-height:\s*calc\(340px \+ var\(--timeline-annotation-extra, 0px\)\);/s);
    expect(overviewStyles).toMatch(/\.serverTimelineEChart\s*\{[^}]*width:\s*100%;[^}]*height:\s*100%;/s);
    expect(overviewStyles).not.toContain(".serverTimelineChart .recharts-");
    expect(overviewStyles).toMatch(/\.serverTimelineAnnotations\s*\{[^}]*bottom:\s*38px;/s);
    expect(overviewStyles).not.toContain("timelineAnnotationConnector");
    expect(overviewStyles).not.toContain("resourcePanel");
    expect(overviewStyles).not.toContain("recharts-");
    expect(overviewStyles).toMatch(/\.serverTimelineSharedGuide\s*\{[^}]*bottom:\s*0;[^}]*background:\s*color-mix\(in srgb, var\(--timeline-guide-color\) 64%, transparent\);/s);
    expect(overviewStyles).toMatch(/\.serverTimelineSharedGuide\.tone-server\s*\{\s*--timeline-guide-color:\s*var\(--timeline-server\);\s*\}/s);
    expect(overviewStyles).toMatch(/\.timelineAnnotationCluster\s*\{[^}]*height:\s*30px;[^}]*transform:\s*translateX\(-14px\);[^}]*background:\s*transparent;/s);
    expect(overviewStyles).toMatch(/\.timelineAnnotationCluster\.is-multiple\s*\{[^}]*min-width:\s*max-content;[^}]*border:\s*1px solid var\(--border-subtle\);/s);
    expect(overviewStyles).toMatch(/\.timelineAnnotationCluster\.is-labeled\s*\{[^}]*width:\s*max-content;[^}]*padding-right:\s*6px;/s);
    expect(overviewStyles).toMatch(/\.timelineAnnotationClusterIcon \+ \.timelineAnnotationClusterIcon\s*\{\s*margin-left:\s*-9px;\s*\}/s);
    expect(overviewStyles).toMatch(/\.timelineAnnotationClusterIcon \.controlGlyph-start,[\s\S]*?fill:\s*currentColor;[\s\S]*?stroke:\s*none;/s);
    expect(overviewStyles).toMatch(/\.timelineAnnotationClusterCount\s*\{[^}]*font-size:\s*10px;[^}]*font-weight:\s*var\(--weight-title\);/s);
    expect(overviewStyles).toMatch(/\.timelineAnnotationClusterLabel\s*\{[^}]*font-size:\s*10px;[^}]*font-weight:\s*var\(--weight-title\);/s);
    expect(overviewStyles).toMatch(/\.serverTimelineAnnotationPopover\s*\{[^}]*position:\s*absolute;[^}]*max-height:\s*250px;[^}]*border:\s*var\(--border-strong\) solid var\(--border\);[^}]*background:\s*color-mix\(in srgb, var\(--surface-raised\) 78%, var\(--surface-muted\)\);[^}]*box-shadow:\s*var\(--shadow-elevated\);/s);
    expect(overviewStyles).toMatch(/\.serverTimelineAnnotationPopoverItem\s*\{[^}]*border:\s*var\(--border-subtle\) solid var\(--border-muted\);/s);
    expect(overviewStyles).toMatch(/\.timelineSeriesToggle\s*\{[^}]*border:\s*1px solid[^}]*cursor:\s*pointer;/s);
  });

  it("keeps mod loading values and scrollbars from resizing the workspace", () => {
    expect(modsStyles).toMatch(/\.modsWorkspaceMetric strong\s*\{[^}]*display:\s*flex;[^}]*min-height:\s*20px;/s);
    expect(modsStyles).toMatch(/\.modsMetricValueSkeleton\s*\{[^}]*height:\s*17px;[^}]*margin:\s*0;/s);
    expect(modsStyles).toMatch(/\.modsWorkspaceTable\s*\{[^}]*scrollbar-gutter:\s*stable;/s);
  });

  it("lets phone mod rows use document scrolling and keeps them compact", () => {
    const phoneModRules = modsStyles.slice(modsStyles.indexOf("@media (max-width: 760px)"));
    expect(phoneModRules).toMatch(/\.modsWorkspaceInstalled\s*\{[^}]*height:\s*auto;[^}]*flex:\s*none;/s);
    expect(phoneModRules).toMatch(/\.modsWorkspaceRow\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto auto;[^}]*"identity enabled switchVersion"[^}]*"status version version"[^}]*"update update update";[^}]*gap:\s*5px 8px;[^}]*padding:\s*8px 10px;/s);
    expect(phoneModRules).toMatch(/\.modsWorkspaceIdentity img,[\s\S]*?width:\s*36px;[^}]*height:\s*36px;/s);
    expect(phoneModRules).toMatch(/@media \(max-width: 720px\)[\s\S]*?\.modsWorkspaceInstalled,\s*\.modsWorkspaceTable\s*\{[^}]*overflow:\s*visible;/s);
    expect(phoneModRules).toMatch(/\.modsWorkspaceTable\s*\{[^}]*flex:\s*none;[^}]*scrollbar-gutter:\s*auto;/s);
  });

  it("keeps the Mods summary markers vivid in every theme", () => {
    expect(modsStyles).toMatch(/\.modsWorkspaceMetric \.uiMetricTileMarker\s*\{[^}]*currentColor 26%[^}]*currentColor 24%/s);
    expect(modsStyles).toMatch(/\.modsWorkspaceMetric\.blue \.uiMetricTileMarker\s*\{[^}]*--sentinel-info[^}]*--sentinel-info\) 72%/s);
    expect(modsStyles).toMatch(/\.modsWorkspaceMetric\.orange \.uiMetricTileMarker\s*\{[^}]*--sentinel-warning[^}]*--sentinel-warning\) 76%/s);
    expect(modsStyles).toMatch(/\.modsWorkspaceMetric\.green \.uiMetricTileMarker\s*\{[^}]*--sentinel-success[^}]*--sentinel-success\) 72%/s);
    expect(modsStyles).toMatch(/\.modsWorkspaceMetric\.purple \.uiMetricTileMarker\s*\{[^}]*--accent[^}]*--accent\) 72%/s);
  });

  it("keeps the Files page layout owned by the file-manager stylesheet", () => {
    expect(serverPropertiesStyles).not.toMatch(/\.filesPage\s*\{/);
    expect(canonicalLayoutStyles).not.toMatch(/\.filesPage\s*\{[^}]*grid-template-columns:/s);
    expect(fileManagerStyles).toMatch(/\.filesPage\s*\{[^}]*min-height:\s*520px;/s);
  });

  it("promotes rename and delete out of the file action menu when the selection bar is wide enough", () => {
    expect(fileManagerStyles).toMatch(/\.filesPage \.selectionActionPromoted,\s*\.filesPage \.selectionActionMenu--expanded\s*\{[^}]*display:\s*none;/s);
    expect(fileManagerStyles).toMatch(/@container \(min-width: 961px\)\s*\{[\s\S]*?\.filesPage \.selectionActionPromoted,[\s\S]*?display:\s*inline-flex;[\s\S]*?\.filesPage \.selectionActionMenu--compact\s*\{[^}]*display:\s*none;/s);
  });

  it("keeps the file editor wider than generic dialogs while preserving its phone inset", () => {
    expect(filesConsoleStyles).toMatch(/\.modalPanel\.fileEditorModal\s*\{[^}]*width:\s*90vw;/s);
    expect(responsiveStyles).toMatch(/@media \(max-width: 720px\)[\s\S]*?\.modalPanel\.fileEditorModal\s*\{[^}]*width:\s*calc\(100vw - 16px\);/s);
  });

  it("keeps phone action menus inside the edge they are aligned to", () => {
    expect(responsiveStyles).toMatch(/\.actionMenuPopover--end\s*\{[^}]*right:\s*0;[^}]*left:\s*auto;/s);
    expect(responsiveStyles).toMatch(/\.actionMenuPopover--start\s*\{[^}]*right:\s*auto;[^}]*left:\s*0;/s);
  });

  it("packs the four phone overview summary tiles into two equal rows", () => {
    const phoneOverviewRules = responsiveStyles.slice(responsiveStyles.lastIndexOf("@media (max-width: 720px)"));
    expect(phoneOverviewRules).toMatch(/\.overviewDashboardGrid > \.overviewSummary\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/s);
    expect(phoneOverviewRules).toMatch(/\.overviewDashboardGrid > \.overviewSummary > \.summaryTile\s*\{[^}]*grid-column:\s*auto;[^}]*min-height:\s*54px;/s);
    expect(phoneOverviewRules).toMatch(/\.summaryTile \.uiMetricTileMarker\s*\{[^}]*display:\s*none;/s);
  });

  it("compacts the active player roster across phone orientations", () => {
    expect(overviewStyles).toMatch(/\.activePlayerHead\s*\{[^}]*width:\s*24px;[^}]*height:\s*24px;/s);
    expect(overviewStyles).toMatch(/@media \(max-width: 980px\)[\s\S]*?\.activePlayer\s*\{[^}]*grid-template-columns:\s*8px minmax\(0, 1fr\);[^}]*padding:\s*5px 8px;/s);
    expect(overviewStyles).toMatch(/@media \(max-width: 980px\)[\s\S]*?\.activePlayer--withHead\s*\{[^}]*grid-template-columns:\s*20px minmax\(0, 1fr\);[\s\S]*?\.activePlayerHead\s*\{[^}]*width:\s*20px;[^}]*height:\s*20px;/s);
    expect(overviewStyles).toMatch(/@media \(max-width: 980px\) and \(orientation: landscape\)[\s\S]*?\.overviewDashboardGrid \.activePlayerGrid,[\s\S]*?grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\);/s);
    expect(primitiveStyles).toMatch(/@media \(max-width: 980px\) and \(orientation: portrait\)[\s\S]*?\.applicationOverviewTimelinePanel\s*\{\s*display:\s*none;/s);
  });

  it("uses the document as the final phone scroll surface", () => {
    const nativeScrollRules = responsiveStyles.slice(responsiveStyles.lastIndexOf("/* Native document scrolling"));
    expect(nativeScrollRules).toMatch(/html,\s*body\s*\{[^}]*height:\s*auto;[^}]*overflow-y:\s*auto;/s);
    expect(nativeScrollRules).toMatch(/\.appShell,[^{]*\{[^}]*height:\s*auto;[^}]*overflow:\s*visible;/s);
    expect(nativeScrollRules).toMatch(/\.mobileNavigationOpen\.appShell\s*\{[^}]*position:\s*fixed;[^}]*inset:\s*0;/s);
    expect(nativeScrollRules).toMatch(/\.nodesPage\s*>\s*\.nodeDrawerBackdrop\s+\.nodeDrawerBody\s*\{[^}]*overflow:\s*visible;/s);
    expect(nativeScrollRules).toMatch(/\.appShell:has\(\.workspacePage-console\)[^{]*\{[^}]*height:\s*var\(--visual-viewport-height, 100dvh\);[^}]*overflow:\s*hidden;/s);
    expect(nativeScrollRules).toMatch(/\.workspacePage-console\s*\{[^}]*height:\s*100%;[^}]*overflow:\s*hidden;/s);
  });

  it("gives the phone Console the full viewport width", () => {
    const phoneWorkspaceRules = responsiveStyles.slice(responsiveStyles.indexOf("/* Mobile workspaces reserve"));
    expect(phoneWorkspaceRules).toMatch(/\.workspacePage-console > \.tabPage:has\(\.consolePanel\)\s*\{[^}]*width:\s*calc\(100% \+ var\(--space-4\) \+ var\(--space-4\)\);[^}]*margin-inline:\s*calc\(0px - var\(--space-4\)\);/s);
    expect(phoneWorkspaceRules).toMatch(/\.workspacePage-console \.consolePanel\s*\{[^}]*padding:\s*0;[^}]*border-inline:\s*0;[^}]*border-radius:\s*0;/s);
    expect(phoneWorkspaceRules).toMatch(/\.workspacePage-console \.consolePanel \.terminal\s*\{[^}]*border-inline:\s*0;[^}]*border-radius:\s*0;/s);
  });

  it("lets the Console use the available width on very large screens", () => {
    expect(responsiveStyles).toMatch(
      /@media \(min-width: 2560px\)\s*\{\s*\.workspace\.workspacePage-console\s*\{[^}]*max-width:\s*none;/s
    );
  });
});
