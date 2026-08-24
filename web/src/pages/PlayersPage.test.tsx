import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { geoLite2Attribution } from "@serversentinel/contracts";
import type { ManagedServer, PlayerInsightsResponse } from "../types";
import { PlayersPage } from "./PlayersPage";

const server = { id: "server-1", displayName: "Survival" } as ManagedServer;

function insights(overrides: Partial<PlayerInsightsResponse> = {}): PlayerInsightsResponse {
  return {
    generatedAt: "2026-08-16T12:00:00.000Z",
    timeZone: "UTC",
    summary: { countries: 0, onlinePlayers: 0, locatedPlayers: 0, knownPlayers: 0 },
    players: [],
    regions: [],
    latency: [],
    activityHours: Array.from({ length: 24 }, (_, hour) => ({ hour, averagePlayers: 0, peakPlayers: 0, samples: 0 })),
    serverLocations: [{ serverId: "server-1" }],
    geoDatabase: { available: false, configured: false, updating: false },
    attribution: geoLite2Attribution,
    ...overrides
  };
}

function render(overrides: Partial<Parameters<typeof PlayersPage>[0]> = {}) {
  return renderToStaticMarkup(
    <PlayersPage
      active
      server={server}
      insights={insights()}
      loading={false}
      error=""
      busy={false}
      range="24h"
      onRangeChange={vi.fn()}
      onReload={vi.fn()}
      onSaveServerAddress={vi.fn()}
      onRefreshGeoDatabase={vi.fn()}
      canManage
      playerHeadsEnabled={false}
      compactLayout={false}
      formatDate={(value) => new Date(value).toISOString()}
      formatNumber={(value) => new Intl.NumberFormat("de-DE").format(value)}
      {...overrides}
    />
  );
}

describe("the Players workspace before it knows anything", () => {
  it("says geography is not configured, and how to configure it", () => {
    const html = render();
    expect(html).toContain("Player geography is not configured");
    expect(html).toContain("Settings → Integrations");
    // The privacy claim is on the page itself, not only in the documentation.
    expect(html).toContain("no player address is sent to MaxMind or any other geolocation service");
  });

  it("shows an em dash for every figure it could not derive, never a zero standing in for unknown", () => {
    const html = render();
    expect(html).toContain("Median est. ping");
    expect(html).toContain("Needs a full day of history");
    expect(html).toContain("No region resolved yet");
    expect(html).not.toContain("0 ms");
  });

  it("explains each empty card rather than drawing an empty chart", () => {
    const html = render();
    expect(html).toContain("Not enough history yet");
    expect(html).toContain("No activity recorded yet");
    expect(html).toContain("No regions yet");
    expect(html).toContain("No players recorded yet");
  });

  it("carries the GeoLite2 attribution its licence requires", () => {
    expect(render()).toContain("GeoLite2 data created by MaxMind");
  });
});

