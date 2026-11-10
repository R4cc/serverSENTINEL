import { describe, expect, it } from "vitest";
import {
  appearanceProperties,
  contrastFromStoredValue,
  defaultContrast,
  defaultTranslucency,
  translucencyFromStoredValue
} from "./appearancePreferences";

describe("appearance preferences", () => {
  it("falls back to the defaults for missing or unreadable values", () => {
    expect(translucencyFromStoredValue(null)).toBe(defaultTranslucency);
    expect(translucencyFromStoredValue("")).toBe(defaultTranslucency);
    expect(translucencyFromStoredValue("glassy")).toBe(defaultTranslucency);
    expect(contrastFromStoredValue(null)).toBe(defaultContrast);
    expect(contrastFromStoredValue("NaN")).toBe(defaultContrast);
  });

  it("keeps stored values on the slider's range", () => {
    expect(translucencyFromStoredValue("0")).toBe(0);
    expect(translucencyFromStoredValue("72.4")).toBe(72);
    expect(translucencyFromStoredValue("140")).toBe(100);
    expect(contrastFromStoredValue("-20")).toBe(0);
    expect(contrastFromStoredValue("100")).toBe(100);
  });

  it("matches the stylesheet defaults at the default preference", () => {
    expect(appearanceProperties(defaultTranslucency, defaultContrast)).toEqual({
      "--glass-opacity": "80%",
      "--glass-blur-scale": "1",
      "--contrast-boost": "0%",
      "--contrast-border-boost": "0%"
    });
  });

  it("makes floating layers opaque and unblurred when translucency is off", () => {
    const properties = appearanceProperties(0, 0);
    expect(properties["--glass-opacity"]).toBe("100%");
    expect(properties["--glass-blur-scale"]).toBe("0");
  });

  it("diffuses the backdrop further as layers get more see-through", () => {
    const properties = appearanceProperties(100, 0);
    expect(properties["--glass-opacity"]).toBe("60%");
    expect(properties["--glass-blur-scale"]).toBe("1.5");
  });

  it("moves lines half as far as text when contrast is raised", () => {
    const properties = appearanceProperties(defaultTranslucency, 100);
    expect(properties["--contrast-boost"]).toBe("60%");
    expect(properties["--contrast-border-boost"]).toBe("30%");
  });
});
