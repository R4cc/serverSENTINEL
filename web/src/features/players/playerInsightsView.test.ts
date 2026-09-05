import { describe, expect, it } from "vitest";
import type { PlayerActivityHour, PlayerInsightsEntry, PlayerLocation } from "../../types";
import {
  accuracyRadiusToMapUnits,
  clampPlayerMapPoint,
  countryFlag,
  formatDistance,
  formatPing,
  formatLocation,
  formatMaintenanceWindow,
  latencyTone,
  layoutPlayerMapBadges,
  locationAccuracyPresentation,
  observedActivityHours,
  peakActivity,
  playerMapArc,
  playerMapMarks,
  playerMapPopupPlacement,
  projectToMap,
  rangeWindowMs,
  unknownValue
} from "./playerInsightsView";

function location(overrides: Partial<PlayerLocation> = {}): PlayerLocation {
  return { label: "Copenhagen", city: "Copenhagen", subdivision: "Capital Region", country: "Denmark", countryCode: "DK", continent: "Europe", continentCode: "EU", latitude: 55.68, longitude: 12.57, accuracyRadiusKm: 20, precision: "city", ...overrides };
}

function entry(player: string, overrides: Partial<PlayerInsightsEntry> = {}): PlayerInsightsEntry {
  return { player, serverId: "server-1", serverName: "Survival", online: false, location: location(), observations: 1, ...overrides };
}

describe("map projection", () => {
  it("puts the origin in the middle and the corners at the corners", () => {
    expect(projectToMap(0, 0, 720, 360)).toEqual({ x: 360, y: 180 });
    expect(projectToMap(-180, 90, 720, 360)).toEqual({ x: 0, y: 0 });
    expect(projectToMap(180, -90, 720, 360)).toEqual({ x: 720, y: 360 });
  });

  it("scales an accuracy radius into the same frame", () => {
    // A degree is 2 units wide at this size, and roughly 111 km at the equator.
    expect(Math.round(accuracyRadiusToMapUnits(111, 720))).toBe(2);
    expect(accuracyRadiusToMapUnits(0, 720)).toBe(0);
  });
});