describe("the Players workspace with partial knowledge", () => {
  const partial = insights({
    summary: { countries: 1, onlinePlayers: 1, locatedPlayers: 1, knownPlayers: 2 },
    geoDatabase: { available: true, configured: true, updating: false },
    serverLocations: [{ serverId: "server-1" }],
    players: [
      {
        player: "SullyTheSnak",
        serverId: "server-1",
        serverName: "Survival",
        online: true,
        distanceKm: 16_035,
        location: { label: "Copenhagen", city: "Copenhagen", country: "Denmark", countryCode: "DK", continentCode: "EU", continent: "Europe", latitude: 55.68, longitude: 12.57, accuracyRadiusKm: 20, precision: "city" },
        lastSeenAt: "2026-08-16T11:30:00.000Z",
        observations: 4
      },
      {
        player: "LanPlayer",
        serverId: "server-1",
        serverName: "Survival",
        online: true,
        observations: 0
      }
    ]
  });

  it("lists a player it cannot place, and says so instead of leaving the row blank", () => {
    const html = render({ insights: partial });
    expect(html).toContain("LanPlayer");
    expect(html).toContain("No location resolved");
  });

  it("never claims a latency when the server has no address to measure from", () => {
    const html = render({ insights: partial });
    expect(html).toContain("Set the server address to measure distance and estimate latency");
    expect(html).not.toContain(" ms<");
  });

  it("keeps location compact while exposing its flag and accuracy explanation on the badge", () => {
    const html = render({ insights: partial });
    expect(html).toContain("🇩🇰");
    expect(html).toContain("Copenhagen, Denmark");
    expect(html).toContain(">Precise</span>");
    expect(html).toContain('role="tooltip"');
    expect(html).toContain("IP-based location estimate. Expected accuracy is roughly within 20 km.");
    expect(html).not.toContain("Approximate, within about 20 km");
  });

  it("groups distance digits with the selected regional format", () => {
    const html = render({ insights: partial });
    expect(html).toContain("16.035 km");
    expect(html).not.toContain("thousand km");
  });

  it("offers the address field only to an account that may change it", () => {
    expect(render({ insights: partial })).toContain("player-insights-server-address");
    const readOnly = render({ insights: partial, canManage: false });
    expect(readOnly).not.toContain("player-insights-server-address");
    expect(readOnly).toContain("player insights management permission");
  });

  it("does not draw empty avatar boxes when player heads are disabled", () => {
    expect(render({ insights: partial })).not.toContain("playerHead");
    expect(render({ insights: partial, playerHeadsEnabled: true })).toContain("playerHead");
  });

  it("marks the server origin with a generic server rack instead of the app cube", () => {
    const html = render({
      insights: insights({
        serverLocations: [{
          serverId: "server-1",
          address: "play.example.net",
          location: { label: "Frankfurt", city: "Frankfurt", country: "Germany", countryCode: "DE", continentCode: "EU", continent: "Europe", latitude: 50.11, longitude: 8.68, accuracyRadiusKm: 20, precision: "city" }
        }]
      })
    });
    expect(html).toContain("playerMapServerIcon");
    expect(html).toContain("lucide-server");
    expect(html).not.toContain("server-icon-cube");
    expect(html).not.toContain("lucide-box");
  });

  it("renders nearby players as one head cluster with one averaged curved route", () => {
    const clusteredPlayers: PlayerInsightsResponse["players"] = [
      {
        player: "FastPlayer",
        serverId: "server-1",
        serverName: "Survival",
        online: true,
        location: { label: "New York", city: "New York", country: "United States", countryCode: "US", continentCode: "NA", continent: "North America", latitude: 40.71, longitude: -74.01, accuracyRadiusKm: 20, precision: "city" },
        estimatedLatencyMs: 80,
        observations: 3
      },
      {
        player: "SlowPlayer",
        serverId: "server-1",
        serverName: "Survival",
        online: false,
        location: { label: "Newark", city: "Newark", country: "United States", countryCode: "US", continentCode: "NA", continent: "North America", latitude: 40.74, longitude: -74.17, accuracyRadiusKm: 30, precision: "city" },
        estimatedLatencyMs: 120,
        observations: 2
      }
    ];
    const html = render({
      playerHeadsEnabled: true,
      insights: insights({
        players: clusteredPlayers,
        serverLocations: [{
          serverId: "server-1",
          address: "play.example.net",
          location: { label: "Frankfurt", city: "Frankfurt", country: "Germany", countryCode: "DE", continentCode: "EU", continent: "Europe", latitude: 50.11, longitude: 8.68, accuracyRadiusKm: 20, precision: "city" }
        }]
      })
    });
    expect(html).toContain("playerMapClusterMarker");
    expect(html).toContain("playerMapLegendHead");
    expect(html).toContain("playerMapLegendCluster");
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toMatch(/playerMapClusterMarker[^>]+aria-controls=/);
    expect(html).toContain('data-player-count="2"');
    expect(html).toContain('data-estimated-ping="100"');
    expect(html).toContain("playerMapRoute--info");
    expect(html).toContain("/api/servers/server-1/player-head/FastPlayer");
    expect(html).not.toContain("playerMapDot");
    expect(html).not.toContain("playerMapLink");
    expect(html).not.toContain("playerMapLegendMark--player");
  });

  it("says an address could not be placed rather than telling the operator to set one", () => {
    const html = render({
      insights: insights({
        serverLocations: [{ serverId: "server-1", address: "play.example.net", error: "GeoLite2 has no location for play.example.net." }]
      })
    });
    expect(html).toContain("play.example.net could not be placed");
    expect(html).not.toContain("Set the server address to measure distance");
  });

  it("gives the chart room for its own labels at each size it is drawn", () => {
    const latency = [
      { at: Date.parse("2026-08-16T11:00:00.000Z"), medianEstimatedLatencyMs: 40, p95EstimatedLatencyMs: 150, players: 2 },
      { at: Date.parse("2026-08-16T12:00:00.000Z"), medianEstimatedLatencyMs: 45, p95EstimatedLatencyMs: 150, players: 3 }
    ];
    // The gutter and the label are measured in the same units, so a viewBox that does not change
    // with the font leaves "150 ms" hanging off the left edge. Both sizes have to agree.
    for (const compactLayout of [false, true]) {
      const html = render({ insights: insights({ latency }), compactLayout });
      const fontSize = Number(html.match(/class="playerChartAxisLabel" font-size="(\d+)"/)![1]);
      const gutter = Number(html.match(/x="(\d+)" y="[\d.]+" text-anchor="end"/)![1]);
      // Six characters of "150 ms" at roughly 0.6em each, and the label ends before the axis.
      expect(gutter, `compact: ${compactLayout}`).toBeGreaterThan(fontSize * 0.6 * 6);
    }
  });

  it("distinguishes chart endpoints that fall on different dates", () => {
    const html = render({
      insights: insights({
        latency: [
          { at: Date.parse("2026-08-15T12:00:00.000Z"), medianEstimatedLatencyMs: 40, p95EstimatedLatencyMs: 70, players: 2 },
          { at: Date.parse("2026-08-16T12:00:00.000Z"), medianEstimatedLatencyMs: 45, p95EstimatedLatencyMs: 75, players: 3 }
        ]
      })
    });
    expect(html).toContain("15 Aug");
    expect(html).toContain("16 Aug");
  });
});
