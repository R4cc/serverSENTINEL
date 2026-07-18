import { describe, expect, it } from "vitest";
import { preferredMinecraftVersion } from "./serverSettingsHelpers";

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
