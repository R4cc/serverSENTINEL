import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActiveServerStripLoadingSkeleton, ApplicationLoadingSkeleton, AuthLoadingSkeleton, CodeLoadingSkeleton, FeaturePageLoadingSkeleton, TerminalLoadingSkeleton } from "./LoadingSkeletons";
import { LoadingLabel, SkeletonBlock } from "./UiPrimitives";

describe("loading skeletons", () => {
  it("keeps decorative blocks hidden and announces the loading region", () => {
    const html = renderToStaticMarkup(<div aria-busy="true"><LoadingLabel>Loading records</LoadingLabel><SkeletonBlock /></div>);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('role="status"');
    expect(html).toContain("Loading records");
    expect(html).toContain('aria-hidden="true"');
  });

  it("renders stable bootstrap, code, and terminal surfaces without loading banners", () => {
    const html = renderToStaticMarkup(<><AuthLoadingSkeleton /><ActiveServerStripLoadingSkeleton /><ApplicationLoadingSkeleton /><CodeLoadingSkeleton /><TerminalLoadingSkeleton /></>);
    expect(html).toContain("authLoadingSkeleton");
    expect(html).toContain("activeServerStripLoadingSkeleton");
    expect(html).toContain("applicationLoadingSkeleton");
    expect(html).toContain("codeLoadingSkeleton");
    expect(html).toContain("terminalLoadingSkeleton");
    expect(html).not.toContain("inlineState-loading");
  });

  it("matches the overview summary geometry and keeps ultrawide-only tiles reserved", () => {
    const overview = renderToStaticMarkup(<ApplicationLoadingSkeleton page="overview" />);
    const files = renderToStaticMarkup(<ApplicationLoadingSkeleton page="files" />);

    expect(overview.match(/applicationSkeletonTile/g)).toHaveLength(7);
    expect(overview.match(/applicationSkeletonWideTile/g)).toHaveLength(2);
    expect(overview).toContain("applicationLoadingSkeleton--overview");
    expect(files).toContain("applicationLoadingSkeleton--files");
    expect(files).not.toContain("applicationSkeletonSummary");
  });

  it("uses route-shaped loading structures for heavy workspaces and lazy fallbacks", () => {
    const files = renderToStaticMarkup(<ApplicationLoadingSkeleton page="files" />);
    const mods = renderToStaticMarkup(<ApplicationLoadingSkeleton page="mods" />);
    const schedules = renderToStaticMarkup(<FeaturePageLoadingSkeleton page="schedule" label="Loading schedules" />);
    const consolePage = renderToStaticMarkup(<FeaturePageLoadingSkeleton page="console" label="Loading console" />);

    expect(files).toContain("applicationFilesSkeleton");
    expect(files.match(/applicationFilesRow"/g)).toHaveLength(8);
    expect(mods).toContain("applicationModsSummary");
    expect(mods.match(/applicationModsMetric"/g)).toHaveLength(3);
    expect(schedules).toContain("applicationScheduleGrid");
    expect(consolePage).toContain("applicationConsoleSkeleton");
  });
});
