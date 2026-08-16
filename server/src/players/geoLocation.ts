import { isIP } from "node:net";
import {
  isPlayerContinentCode,
  playerCityAccuracyRadiusLimitKm,
  playerContinentNames,
  type PlayerLocation,
  type PlayerLocationPrecision
} from "@serversentinel/contracts";

/**
 * Turning one GeoLite2 City answer into the location the rest of the feature uses.
 *
 * Nothing here talks to MaxMind. The reader is a local MMDB file and this module only decides how
 * much of what it returns may honestly be shown: a city is a city while its accuracy radius stays
 * small, and an area the size of a country is described as one however precisely it is named.
 */

/** The shape of `@maxmind/geoip2-node`'s city response that this panel reads. */
export type GeoCityResponse = {
  city?: { names?: Record<string, string> };
  subdivisions?: Array<{ isoCode?: string; names?: Record<string, string> }>;
  country?: { isoCode?: string; names?: Record<string, string> };
  registeredCountry?: { isoCode?: string; names?: Record<string, string> };
  continent?: { code?: string; names?: Record<string, string> };
  location?: { latitude?: number; longitude?: number; accuracyRadius?: number };
};

export type GeoCityReader = {
  city(address: string): GeoCityResponse;
};

function englishName(names: Record<string, string> | undefined) {
  const value = names?.en?.trim();
  return value || undefined;
}

function finiteCoordinate(value: unknown, limit: number) {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= limit ? value : undefined;
}

/**
 * Whether an address can meaningfully be located at all.
 *
 * A player on the same LAN as the server, or reaching it over a Docker bridge, has an address that
 * describes the network rather than the world. Looking those up would waste the query and, worse,
 * would file the resulting miss as if the player's location were merely unknown when in fact it is
 * unknowable from here — the UI says so instead.
 */
export function isLocatableAddress(address: string) {
  const version = isIP(address);
  if (version === 4) {
    const octets = address.split(".").map(Number);
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
    const [first, second] = octets;
    if (first === 10 || first === 127 || first === 0) return false;
    if (first === 172 && second >= 16 && second <= 31) return false;
    if (first === 192 && second === 168) return false;
    if (first === 169 && second === 254) return false;
    // Carrier-grade NAT: a real subscriber is behind it, but the address itself is not routable and
    // GeoLite2 has nothing to say about it.
    if (first === 100 && second >= 64 && second <= 127) return false;
    return first < 224;
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    if (normalized === "::1" || normalized === "::") return false;
    // Unique local (fc00::/7) and link-local (fe80::/10).
    if (/^f[cd]/.test(normalized) || /^fe[89ab]/.test(normalized)) return false;
    // IPv4-mapped addresses carry an IPv4 address that has to be judged on its own terms.
    const mapped = normalized.match(/^::ffff:(?<ipv4>\d{1,3}(?:\.\d{1,3}){3})$/);
    if (mapped) return isLocatableAddress(mapped.groups!.ipv4);
    return true;
  }
  return false;
}

/**
 * The location a GeoLite2 answer supports, or undefined when it supports none.
 *
 * `precision` degrades with the accuracy radius rather than with which fields happen to be
 * populated: GeoLite2 will name a city for an address it can only place within several hundred
 * kilometres, and presenting that as a city would be the one dishonest thing this feature could do.
 */
export function playerLocationFromCityResponse(response: GeoCityResponse): PlayerLocation | undefined {
  const city = englishName(response.city?.names);
  const subdivision = englishName(response.subdivisions?.[0]?.names);
  const country = englishName(response.country?.names) ?? englishName(response.registeredCountry?.names);
  const countryCode = response.country?.isoCode?.trim() || response.registeredCountry?.isoCode?.trim() || undefined;
  const continentCode = isPlayerContinentCode(response.continent?.code) ? response.continent.code : undefined;
  const continent = continentCode ? playerContinentNames[continentCode] : englishName(response.continent?.names);
  const latitude = finiteCoordinate(response.location?.latitude, 90);
  const longitude = finiteCoordinate(response.location?.longitude, 180);
  const accuracyRadiusKm = typeof response.location?.accuracyRadius === "number" && response.location.accuracyRadius > 0
    ? Math.round(response.location.accuracyRadius)
    : undefined;

  const cityIsTrustworthy = Boolean(city) && (accuracyRadiusKm === undefined || accuracyRadiusKm <= playerCityAccuracyRadiusLimitKm);
  const precision: PlayerLocationPrecision = cityIsTrustworthy ? "city" : subdivision ? "region" : "country";
  const label = cityIsTrustworthy ? city! : subdivision ?? country ?? continent;
  if (!label) return undefined;

  return {
    label,
    ...(city ? { city } : {}),
    ...(subdivision ? { subdivision } : {}),
    ...(country ? { country } : {}),
    ...(countryCode ? { countryCode } : {}),
    ...(continent ? { continent } : {}),
    ...(continentCode ? { continentCode } : {}),
    ...(latitude !== undefined ? { latitude } : {}),
    ...(longitude !== undefined ? { longitude } : {}),
    ...(accuracyRadiusKm !== undefined ? { accuracyRadiusKm } : {}),
    precision
  };
}

/** Resolves one address against a local reader. Returns undefined for anything unlocatable. */
export function locateAddress(reader: GeoCityReader | undefined, address: string): PlayerLocation | undefined {
  if (!reader || !isLocatableAddress(address)) return undefined;
  try {
    return playerLocationFromCityResponse(reader.city(address) as GeoCityResponse);
  } catch {
    // A miss is ordinary: GeoLite2 does not cover every allocation, and the reader throws for the
    // ones it has nothing for. The caller records the player without a location.
    return undefined;
  }
}

/** How a location should be written on one line, longest useful form first. */
export function describeLocation(location: PlayerLocation | undefined) {
  if (!location) return "Unknown location";
  const parts = location.precision === "city"
    ? [location.city, location.subdivision, location.country]
    : location.precision === "region"
      ? [location.subdivision, location.country]
      : [location.country];
  const described = parts.filter((part): part is string => Boolean(part));
  return described.length ? [...new Set(described)].join(", ") : location.label;
}
