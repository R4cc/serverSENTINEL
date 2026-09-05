import type { PlayerActivityHour, PlayerInsightsEntry, PlayerLocation, PlayerMaintenanceWindow } from "../../types";

/**
 * The presentation decisions Player Insights makes, kept out of the components so they can be
 * tested as the small pure functions they are.
 *
 * An absent measurement stays absent. Nothing in this file invents a fallback number: where the
 * panel could not measure something, these return an em dash.
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
  accuracyRadiusKm?: number;
  label: string;
  pingMs?: number;
};

/** Broad region labels come from geolocation metadata. */
export function playerMapRegion(location: PlayerLocation | undefined) {
  if (!location) return "Nearby locations";
  if (location.continentCode !== "AS" && location.continent !== "Asia") return location.continent ?? location.country ?? "Nearby locations";
  const code = location.countryCode ?? "";
  if ("BN KH ID LA MY MM PH SG TH TL VN".split(" ").includes(code)) return "Southeast Asia";
  if ("AF BD BT IN MV NP PK LK".split(" ").includes(code)) return "South Asia";
  if ("KZ KG TJ TM UZ".split(" ").includes(code)) return "Central Asia";
  if ("AM AZ BH CY GE IQ IR IL JO KW LB OM PS QA SA SY TR AE YE".split(" ").includes(code)) return "Middle East / Western Asia";
  if (code === "RU") return "Northern Asia";
  if ("CN HK JP MO MN KP KR TW".split(" ").includes(code)) return "East Asia";
  return "Asia";
}

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
  collisionDistancePx = 32,
  zoomScale = 1
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
  const scale = renderedWidth > 0 ? renderedWidth * zoomScale / width : 1;
  const collisionDistance = Math.max(collisionDistancePx / scale, Number.EPSILON);
  const collisionDistanceSquared = collisionDistance ** 2;
  // Only marks in the same or an adjacent collision-sized cell can overlap. Keeping those small
  // neighbourhoods avoids comparing every historical player with every other player as the map
  // grows, while the union step retains the exact transitive clustering behaviour.
  const cells = new Map<string, number[]>();
  placed.forEach((candidate, index) => {
    const cellX = Math.floor(candidate.point.x / collisionDistance);
    const cellY = Math.floor(candidate.point.y / collisionDistance);
    for (let x = cellX - 1; x <= cellX + 1; x += 1) {
      for (let y = cellY - 1; y <= cellY + 1; y += 1) {
        for (const otherIndex of cells.get(`${x}:${y}`) ?? []) {
          const deltaX = candidate.point.x - placed[otherIndex].point.x;
          const deltaY = candidate.point.y - placed[otherIndex].point.y;
          if (deltaX * deltaX + deltaY * deltaY <= collisionDistanceSquared) join(index, otherIndex);
        }
      }
    }
    const key = `${cellX}:${cellY}`;
    const cell = cells.get(key);
    if (cell) cell.push(index);
    else cells.set(key, [index]);
  });

  const groups = new Map<number, typeof placed>();
  placed.forEach((candidate, index) => {
    const root = find(index);
    const group = groups.get(root);
    if (group) group.push(candidate);
    else groups.set(root, [candidate]);
  });

  // Stacked heads are wider than individual heads. Merge only overlapping footprints,
  // instead of pushing their badges into a different geographic region.
  const visibleGroups = [...groups.values()];
  const footprint = (group: typeof placed) => ({
    x: group.reduce((sum, item) => sum + item.point.x, 0) / group.length * scale,
    y: group.reduce((sum, item) => sum + item.point.y, 0) / group.length * scale,
    halfWidth: group.length > 1 ? 46 : 16
  });
  for (let left = 0; left < visibleGroups.length; left++) {
    for (let right = left + 1; right < visibleGroups.length; right++) {
      const a = footprint(visibleGroups[left]);
      const b = footprint(visibleGroups[right]);
      if (Math.abs(a.x - b.x) < a.halfWidth + b.halfWidth + 2 && Math.abs(a.y - b.y) < 36) {
        visibleGroups[left].push(...visibleGroups[right]);
        visibleGroups.splice(right, 1);
        left = -1;
        break;
      }
    }
  }
  const marks = visibleGroups.map((group): PlayerMapMark => {
    const centre = group.reduce(
      (total, candidate) => ({ longitude: total.longitude + candidate.longitude, latitude: total.latitude + candidate.latitude }),
      { longitude: 0, latitude: 0 }
    );
    const members = group
      .map(({ entry }) => entry)
      .sort((left, right) => left.player.localeCompare(right.player));
    const pings = members.flatMap((entry) => {
      const ping = entry.online ? entry.pingMs : entry.lastSessionAveragePingMs ?? entry.pingMs;
      return ping === undefined ? [] : [ping];
    });
    const labels = [...new Set(members.map((entry) => entry.location?.label).filter((label): label is string => Boolean(label)))];
    const regions = [...new Set(members.map((entry) => playerMapRegion(entry.location)))].sort();
    const accuracyRadii = members.flatMap((entry) => entry.location?.accuracyRadiusKm === undefined ? [] : [entry.location.accuracyRadiusKm]);
    const id = members.map((entry) => `${entry.serverId}:${entry.player.toLowerCase()}`).sort().join("|");
    return {
      id,
      longitude: centre.longitude / group.length,
      latitude: centre.latitude / group.length,
      players: members.map((entry) => entry.player),
      entries: members,
      ...(accuracyRadii.length ? { accuracyRadiusKm: Math.max(...accuracyRadii) } : {}),
      label: members.length === 1 || zoomScale >= 3
        ? (labels.length === 1 ? labels[0] : [...new Set(members.map((entry) => entry.location?.country).filter(Boolean))].join(" / ") || regions.join(" / "))
        : regions.length > 2 ? "Multiple regions" : regions.join(" / "),
      ...(pings.length
        ? { pingMs: Math.round(pings.reduce((total, ping) => total + ping, 0) / pings.length) }
        : {})
    };
  });

  return marks.sort((left, right) => left.players.length - right.players.length);
}

