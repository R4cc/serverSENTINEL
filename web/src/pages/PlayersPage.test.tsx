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
      serverRunning
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

  it("offers the shared table sorting control on every roster heading", () => {
    const html = render({ insights: partial });
    for (const heading of ["Player", "Location", "Distance", "Est. ping", "Last seen"]) {
      expect(html).toContain(`title="Sort by ${heading}"`);
    }
    expect(html.match(/aria-sort="none"/g)).toHaveLength(5);
    expect(html.match(/class="uiSortHeaderButton"/g)).toHaveLength(5);
  });

  it("summarizes the roster and labels its compact last-seen row", () => {
    const html = render({ insights: partial });
    expect(html).toContain("1 online · 2 known");
    expect(html).toContain('data-label="Last seen"');
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

  it("marks online map heads directly and makes individual markers hoverable controls", () => {
    const html = render({ insights: partial, playerHeadsEnabled: true });
    expect(html).toContain("playerMapAvatar--online");
    expect(html).toContain("playerMapPlayerMarker");
    expect(html).toContain("playerMapMarker--online");
    expect(html).toContain("<button");
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
    expect(html).toContain("playerMapServer--running");
    expect(html).toContain("lucide-server");
    expect(html).not.toContain("server-icon-cube");
    expect(html).not.toContain("lucide-box");
    expect(render({
      serverRunning: false,
      insights: insights({
        serverLocations: [{
          serverId: "server-1",
          address: "play.example.net",
          location: { label: "Frankfurt", city: "Frankfurt", country: "Germany", countryCode: "DE", continentCode: "EU", continent: "Europe", latitude: 50.11, longitude: 8.68, accuracyRadiusKm: 20, precision: "city" }
        }]
      })
    })).toContain("playerMapServer--stopped");
  });

  it("combines a nearby player cluster with the server marker instead of displacing it", () => {
    const sharedLocation = { label: "Copenhagen", city: "Copenhagen", country: "Denmark", countryCode: "DK", continentCode: "EU", continent: "Europe", latitude: 55.68, longitude: 12.57, accuracyRadiusKm: 20, precision: "city" } as const;
    const html = render({
      playerHeadsEnabled: true,
      insights: insights({
        players: [
          { player: "PlayerOne", serverId: "server-1", serverName: "Survival", online: true, location: sharedLocation, estimatedLatencyMs: 10, observations: 2 },
          { player: "PlayerTwo", serverId: "server-1", serverName: "Survival", online: true, location: sharedLocation, estimatedLatencyMs: 12, observations: 2 }
        ],
        serverLocations: [{ serverId: "server-1", address: "play.example.net", location: sharedLocation }]
      })
    });
    expect(html).toContain("playerMapClusterMarker--server");
    expect(html).toContain("playerMapSharedServerIcon");
    expect(html).toContain("playerMapSharedServer--running");
    expect(html).not.toContain('<g class="playerMapServer">');
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

  it("renders connection quality through the shared chart canvas with a readable latest snapshot", () => {
    const latency = [
      { at: Date.parse("2026-08-16T11:00:00.000Z"), medianEstimatedLatencyMs: 40, p95EstimatedLatencyMs: 150, players: 2 },
      { at: Date.parse("2026-08-16T12:00:00.000Z"), medianEstimatedLatencyMs: 45, p95EstimatedLatencyMs: 150, players: 3 }
    ];
    const html = render({ insights: insights({ latency }) });

    expect(html).toContain('class="playerConnectionEChart" role="img"');
    expect(html).toContain("Latest connection quality estimate");
    expect(html).toContain("Median</dt><dd>45 ms");
    expect(html).toContain("95th percentile</dt><dd>150 ms");
    expect(html).toContain("Active players</dt><dd>3");
    expect(html).not.toContain("reconstructed samples had enough location data");
    expect(html).not.toContain("playerChartLine");
  });

  it("makes every observed activity hour focusable and exposes its hour immediately", () => {
    const activityHours = Array.from({ length: 24 }, (_, hour) => ({
      hour,
      averagePlayers: hour === 7 ? 2.5 : 1,
      peakPlayers: hour === 7 ? 4 : 2,
      samples: 1
    }));
    const html = render({ insights: insights({ activityHours }) });

    expect(html).toContain('class="playerActivityBar" style="--player-activity-height:100%" tabindex="0" aria-label="07:00, 2.5 players on average, peak 4"');
    expect(html).toContain('<span class="playerActivityHourLabel" aria-hidden="true"><strong>07:00</strong><small>2.5 avg · 4 peak</small></span>');
    expect(html).not.toContain('title="07:00');
  });
});
