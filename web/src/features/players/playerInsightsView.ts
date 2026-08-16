import type { PlayerActivityHour, PlayerInsightsEntry, PlayerLocation, PlayerMaintenanceWindow } from "../../types";

/**
 * The presentation decisions Player Insights makes, kept out of the components so they can be
 * tested as the small pure functions they are.
 *
 * The recurring rule here is that an estimate must read as an estimate and an absent value must
 * read as absent. Nothing in this file invents a fallback number: where the panel could not derive
 * something, these return an em dash and the caller shows the reason.
 */

export const unknownValue = "—";

/** Equirectangular projection, which is the frame the bundled coastline is stored in. */
export function projectToMap(longitude: number, latitude: number, width: number, height: number) {
  return {
    x: ((longitude + 180) / 360) * width,
    y: ((90 - latitude) / 180) * height
  };
}

/**
 * The accuracy radius drawn to the same scale as the map.
 *
 * A degree of longitude is a fixed width in this projection, so the radius is converted through the
 * equator's circumference. That overstates the circle nearer the poles, which is the safe direction
 * for something whose whole purpose is to stop a dot from looking like an address.
 */
export function accuracyRadiusToMapUnits(accuracyRadiusKm: number, width: number) {
  const kilometresPerDegree = 40_075 / 360;
  return Math.max(0, (accuracyRadiusKm / kilometresPerDegree) * (width / 360));
}

export type PlayerMapMark = {
  id: string;
  longitude: number;
  latitude: number;
  players: string[];
  online: number;
  accuracyRadiusKm?: number;
  label: string;
  estimatedLatencyMs?: number;
};

/**
 * Players collapsed into the places they connect from.
 *
 * Coordinates are rounded before grouping, so a city's worth of players is one mark rather than a
 * pile of overlapping dots — and so the map never suggests it can tell two players in the same city
 * apart, which it cannot.
 */
export function playerMapMarks(entries: readonly PlayerInsightsEntry[]): PlayerMapMark[] {
  const marks = new Map<string, PlayerMapMark>();
  for (const entry of entries) {
    const { latitude, longitude } = entry.location ?? {};
    if (latitude === undefined || longitude === undefined) continue;
    const roundedLatitude = Math.round(latitude * 2) / 2;
    const roundedLongitude = Math.round(longitude * 2) / 2;
    const id = `${roundedLongitude}:${roundedLatitude}`;
    const existing = marks.get(id);
    if (existing) {
      existing.players.push(entry.player);
      if (entry.online) existing.online += 1;
      if (entry.location?.accuracyRadiusKm !== undefined) {
        existing.accuracyRadiusKm = Math.max(existing.accuracyRadiusKm ?? 0, entry.location.accuracyRadiusKm);
      }
      continue;
    }
    marks.set(id, {
      id,
      longitude: roundedLongitude,
      latitude: roundedLatitude,
      players: [entry.player],
      online: entry.online ? 1 : 0,
      ...(entry.location?.accuracyRadiusKm !== undefined ? { accuracyRadiusKm: entry.location.accuracyRadiusKm } : {}),
      label: entry.location?.label ?? "Unknown location",
      ...(entry.estimatedLatencyMs !== undefined ? { estimatedLatencyMs: entry.estimatedLatencyMs } : {})
    });
  }
  // Busiest last, so a crowded place is drawn over a quiet one rather than behind it.
  return [...marks.values()].sort((left, right) => left.players.length - right.players.length);
}

/** Bands chosen so the colour says something a player would recognise, not merely "higher". */
export function latencyTone(estimatedLatencyMs: number | undefined) {
  if (estimatedLatencyMs === undefined) return "neutral" as const;
  if (estimatedLatencyMs < 60) return "success" as const;
  if (estimatedLatencyMs < 120) return "info" as const;
  if (estimatedLatencyMs < 200) return "warning" as const;
  return "danger" as const;
}

export function formatEstimatedLatency(estimatedLatencyMs: number | undefined) {
  return estimatedLatencyMs === undefined ? unknownValue : `${estimatedLatencyMs} ms`;
}

export function formatDistance(distanceKm: number | undefined) {
  if (distanceKm === undefined) return unknownValue;
  if (distanceKm < 1_000) return `${Math.round(distanceKm)} km`;
  return `${(distanceKm / 1_000).toFixed(1)} thousand km`;
}

/** The place on one line, at the precision the accuracy radius actually supports. */
export function formatLocation(location: PlayerLocation | undefined) {
  if (!location) return unknownValue;
  const parts = location.precision === "city"
    ? [location.city, location.country]
    : location.precision === "region"
      ? [location.subdivision, location.country]
      : [location.country];
  const described = [...new Set(parts.filter((part): part is string => Boolean(part)))];
  return described.length ? described.join(", ") : location.label;
}

/**
 * How precise this location is, said plainly. Shown beside every place name because a GeoLite2
 * city is the centre of an area, not where anybody is, and the interface should not let that be
 * forgotten.
 */
export function describeLocationPrecision(location: PlayerLocation | undefined) {
  if (!location) return "";
  const radius = location.accuracyRadiusKm;
  if (location.precision === "country") return "Country-level estimate";
  if (location.precision === "region") return radius ? `Region-level estimate, within about ${radius} km` : "Region-level estimate";
  return radius ? `Approximate, within about ${radius} km` : "Approximate";
}

function padHour(hour: number) {
  return `${String(hour).padStart(2, "0")}:00`;
}

export function formatMaintenanceWindow(window: PlayerMaintenanceWindow | undefined, timeZone: string) {
  if (!window) return unknownValue;
  return `${padHour(window.startHour)} – ${padHour(window.endHour)} ${timeZone}`;
}

/**
 * The busiest hour that has actually been observed, used to scale the activity bars. Zero when
 * nothing has been observed, which the caller renders as an empty state rather than a flat chart.
 */
export function peakActivity(hours: readonly PlayerActivityHour[]) {
  return hours.reduce((peak, hour) => Math.max(peak, hour.averagePlayers), 0);
}

export function observedActivityHours(hours: readonly PlayerActivityHour[]) {
  return hours.filter((hour) => hour.samples > 0).length;
}

export type PlayerInsightsRange = "1h" | "24h" | "7d";

export const playerInsightsRanges: readonly { id: PlayerInsightsRange; label: string; windowMs: number }[] = [
  { id: "1h", label: "1h", windowMs: 60 * 60 * 1000 },
  { id: "24h", label: "24h", windowMs: 24 * 60 * 60 * 1000 },
  { id: "7d", label: "7d", windowMs: 7 * 24 * 60 * 60 * 1000 }
];

export function rangeWindowMs(range: PlayerInsightsRange) {
  return playerInsightsRanges.find((candidate) => candidate.id === range)?.windowMs ?? 24 * 60 * 60 * 1000;
}
