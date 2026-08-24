import { describe, expect, it } from "vitest";
import { demoPlayerHeadSource, playerHeadSource, playerHeadVersion } from "./playerHeads";

describe("player head sources", () => {
  it("uses one bundled Steve head for every demo player and demo server", () => {
    expect(playerHeadSource("demo-survival", "StormBolt", 1)).toBe(demoPlayerHeadSource);
    expect(playerHeadSource("demo-fleet-2-3", "Pixel_Panda", 999)).toBe(demoPlayerHeadSource);
  });

  it("keeps real players on the panel-cached endpoint", () => {
    expect(playerHeadSource("server/one", "Player Name", 42))
      .toBe("/api/servers/server%2Fone/player-head/Player%20Name?v=42");
  });

  it("changes the real-player cache stamp once per hour", () => {
    expect(playerHeadVersion(3_599_999)).toBe(0);
    expect(playerHeadVersion(3_600_000)).toBe(1);
  });
});
