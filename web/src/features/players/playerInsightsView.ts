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
  entries: PlayerInsightsEntry[];
  online: number;
  accuracyRadiusKm?: number;
  label: string;
  estimatedLatencyMs?: number;
};

/**
 * Players collapsed into markers that would not collide at the current rendered map width.
 *
 * GeoLite2 often returns the same city centroid, but nearby centroids can still overlap once the
 * viewBox is scaled down. Measuring projected screen distance keeps those cases compact and lets
 * clusters change naturally with the responsive map instead of requiring identical coordinates.
 */
export function playerMapMarks(
  entries: readonly PlayerInsightsEntry[],
  width = 720,
  height = 360,
  renderedWidth = width,
  collisionDistancePx = 32
): PlayerMapMark[] {
  const placed = entries.flatMap((entry) => {
    const { latitude, longitude } = entry.location ?? {};
    return latitude === undefined || longitude === undefined
      ? []
      : [{ entry, latitude, longitude, point: projectToMap(longitude, latitude, width, height) }];
  });
  const parents = placed.map((_, index) => index);
  const find = (index: number): number => parents[index] === index ? index : (parents[index] = find(parents[index]));
  const join = (left: number, right: number) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };
  const scale = renderedWidth > 0 ? renderedWidth / width : 1;
  for (let left = 0; left < placed.length; left += 1) {
    for (let right = left + 1; right < placed.length; right += 1) {
      const distancePx = Math.hypot(
        placed[left].point.x - placed[right].point.x,
        placed[left].point.y - placed[right].point.y
      ) * scale;
      if (distancePx <= collisionDistancePx) join(left, right);
    }
  }

  const groups = new Map<number, typeof placed>();
  placed.forEach((candidate, index) => {
    const root = find(index);
    groups.set(root, [...(groups.get(root) ?? []), candidate]);
  });

  const marks = [...groups.values()].map((group): PlayerMapMark => {
    const members = group
      .map(({ entry }) => entry)
      .sort((left, right) => Number(right.online) - Number(left.online) || left.player.localeCompare(right.player));
    const latencies = members.flatMap((entry) => entry.estimatedLatencyMs === undefined ? [] : [entry.estimatedLatencyMs]);
    const labels = [...new Set(members.map((entry) => entry.location?.label).filter((label): label is string => Boolean(label)))];
    const accuracyRadii = members.flatMap((entry) => entry.location?.accuracyRadiusKm === undefined ? [] : [entry.location.accuracyRadiusKm]);
    const id = members.map((entry) => `${entry.serverId}:${entry.player.toLowerCase()}`).sort().join("|");
    return {
      id,
      longitude: group.reduce((total, candidate) => total + candidate.longitude, 0) / group.length,
      latitude: group.reduce((total, candidate) => total + candidate.latitude, 0) / group.length,
      players: members.map((entry) => entry.player),
      entries: members,
      online: members.filter((entry) => entry.online).length,
      ...(accuracyRadii.length ? { accuracyRadiusKm: Math.max(...accuracyRadii) } : {}),
      label: labels.length === 1 ? labels[0] : `${labels[0] ?? "Nearby locations"} area`,
      ...(latencies.length
        ? { estimatedLatencyMs: Math.round(latencies.reduce((total, latency) => total + latency, 0) / latencies.length) }
        : {})
    };
  });

  return marks.sort((left, right) => left.players.length - right.players.length);
}

export type PlayerMapArc = {
  path: string;
  control: { x: number; y: number };
  label: { x: number; y: number };
  distance: number;
};

/** A restrained northward quadratic arc, with its label beyond the crowded server end. */
export function playerMapArc(
  start: { x: number; y: number },
  end: { x: number; y: number }
): PlayerMapArc {
  const distance = Math.hypot(end.x - start.x, end.y - start.y);
  const lift = Math.min(88, Math.max(12, distance * 0.22));
  const control = {
    x: (start.x + end.x) / 2,
    y: Math.max(8, (start.y + end.y) / 2 - lift)
  };
  const labelT = 0.58;
  const inverseT = 1 - labelT;
  const label = {
    x: inverseT * inverseT * start.x + 2 * inverseT * labelT * control.x + labelT * labelT * end.x,
    y: inverseT * inverseT * start.y + 2 * inverseT * labelT * control.y + labelT * labelT * end.y
  };
  return {
    path: `M ${start.x.toFixed(1)} ${start.y.toFixed(1)} Q ${control.x.toFixed(1)} ${control.y.toFixed(1)} ${end.x.toFixed(1)} ${end.y.toFixed(1)}`,
    control,
    label,
    distance
  };
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

export function formatDistance(distanceKm: number | undefined, formatNumber: (value: number) => string) {
  if (distanceKm === undefined) return unknownValue;
  return `${formatNumber(Math.round(distanceKm))} km`;
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

/** Turn an ISO 3166-1 alpha-2 code into its two regional-indicator characters. */
export function countryFlag(countryCode: string | undefined) {
  const normalized = countryCode?.trim().toUpperCase() ?? "";
  if (!/^[A-Z]{2}$/.test(normalized)) return "";
  return [...normalized]
    .map((character) => String.fromCodePoint(127_397 + character.charCodeAt(0)))
    .join("");
}

export type LocationAccuracyPresentation = {
  label: "Precise" | "Approx" | "Broad";
  tone: "precise" | "approx" | "broad";
  description: string;
};

/** A compact, honest description of the IP-derived location's useful precision. */
export function locationAccuracyPresentation(location: PlayerLocation | undefined): LocationAccuracyPresentation | undefined {
  if (!location) return undefined;
  const radius = location.accuracyRadiusKm;
  if (location.precision === "country") {
    return {
      label: "Broad",
      tone: "broad",
      description: "IP-based location estimate. Only the player's country could be determined reliably."
    };
  }
  if (location.precision === "region") {
    return {
      label: "Approx",
      tone: "approx",
      description: radius
        ? `IP-based location estimate. Only the broader area can be determined reliably; expected accuracy is roughly within ${radius} km.`
        : "IP-based location estimate. Only the broader area can be determined reliably."
    };
  }
  return {
    label: "Precise",
    tone: "precise",
    description: radius
      ? `IP-based location estimate. Expected accuracy is roughly within ${radius} km.`
      : "IP-based location estimate. The city or nearby area can usually be determined."
  };
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