describe("map marks", () => {
  it.each([0.4, 0.75, 1, 1.5, 2, 4])("keeps dense player badges clear of the fixed server at scale %s", (scale) => {
    const players = Array.from({ length: 120 }, (_, index) => entry(`Player${index}`, {
      location: location({ longitude: 12.57 + (index % 5) * 0.2, latitude: 55.68 + (index % 3) * 0.2 })
    }));
    const server = projectToMap(12.57, 55.68, 720, 360);
    const marks = playerMapMarks(players, 720, 360, 720 * scale);
    const badges = layoutPlayerMapBadges(marks, server, scale);
    expect(badges.flatMap(({ mark }) => mark.entries)).toHaveLength(120);
    for (const badge of badges) {
      expect(badge.anchor).toEqual(projectToMap(badge.mark.longitude, badge.mark.latitude, 720, 360));
      const dx = Math.abs(badge.point.x - server.x) * scale;
      const dy = Math.abs(badge.point.y - server.y) * scale;
      expect(dx >= 56 || dy >= 42).toBe(true);
    }
    expect(server).toEqual(projectToMap(12.57, 55.68, 720, 360));
  });

  it("contains edge badges without moving their geographic anchors", () => {
    const marks = playerMapMarks([entry("Edge", { location: location({ longitude: 179.9, latitude: -89.9 }) })]);
    const [badge] = layoutPlayerMapBadges(marks, undefined, 0.4);
    expect(badge.anchor).toEqual(projectToMap(179.9, -89.9, 720, 360));
    expect(badge.point.x * 0.4).toBeLessThanOrEqual(720 * 0.4 - 20);
    expect(badge.point.y * 0.4).toBeLessThanOrEqual(360 * 0.4 - 20);
  });
  it("collects players in the same place into one mark", () => {
    const marks = playerMapMarks([
      entry("A", { online: true }),
      entry("B", { location: location({ latitude: 55.7, longitude: 12.6 }) }),
      entry("C", { location: location({ label: "Tokyo", latitude: 35.68, longitude: 139.69, accuracyRadiusKm: 50 }) })
    ]);
    expect(marks).toHaveLength(2);
    const copenhagen = marks.find((mark) => mark.players.includes("A"));
    expect(copenhagen?.players).toEqual(["A", "B"]);
  });

  it("keeps the widest accuracy radius of everyone at a place", () => {
    const marks = playerMapMarks([
      entry("A", { location: location({ accuracyRadiusKm: 20 }) }),
      entry("B", { location: location({ accuracyRadiusKm: 200 }) })
    ]);
    expect(marks[0].accuracyRadiusKm).toBe(200);
  });

  it("clusters by rendered collision distance and recomputes when the map narrows", () => {
    const nearby = [
      entry("A", { location: location({ latitude: 0, longitude: 0 }) }),
      entry("B", { location: location({ latitude: 0, longitude: 20 }) })
    ];
    expect(playerMapMarks(nearby, 720, 360, 720, 34)).toHaveLength(2);
    expect(playerMapMarks(nearby, 720, 360, 360, 34)).toHaveLength(1);
  });

  it("retains every member and averages only the cluster pings it knows", () => {
    const marks = playerMapMarks([
      entry("Slow", { pingMs: 180 }),
      entry("Unknown", { pingMs: undefined }),
      entry("Fast", { online: true, pingMs: 20 })
    ]);
    expect(marks[0].entries.map((member) => member.player)).toEqual(["Fast", "Slow", "Unknown"]);
    expect(marks[0].pingMs).toBe(100);
  });

  it("leaves out players who could not be placed", () => {
    expect(playerMapMarks([entry("A", { location: undefined }), entry("B", { location: { label: "Nowhere", precision: "country" } })])).toEqual([]);
  });

  it("draws the busiest place last so it is not hidden behind a quiet one", () => {
    const marks = playerMapMarks([
      entry("A", { location: location({ latitude: 35.68, longitude: 139.69 }) }),
      entry("B"),
      entry("C")
    ]);
    expect(marks.at(-1)?.players).toHaveLength(2);
  });

  it("draws a curved route between reported locations", () => {
    const arc = playerMapArc({ x: 360, y: 80 }, { x: 160, y: 160 });
    expect(arc.path).toMatch(/^M .* C .*$/);
    expect(arc.controls).toHaveLength(2);
    expect(Math.min(...arc.controls.map((control) => control.y))).toBeLessThan(120);
  });

  it("flips panels above or below markers using the visible viewport", () => {
    expect(playerMapPopupPlacement({
      marker: { left: 340, right: 380, top: 278, bottom: 322 },
      panel: { width: 220, height: 120 },
      viewport: { width: 720, height: 360 }
    })).toEqual({ placement: "above", left: 250, top: 148, maxWidth: 704, maxHeight: 260 });
    expect(playerMapPopupPlacement({
      marker: { left: 340, right: 380, top: 18, bottom: 62 },
      panel: { width: 220, height: 120 },
      viewport: { width: 720, height: 360 }
    })).toEqual({ placement: "below", left: 250, top: 72, maxWidth: 704, maxHeight: 280 });
  });

  it("clamps panels to horizontal edges and constrains their height on the roomier side", () => {
    expect(playerMapPopupPlacement({
      marker: { left: 690, right: 718, top: 20, bottom: 48 },
      panel: { width: 220, height: 90 },
      viewport: { width: 720, height: 360 }
    })).toEqual({ placement: "below", left: 492, top: 58, maxWidth: 704, maxHeight: 294 });
    expect(playerMapPopupPlacement({
      marker: { left: 2, right: 30, top: 20, bottom: 48 },
      panel: { width: 220, height: 90 },
      viewport: { width: 720, height: 360 }
    }).left).toBe(8);
    expect(playerMapPopupPlacement({
      marker: { left: 145, right: 175, top: 74, bottom: 104 },
      panel: { width: 300, height: 240 },
      viewport: { width: 320, height: 180 }
    })).toEqual({ placement: "below", left: 10, top: 114, maxWidth: 304, maxHeight: 58 });
  });

  it("keeps rendered marker extents inside every map edge", () => {
    expect(clampPlayerMapPoint(
      { x: 718, y: 358 },
      2,
      { left: 20, right: 24, top: 48, bottom: 20 }
    )).toEqual({ x: 708, y: 350 });
    expect(clampPlayerMapPoint(
      { x: 2, y: 3 },
      1,
      { left: 20, right: 24, top: 48, bottom: 20 }
    )).toEqual({ x: 20, y: 48 });
  });
});

