import { beforeAll, describe, expect, it } from "vitest";
import { loadDemoFixtures } from "../../demoRuntime";
import { demoPlayerInsights } from "./playersDemoFixtures";

describe("demo player insight locations", () => {
  beforeAll(() => loadDemoFixtures());

  it("spreads even a small demo roster across countries, cities, and every continent", () => {
    const insights = demoPlayerInsights("demo-server", true, "24h");
    const countries = new Set(insights.players.map((player) => player.location?.countryCode));
    const cities = new Set(insights.players.map((player) => player.location?.city));
    const continents = new Set(insights.players.map((player) => player.location?.continentCode));

    expect(insights.players.length).toBeGreaterThanOrEqual(14);
    expect(countries.size).toBeGreaterThanOrEqual(12);
    expect(cities.size).toBeGreaterThanOrEqual(14);
    expect(continents).toEqual(new Set(["EU", "NA", "AS", "SA", "OC", "AF"]));
    expect(insights.summary.countries).toBe(countries.size);
  });

  it("keeps demo ping measured and independent of geographic distance", () => {
    const insights = demoPlayerInsights("demo-server", true, "24h");

    expect(insights.players.filter((player) => player.online).every((player) => player.distanceKm !== undefined && player.pingMs !== undefined)).toBe(true);
    expect(insights.players.filter((player) => !player.online).every((player) => player.pingMs === undefined)).toBe(true);
  });
});
