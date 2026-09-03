import { describe, expect, it } from "vitest";
import { liquidGlassCornerRadius, supportsLiquidGlass } from "./GlassEffect";

const supportedEnvironment = {
  userAgent: "Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36",
  backdropFilter: true,
  reducedMotion: false,
  reducedTransparency: false
};

describe("liquid glass capability gating", () => {
  it("enables decorative refraction only for supported Chromium browsers", () => {
    expect(supportsLiquidGlass(supportedEnvironment)).toBe(true);
    expect(supportsLiquidGlass({ ...supportedEnvironment, userAgent: "Mozilla/5.0 Version/18.0 Safari/605.1.15" })).toBe(false);
    expect(supportsLiquidGlass({ ...supportedEnvironment, userAgent: "Mozilla/5.0 Firefox/142.0" })).toBe(false);
  });

  it("uses the frosted fallback for capability and accessibility exclusions", () => {
    expect(supportsLiquidGlass({ ...supportedEnvironment, backdropFilter: false })).toBe(false);
    expect(supportsLiquidGlass({ ...supportedEnvironment, reducedMotion: true })).toBe(false);
    expect(supportsLiquidGlass({ ...supportedEnvironment, reducedTransparency: true })).toBe(false);
    expect(supportsLiquidGlass({
      ...supportedEnvironment,
      userAgent: "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36"
    })).toBe(false);
  });
});

describe("liquid glass surface geometry", () => {
  it("matches the shared surface radii", () => {
    expect(liquidGlassCornerRadius("chrome")).toBe(18);
    expect(liquidGlassCornerRadius("floating")).toBe(18);
    expect(liquidGlassCornerRadius("modal")).toBe(24);
  });

  it("supports square chrome without removing its refraction", () => {
    expect(liquidGlassCornerRadius("chrome", 0)).toBe(0);
  });
});
