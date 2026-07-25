import { describe, expect, it } from "vitest";
import { applyStandaloneViewport, isStandaloneDisplay, type ViewportHost } from "./standaloneViewport";

const browserViewport = "width=device-width, initial-scale=1.0";

function viewportHost({ displayMode = false, iosStandalone = false, hasMeta = true } = {}) {
  const meta = { content: browserViewport };
  const host: ViewportHost = {
    navigator: iosStandalone ? { standalone: true } : {},
    matchMedia: (query: string) => ({ matches: displayMode && query === "(display-mode: standalone)" }),
    document: {
      querySelector: () => hasMeta ? { setAttribute: (_name: string, value: string) => { meta.content = value; } } : null
    }
  };
  return { host, meta };
}

describe("standalone viewport", () => {
  it("leaves a browser tab on the plain viewport so the app matches the visible area", () => {
    const { host, meta } = viewportHost();
    expect(isStandaloneDisplay(host)).toBe(false);
    expect(applyStandaloneViewport(host)).toBe(false);
    expect(meta.content).toBe(browserViewport);
  });

  it("covers the display cutouts once the app is launched from the home screen", () => {
    const { host, meta } = viewportHost({ displayMode: true });
    expect(applyStandaloneViewport(host)).toBe(true);
    expect(meta.content).toContain("viewport-fit=cover");
  });

  it("recognises the iOS standalone flag, which reports where the display-mode query does not", () => {
    const { host, meta } = viewportHost({ iosStandalone: true });
    expect(isStandaloneDisplay(host)).toBe(true);
    expect(applyStandaloneViewport(host)).toBe(true);
    expect(meta.content).toContain("viewport-fit=cover");
  });

  it("leaves the document alone when the viewport tag is missing", () => {
    const { host } = viewportHost({ displayMode: true, hasMeta: false });
    expect(applyStandaloneViewport(host)).toBe(false);
  });
});
