import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApplicationLoadingSkeleton, AuthLoadingSkeleton, CodeLoadingSkeleton, TerminalLoadingSkeleton } from "./LoadingSkeletons";
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
    const html = renderToStaticMarkup(<><AuthLoadingSkeleton /><ApplicationLoadingSkeleton /><CodeLoadingSkeleton /><TerminalLoadingSkeleton /></>);
    expect(html).toContain("authLoadingSkeleton");
    expect(html).toContain("applicationLoadingSkeleton");
    expect(html).toContain("codeLoadingSkeleton");
    expect(html).toContain("terminalLoadingSkeleton");
    expect(html).not.toContain("inlineState-loading");
  });
});
