import type { ModrinthProject } from "../types.js";
import { modrinthFetch } from "./modrinthClient.js";

export type ModrinthSearchBody = { hits?: ModrinthProject[]; total_hits?: number; offset?: number; limit?: number };

const cacheTtlMs = 30_000;
const staleTtlMs = 5 * 60_000;
const maxEntries = 200;
const cache = new Map<string, { value: ModrinthSearchBody; cachedAt: number }>();
const requests = new Map<string, Promise<{ body: ModrinthSearchBody; cacheStatus: "miss" | "stale" }>>();

function setCached(key: string, value: ModrinthSearchBody) {
  cache.delete(key);
  cache.set(key, { value, cachedAt: Date.now() });
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export async function searchModrinth(url: string) {
  const cached = cache.get(url);
  if (cached && Date.now() - cached.cachedAt <= cacheTtlMs) {
    cache.delete(url);
    cache.set(url, cached);
    return { body: cached.value, cacheStatus: "hit" as const };
  }
  const pending = requests.get(url);
  if (pending) return pending;
  const request = (async () => {
    try {
      const response = await modrinthFetch(url);
      const body = await response.json() as ModrinthSearchBody;
      setCached(url, body);
      return { body, cacheStatus: "miss" as const };
    } catch (error) {
      if (cached && Date.now() - cached.cachedAt <= staleTtlMs) {
        return { body: cached.value, cacheStatus: "stale" as const };
      }
      throw error;
    }
  })().finally(() => requests.delete(url));
  requests.set(url, request);
  return request;
}

export function resetModrinthSearchCacheForTests() {
  cache.clear();
  requests.clear();
}
