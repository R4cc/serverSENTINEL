// Stylesheet architecture tests.
//
// These assert *ownership and cascade* rules: which stylesheet is allowed to
// define what, that the entry point loads layers in the order the design system
// depends on, and that retired class families stay retired.
//
// They deliberately do NOT assert declaration values (pixel sizes, color-mix
// percentages, grid-template-areas strings, property order). Value assertions
// written as regexes over raw CSS text cannot verify rendering, break on
// reformatting or reordering, and fail with unreadable regex diffs. Visual
// behaviour is verified by the browser smoke scripts under `scripts/` instead.
//
// When adding a test here, ask: "would this still pass if the rule were
// correct but written differently?" If not, it belongs in a smoke script.

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
const overviewStyles = readFileSync(new URL("./styles/overview.css", import.meta.url), "utf8");
const authStyles = readFileSync(new URL("./styles/auth.css", import.meta.url), "utf8");
const nodesStyles = readFileSync(new URL("./styles/nodes.css", import.meta.url), "utf8");
// Every stylesheet the entry point imports, keyed by name so a failure names the
// file rather than reporting an anonymous index.
const featureStyles: Record<string, string> = Object.fromEntries(
  [...stylesheet.matchAll(/@import "\.\/styles\/([\w-]+\.css)";/g)].map((match) => [
    match[1],
    readFileSync(new URL(`./styles/${match[1]}`, import.meta.url), "utf8") as string
  ])
);

const serverTimeline = readFileSync(new URL("./components/ServerTimeline.tsx", import.meta.url), "utf8");
const modsSummary = readFileSync(new URL("./features/mods/ModsSummary.tsx", import.meta.url), "utf8");
const nodesPage = readFileSync(new URL("./pages/NodesPage.tsx", import.meta.url), "utf8");

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
});

