import { describe, expect, it } from "vitest";
import { frontendCacheControl, htmlCacheControl, immutableAssetCacheControl, publicAssetCacheControl } from "./staticFrontend.js";

describe("frontendCacheControl", () => {
  const webDist = "C:/app/web/dist";

  it("requires HTML entry points to revalidate without allowing proxy transforms", () => {
    expect(frontendCacheControl(webDist, `${webDist}/index.html`)).toBe(htmlCacheControl);
    expect(htmlCacheControl).toBe("no-cache, no-transform");
  });

  it("caches Vite-fingerprinted assets for one year as immutable", () => {
    expect(frontendCacheControl(webDist, `${webDist}/assets/index-Ab12Cd34.js`)).toBe(immutableAssetCacheControl);
    expect(frontendCacheControl(webDist, `${webDist}/assets/index-Ef56Gh78.css`)).toBe(immutableAssetCacheControl);
    expect(immutableAssetCacheControl).toBe("public, max-age=31536000, immutable");
  });

  it("uses a short revalidated policy for stable public filenames", () => {
    expect(frontendCacheControl(webDist, `${webDist}/logo-40.webp`)).toBe(publicAssetCacheControl);
    expect(frontendCacheControl(webDist, `${webDist}/robots.txt`)).toBe(publicAssetCacheControl);
    expect(publicAssetCacheControl).toBe("public, max-age=3600, must-revalidate");
  });
});