export type PlayerMapArc = {
  path: string;
  controls: [{ x: number; y: number }, { x: number; y: number }];
  distance: number;
};

/** Only badges move to make space. Geographic anchors and the server never participate in layout. */
export function layoutPlayerMapBadges(
  marks: readonly PlayerMapMark[],
  server: { x: number; y: number } | undefined,
  scale: number,
  width = 720,
  height = 360
) {
  const pixelsPerUnit = Math.max(scale, 0.01);
  const hub = server ? marks
    .filter((mark) => {
      const anchor = projectToMap(mark.longitude, mark.latitude, width, height);
      return Math.abs(anchor.x - server.x) * pixelsPerUnit < 50
        && Math.abs(anchor.y - server.y) * pixelsPerUnit < 34;
    })
    .sort((a, b) => {
      const left = projectToMap(a.longitude, a.latitude, width, height);
      const right = projectToMap(b.longitude, b.latitude, width, height);
      return Math.hypot(left.x - server.x, left.y - server.y) - Math.hypot(right.x - server.x, right.y - server.y);
    })[0] : undefined;
  return [...marks].sort((a, b) => a.id.localeCompare(b.id)).map((mark) => {
    const anchor = projectToMap(mark.longitude, mark.latitude, width, height);
    const halfWidth = mark.entries.length > 1 ? 43 : 16;
    const nearServer = server && mark === hub;
    // The hub stays at the server longitude, with player heads immediately below it.
    const preferred = nearServer ? { x: server.x, y: server.y + 22 / pixelsPerUnit } : anchor;
    const point = clampPlayerMapPoint(preferred, pixelsPerUnit,
      { left: halfWidth + 4, right: halfWidth + 4, top: 22, bottom: 22 }, width, height);
    return { mark, anchor, point, hub: Boolean(nearServer) };
  });
}