describe("stylesheet ownership", () => {
  it("keeps global primitives in the shared primitive stylesheet", () => {
    expect(primitiveStyles).toContain(".uiSurface");
    expect(primitiveStyles).toContain(".uiToolbar");
    expect(primitiveStyles).toContain(".uiFormField");
    expect(primitiveStyles).toContain(".uiBanner");
    expect(primitiveStyles).toContain(".uiMetricTile");
  });

  it("does not let feature stylesheets redefine primitives or raw colors", () => {
    expect(modsStyles).not.toContain("Shared UI foundation");
    expect(modsStyles).not.toMatch(/(^|\n)\.uiButton--primary\s*\{/);
    // Feature sheets consume theme tokens; raw hex or rgb() bypasses theming.
    expect(modsStyles).not.toMatch(/#[0-9a-fA-F]{3,8}|rgba?\(/);
    expect(authStyles).not.toMatch(/:root\.themeDark[\s\S]*?--surface:/);
  });

  it("keeps the Files page layout owned by the file-manager stylesheet", () => {
    expect(serverPropertiesStyles).not.toMatch(/\.filesPage\s*\{/);
    expect(canonicalLayoutStyles).not.toMatch(/\.filesPage\s*\{[^}]*grid-template-columns:/s);
    expect(fileManagerStyles).toMatch(/\.filesPage\s*\{/);
  });

  it("gives the Mods and Nodes summaries the same tile, not two lookalikes", () => {
    expect(modsStyles).not.toContain(".modsWorkspaceMetric");
    expect(nodesStyles).not.toContain(".nodesFleetMetric");
    for (const summary of [modsSummary, nodesPage]) expect(summary).toContain('variant="summary"');
  });

  it("hands the timeline charts color tokens rather than border-width tokens", () => {
    const widthTokens = [...tokenStyles.matchAll(/(--[\w-]+):\s*\d+(?:\.\d+)?px;/g)].map((match) => match[1]);
    expect(widthTokens).toContain("--border-subtle");
    for (const token of widthTokens) expect(serverTimeline).not.toContain(`read("${token}"`);
    expect(serverTimeline).toContain('read("--border-muted"');
  });

  // The same width-vs-color mix-up the timeline test guards in TSX is silent in
  // CSS: `1px solid var(--border-subtle)` resolves to `1px solid 1px`, which the
  // parser drops, so the border simply never paints. Nothing in the browser
  // reports it, so it is asserted here instead.
  it("never passes a border-width token where a color belongs", () => {
    const widthTokens = [...tokenStyles.matchAll(/(--[\w-]+):\s*\d+(?:\.\d+)?px;/g)].map((match) => match[1]);
    const asColor = new RegExp(
      `(?:solid|dashed|dotted)\\s+var\\((?:${widthTokens.join("|")})\\)`
      + `|border(?:-[a-z]+)?-color:\\s*var\\((?:${widthTokens.join("|")})\\)`
      + `|%,\\s*var\\((?:${widthTokens.join("|")})\\)\\s*\\)`,
      "g"
    );

    for (const [name, sheet] of Object.entries(featureStyles)) {
      expect(`${name}: ${sheet.match(asColor)?.join(", ") ?? "none"}`).toBe(`${name}: none`);
    }
  });

  // A `var()` that resolves to nothing takes its whole declaration with it, so a
  // token that was never defined reads as "this rule silently does less than it
  // says". Custom properties set from TSX are the only legitimate exception.
  it("defines every token the stylesheets consume", () => {
    const runtimeTokens = ["--visual-viewport-height", "--xms-percent", "--xmx-percent", "--timeline-annotation-extra"];
    const allStyles = Object.values(featureStyles).join("\n");
    const defined = new Set([...allStyles.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1]));
    const referenced = [...allStyles.matchAll(/var\((--[\w-]+)/g)].map((match) => match[1]);

    const undefinedTokens = [...new Set(referenced)]
      .filter((token) => !defined.has(token) && !runtimeTokens.includes(token))
      .sort();

    expect(undefinedTokens).toEqual([]);
  });

  it("keeps one spinner rather than a per-feature lookalike in each stylesheet", () => {
    expect(primitiveStyles).toContain(".uiSpinner");
    // Every busy ring reduces to a static state for reduced-motion users; that
    // only holds while there is a single rule to apply it to.
    expect(primitiveStyles).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.uiSpinner \{/);
    for (const [name, sheet] of Object.entries(featureStyles)) {
      if (name === "primitives.css") continue;
      expect(`${name}: ${/^\s*\.[\w-]*[sS]pinner\s*\{[^}]*animation:/m.test(sheet)}`).toBe(`${name}: false`);
    }
  });
});

describe("layout stability guards", () => {
  it("does not animate page containers that host fixed dialogs", () => {
    expect(motionStyles).not.toContain("sentinelPageEnter");
    expect(motionStyles).not.toMatch(/\.workspace\s*>\s*\.(?:tabPage|pageStack|createServerPanel)[^{]*\{[^}]*animation\s*:/s);
  });

  it("reserves scrollbar gutters before async content changes page height", () => {
    expect(tokenStyles).toContain("scrollbar-gutter: stable");
    expect(modsStyles).toContain("scrollbar-gutter: stable");
  });
});

describe("retired class families stay retired", () => {
  it.each([
    "modUpdatesCardOpen",
    "modUpdatesCompact",
    "modUpdatesWide",
    "modUpdatesRefreshLabel",
    "automationTimeline",
    "serverTimelinePlayerScrollHint",
    "serverTimelineAnnotationStage",
    "serverTimelineEventRailLine",
    "timelineAnnotationConnector",
    "resourcePanel",
    "recharts-"
  ])("has no %s rules left in the overview stylesheet", (retired) => {
    expect(overviewStyles).not.toContain(retired);
  });

  // The console's command line became a real input rather than characters echoed into the
  // terminal, so the status row it used to own moved out with it.
  it.each([
    "minecraftTerminalStatus"
  ])("has no %s rules left in the console stylesheet", (retired) => {
    expect(featureStyles["files-console.css"]).not.toContain(retired);
  });

  it("keeps the console command line in the console stylesheet", () => {
    expect(featureStyles["files-console.css"]).toContain(".consolePrompt");
    expect(featureStyles["files-console.css"]).toContain(".consolePromptInput");
  });
});