describe("how figures are written", () => {
  it("says nothing rather than zero when a value could not be derived", () => {
    expect(formatPing(undefined)).toBe(unknownValue);
    expect(formatDistance(undefined, String)).toBe(unknownValue);
    expect(formatLocation(undefined)).toBe(unknownValue);
    expect(formatMaintenanceWindow(undefined, "UTC")).toBe(unknownValue);
    expect(latencyTone(undefined)).toBe("neutral");
  });

  it("bands latency the way a player would notice it", () => {
    expect(latencyTone(20)).toBe("success");
    expect(latencyTone(80)).toBe("info");
    expect(latencyTone(150)).toBe("warning");
    expect(latencyTone(260)).toBe("danger");
  });

  it("writes a place at the precision its accuracy radius supports", () => {
    expect(formatLocation(location())).toBe("Copenhagen, Denmark");
    expect(formatLocation(location({ precision: "region" }))).toBe("Capital Region, Denmark");
    expect(formatLocation(location({ precision: "country" }))).toBe("Denmark");
  });

  it("turns country codes into flags without inventing one for invalid data", () => {
    expect(countryFlag("dk")).toBe("🇩🇰");
    expect(countryFlag("GB")).toBe("🇬🇧");
    expect(countryFlag(undefined)).toBe("");
    expect(countryFlag("DEN")).toBe("");
  });

  it("maps stored precision to compact accuracy labels and honest explanations", () => {
    expect(locationAccuracyPresentation(location())).toEqual({
      label: "Precise",
      tone: "precise",
      description: "IP-based location estimate. Expected accuracy is roughly within 20 km."
    });
    expect(locationAccuracyPresentation(location({ precision: "region", accuracyRadiusKm: 500 }))).toMatchObject({
      label: "Approx",
      tone: "approx",
      description: expect.stringContaining("broader area")
    });
    expect(locationAccuracyPresentation(location({ precision: "country" }))).toEqual({
      label: "Broad",
      tone: "broad",
      description: "IP-based location estimate. Only the player's country could be determined reliably."
    });
    expect(locationAccuracyPresentation(undefined)).toBeUndefined();
  });

  it("formats whole kilometres with the selected locale", () => {
    const formatGermanNumber = (value: number) => new Intl.NumberFormat("de-DE").format(value);
    expect(formatDistance(671, formatGermanNumber)).toBe("671 km");
    expect(formatDistance(16_035, formatGermanNumber)).toBe("16.035 km");
  });

  it("names the maintenance window in the panel's own zone", () => {
    expect(formatMaintenanceWindow({ startHour: 2, endHour: 6, averagePlayers: 0.4 }, "Europe/Vienna")).toBe("02:00 – 06:00 Europe/Vienna");
  });
});

describe("activity hours", () => {
  const hours: PlayerActivityHour[] = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    averagePlayers: hour < 6 ? 0 : hour,
    peakPlayers: hour,
    samples: hour < 6 ? 0 : 10
  }));

  it("scales bars against the busiest hour and counts what has been seen", () => {
    expect(peakActivity(hours)).toBe(23);
    expect(observedActivityHours(hours)).toBe(18);
    expect(peakActivity([])).toBe(0);
  });
});

describe("range control", () => {
  it("maps each offered range onto a window, and falls back for anything else", () => {
    expect(rangeWindowMs("1h")).toBe(3_600_000);
    expect(rangeWindowMs("24h")).toBe(86_400_000);
    expect(rangeWindowMs("7d")).toBe(604_800_000);
  });
});
