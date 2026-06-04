import { fetch } from "undici";

type CacheEntry = {
  data: any;
  timestamp: number;
};
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour cache

export async function fabricMeta<T>(path: string): Promise<T> {
  const cached = cache.get(path);
  const now = Date.now();
  if (cached && now - cached.timestamp < CACHE_TTL_MS) {
    return cached.data as T;
  }
  const response = await fetch(`https://meta.fabricmc.net${path}`, {
    headers: {
      "User-Agent": "ServerSentinel/0.4.0 (Fabric server creator)"
    }
  });
  if (!response.ok) {
    throw new Error(`Fabric metadata request failed: ${response.status} ${response.statusText}`);
  }
  const data = await response.json();
  cache.set(path, { data, timestamp: now });
  return data as T;
}

export async function latestFabricVersion(kind: "loader" | "installer") {
  const versions = await fabricMeta<Array<{ version: string; stable: boolean }>>(`/v2/versions/${kind}`);
  const version = versions.find((candidate) => candidate.stable) ?? versions[0];
  if (!version) {
    throw new Error(`No Fabric ${kind} versions are available`);
  }
  return version.version;
}

