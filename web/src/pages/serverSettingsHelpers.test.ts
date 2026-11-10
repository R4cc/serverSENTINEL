import { describe, expect, it } from "vitest";
import { memoryScaleTicks, preferredMinecraftVersion, runtimeMinecraftOptions } from "./serverSettingsHelpers";

describe("preferredMinecraftVersion", () => {
  it("defaults to the newest release returned by the runtime provider", () => {
    expect(preferredMinecraftVersion([
      { version: "1.21.11", stable: true, type: "release" },
      { version: "1.21.6", stable: true, type: "release" }
    ])).toBe("1.21.11");
  });

  it("uses the provider-recommended release when the newest version has no stable runtime build", () => {
    expect(preferredMinecraftVersion([
      { version: "26.2", stable: true, type: "release" },
      { version: "26.1.2", stable: true, type: "release", recommended: true }
    ])).toBe("26.1.2");
  });

  it("does not invent a Minecraft version when the runtime provider has none", () => {
    expect(preferredMinecraftVersion([])).toBe("");
  });
});

describe("runtimeMinecraftOptions", () => {
  it("does not expose fallback versions while the live catalog is still loading", () => {
    expect(runtimeMinecraftOptions([], false)).toEqual([]);
  });
});

describe("memoryScaleTicks", () => {
  it("labels the heap scale in even power-of-two steps at their true positions", () => {
    expect(memoryScaleTicks(1, 16).map((tick) => tick.value)).toEqual([1, 4, 8, 12, 16]);
    const ticks = memoryScaleTicks(1, 16);
    expect(ticks[0].percent).toBe(0);
    expect(ticks.at(-1)?.percent).toBe(100);
    expect(ticks[2].percent).toBeCloseTo((7 / 15) * 100);
  });

  it("drops an interior tick that would crowd an end label", () => {
    expect(memoryScaleTicks(1, 8).map((tick) => tick.value)).toEqual([1, 4, 6, 8]);
  });

  it("returns a single label for an empty range", () => {
    expect(memoryScaleTicks(4, 4)).toEqual([{ value: 4, percent: 0 }]);
  });
});
