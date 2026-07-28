import { RuntimeResolutionError } from "./profile.js";

type CacheEntry = {
  expiresAt: number;
  value: unknown;
};

const successTtlMs = 15 * 60_000;
const failureTtlMs = 30_000;

export class RuntimeProviderCache {
  private readonly entries = new Map<string, CacheEntry>();

  async read<T>(key: string, load: () => Promise<T>, forceRefresh = false): Promise<T> {
    const now = Date.now();
    const cached = this.entries.get(key);
    if (!forceRefresh && cached && cached.expiresAt > now) return cached.value as T;
    try {
      const value = await load();
      this.entries.set(key, { value, expiresAt: now + successTtlMs });
      return value;
    } catch (error) {
      if (!cached) throw error;
      cached.expiresAt = now + failureTtlMs;
      return cached.value as T;
    }
  }
}

export function withRuntimeProviderDetails(error: RuntimeResolutionError, details: string) {
  (error as RuntimeResolutionError & { details?: string }).details = details;
  return error;
}

export function runtimeProviderString(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new RuntimeResolutionError("no_runtime_artifact", `${field} is missing`);
  }
  return value.trim();
}
