import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import type { PlayerInsightsServerLocation, PlayerLocation } from "@serversentinel/contracts";
import type { StorageDatabase } from "../storage/database.js";
import { badRequest } from "../http/validation.js";
import { isLocatableAddress, locateAddress, type GeoCityReader } from "./geoLocation.js";

/**
 * Where the panel measures a player's distance from.
 *
 * A latency estimate needs two positions, and the panel knows only one of them for free. A node
 * reaches the panel over an outbound websocket and nothing records the address it came from, and
 * asking the internet for the host's own public address would be exactly the third-party call this
 * feature refuses to make. So the reference point is the one thing the operator already knows: the
 * address players connect to. It is stored as configuration, resolved locally against the same
 * GeoLite2 database everything else uses, and re-resolved whenever the database is replaced.
 *
 * A server with no address configured simply has no distances, and the module says so instead of
 * inventing a reference point.
 */

const serverLocationsKey = "playerInsights.serverLocations";
const maxAddressLength = 253;

type StoredServerLocation = {
  address?: string;
  location?: PlayerLocation;
  resolvedAt?: string;
  error?: string;
};

type StoredServerLocations = Record<string, StoredServerLocation>;

/**
 * Accepts a hostname or a literal address, and nothing that could smuggle something else through.
 * Anything with a scheme, path, port, or credentials is rejected rather than silently trimmed.
 */
export function normalizeServerAddress(value: string) {
  let trimmed = value.trim();
  if (trimmed.startsWith("[") || trimmed.endsWith("]")) {
    if (!(trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      badRequest("Enter the public hostname or IP address players connect to, without a scheme or port.");
    }
    trimmed = trimmed.slice(1, -1);
  }
  if (!trimmed) return "";
  if (trimmed.length > maxAddressLength) badRequest("The server address is too long.");
  if (isIP(trimmed)) return trimmed;
  if (!/^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/.test(trimmed)) {
    badRequest("Enter the public hostname or IP address players connect to, without a scheme or port.");
  }
  return trimmed.toLowerCase();
}

function readAll(storage: StorageDatabase): StoredServerLocations {
  const raw = storage.metadata(serverLocationsKey);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as StoredServerLocations : {};
  } catch {
    return {};
  }
}

function writeAll(storage: StorageDatabase, value: StoredServerLocations) {
  storage.setMetadata(serverLocationsKey, JSON.stringify(value));
}

export class ServerLocationStore {
  constructor(private readonly storage: StorageDatabase) {}

  get(serverId: string): PlayerInsightsServerLocation {
    const stored = readAll(this.storage)[serverId];
    return { serverId, ...(stored ?? {}) };
  }

  /** Every configured reference point, filtered to servers this installation still has. */
  list(serverIds: readonly string[]): PlayerInsightsServerLocation[] {
    const stored = readAll(this.storage);
    return serverIds.map((serverId) => ({ serverId, ...(stored[serverId] ?? {}) }));
  }

  set(serverId: string, value: StoredServerLocation) {
    const all = readAll(this.storage);
    if (!value.address) delete all[serverId];
    else all[serverId] = value;
    writeAll(this.storage, all);
    return this.get(serverId);
  }

  /**
   * Replaces a resolved location only while it still belongs to the address that was resolved.
   * DNS and MMDB work is asynchronous; an operator can edit or clear the address while it is in
   * flight, and that newer choice must not be overwritten when the older lookup finishes.
   */
  setIfAddress(serverId: string, expectedAddress: string, value: StoredServerLocation) {
    const all = readAll(this.storage);
    if (all[serverId]?.address !== expectedAddress) return this.get(serverId);
    all[serverId] = value;
    writeAll(this.storage, all);
    return this.get(serverId);
  }

  /** Drops configuration for servers that no longer exist, so the key cannot grow without bound. */
  retain(serverIds: readonly string[]) {
    const all = readAll(this.storage);
    const keep = new Set(serverIds);
    let changed = false;
    for (const serverId of Object.keys(all)) {
      if (keep.has(serverId)) continue;
      delete all[serverId];
      changed = true;
    }
    if (changed) writeAll(this.storage, all);
  }
}

/**
 * Resolves a configured address to a location, locally.
 *
 * A hostname is turned into an address by the host's own resolver — a DNS lookup, not a
 * geolocation service — and the address is then read out of the local GeoLite2 database.
 */
export async function resolveServerLocation(
  reader: GeoCityReader | undefined,
  address: string,
  resolveHost: (hostname: string) => Promise<string> = async (hostname) => (await lookup(hostname)).address
): Promise<{ location?: PlayerLocation; error?: string }> {
  if (!reader) return { error: "No GeoLite2 database is available yet, so this address cannot be placed." };
  let resolved = address;
  if (!isIP(address)) {
    try {
      resolved = await resolveHost(address);
    } catch {
      return { error: `${address} could not be resolved to an address.` };
    }
  }
  if (!isLocatableAddress(resolved)) {
    return { error: `${address} resolves to a private address, which has no public location.` };
  }
  const location = locateAddress(reader, resolved);
  if (!location) return { error: `GeoLite2 has no location for ${address}.` };
  return { location };
}
