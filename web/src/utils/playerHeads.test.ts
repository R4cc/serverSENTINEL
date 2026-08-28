import { describe, expect, it } from "vitest";
import { demoPlayerHeadNames, demoPlayerHeadSource, playerHeadSource, playerHeadVersion } from "./playerHeads";

describe("player head sources", () => {
  it("assigns bundled heads consistently while varying them between demo players", () => {
    const stormBolt = demoPlayerHeadSource("StormBolt");
    expect(playerHeadSource("demo-survival", "StormBolt", 1)).toBe(stormBolt);
    expect(playerHeadSource("demo-fleet-2-3", "StormBolt", 999)).toBe(stormBolt);
    expect(new Set(["StormBolt", "Pixel_Panda", "AlexIsHodde", "EnderBobo"].map(demoPlayerHeadSource)).size).toBe(4);
    expect(stormBolt).toMatch(/^\/demo-player-heads\/[a-z0-9_]+\.png$/);
  });

  it("includes every curated demo head", () => {
    expect(demoPlayerHeadNames).toHaveLength(65);
    expect(demoPlayerHeadNames).toContain("jeb_");
    expect(demoPlayerHeadNames).toContain("Technoblade");
    expect(demoPlayerHeadNames).toContain("Grian");
    expect(demoPlayerHeadNames).toContain("PrestonPlayz");
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