/** Nearby locations connect almost directly; longer routes retain a northward arc. */
export function playerMapArc(
  start: { x: number; y: number },
  end: { x: number; y: number }
): PlayerMapArc {
  const delta = { x: end.x - start.x, y: end.y - start.y };
  const distance = Math.hypot(delta.x, delta.y);
  // Ease out the bow over 80 map units (40 degrees), independently of the zoom level.
  const proximity = Math.min(1, distance / 80);
  const curvature = proximity * proximity * (3 - 2 * proximity);
  const lift = Math.min(72, distance * 0.18) * curvature;
  const northLimit = Math.min(8, start.y, end.y);
  const direction = distance > 0 ? { x: delta.x / distance, y: delta.y / distance } : { x: 1, y: 0 };
  let normal = { x: -direction.y, y: direction.x };
  if (normal.y > 0) normal = { x: -normal.x, y: -normal.y };
  const controls: PlayerMapArc["controls"] = [
    {
      x: start.x + delta.x * 0.32 + normal.x * lift,
      y: Math.max(northLimit, start.y + delta.y * 0.32 + normal.y * lift)
    },
    {
      x: start.x + delta.x * 0.68 + normal.x * lift,
      y: Math.max(northLimit, start.y + delta.y * 0.68 + normal.y * lift)
    }
  ];
  return {
    path: `M ${start.x.toFixed(1)} ${start.y.toFixed(1)} C ${controls[0].x.toFixed(1)} ${controls[0].y.toFixed(1)} ${controls[1].x.toFixed(1)} ${controls[1].y.toFixed(1)} ${end.x.toFixed(1)} ${end.y.toFixed(1)}`,
    controls,
    distance
  };
}

export function clampPlayerMapPoint(
  point: { x: number; y: number },
  renderedScale: number,
  extentsPx: { left: number; right: number; top: number; bottom: number },
  width = 720,
  height = 360
) {
  if (renderedScale <= 0) return point;
  const left = extentsPx.left / renderedScale;
  const right = extentsPx.right / renderedScale;
  const top = extentsPx.top / renderedScale;
  const bottom = extentsPx.bottom / renderedScale;
  return {
    x: Math.min(width - right, Math.max(left, point.x)),
    y: Math.min(height - bottom, Math.max(top, point.y))
  };
}

export function playerMapPopupPlacement({
  marker,
  panel,
  viewport,
  inset = 8,
  gap = 10
}: {
  marker: { left: number; right: number; top: number; bottom: number };
  panel: { width: number; height: number };
  viewport: { width: number; height: number };
  inset?: number;
  gap?: number;
}) {
  const maxWidth = Math.max(0, viewport.width - inset * 2);
  const width = Math.min(panel.width, maxWidth);
  const left = Math.min(
    viewport.width - inset - width,
    Math.max(inset, (marker.left + marker.right - width) / 2)
  );
  const spaceAbove = Math.max(0, marker.top - inset - gap);
  const spaceBelow = Math.max(0, viewport.height - inset - marker.bottom - gap);
  const placement = panel.height <= spaceBelow || (panel.height > spaceAbove && spaceBelow >= spaceAbove)
    ? "below" as const
    : "above" as const;
  const maxHeight = placement === "below" ? spaceBelow : spaceAbove;
  const height = Math.min(panel.height, maxHeight);
  const top = placement === "below" ? marker.bottom + gap : marker.top - gap - height;
  return { placement, left, top, maxWidth, maxHeight };
}

/** Bands chosen so the colour says something a player would recognise, not merely "higher". */
export function latencyTone(pingMs: number | undefined) {
  if (pingMs === undefined) return "neutral" as const;
  if (pingMs < 60) return "success" as const;
  if (pingMs < 120) return "info" as const;
  if (pingMs < 200) return "warning" as const;
  return "danger" as const;
}

export function formatPing(pingMs: number | undefined) {
  return pingMs === undefined ? unknownValue : `${pingMs} ms`;
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
