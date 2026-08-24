import { describe, expect, it } from "vitest";
import type { PlayerActivityHour, PlayerInsightsEntry, PlayerLocation } from "../../types";
import {
  accuracyRadiusToMapUnits,
  countryFlag,
  formatDistance,
  formatEstimatedLatency,
  formatLocation,
  formatMaintenanceWindow,
  latencyTone,
  locationAccuracyPresentation,
  observedActivityHours,
  peakActivity,
  playerMapArc,
  playerMapLabelPoint,
  playerMapMarks,
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
  it("collects players in the same place into one mark", () => {
    const marks = playerMapMarks([
      entry("A", { online: true }),
      entry("B", { location: location({ latitude: 55.7, longitude: 12.6 }) }),
      entry("C", { location: location({ label: "Tokyo", latitude: 35.68, longitude: 139.69, accuracyRadiusKm: 50 }) })
    ]);
    expect(marks).toHaveLength(2);
    const copenhagen = marks.find((mark) => mark.players.includes("A"));
    expect(copenhagen?.players).toEqual(["A", "B"]);
    expect(copenhagen?.online).toBe(1);
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
      entry("Slow", { estimatedLatencyMs: 180 }),
      entry("Unknown", { estimatedLatencyMs: undefined }),
      entry("Fast", { online: true, estimatedLatencyMs: 20 })
    ]);
    expect(marks[0].entries.map((member) => member.player)).toEqual(["Fast", "Slow", "Unknown"]);
    expect(marks[0].estimatedLatencyMs).toBe(100);
    expect(marks[0].online).toBe(1);
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

  it("draws a curved route and keeps its label a stable distance from the player marker", () => {
    const arc = playerMapArc({ x: 360, y: 80 }, { x: 160, y: 160 });
    expect(arc.path).toMatch(/^M .* C .*$/);
    expect(arc.controls).toHaveLength(2);
    expect(Math.min(...arc.controls.map((control) => control.y))).toBeLessThan(120);
    const label = playerMapLabelPoint(arc, { x: 160, y: 160 }, 2);
    expect(Math.hypot(label.x - 160, label.y - 160)).toBeCloseTo(23);
  });
});

describe("how figures are written", () => {
  it("says nothing rather than zero when a value could not be derived", () => {
    expect(formatEstimatedLatency(undefined)).toBe(unknownValue);
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
