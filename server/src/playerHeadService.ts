import { fetch as undiciFetch } from "undici";
import type { SettingsRepository } from "./storage/settingsRepository.js";
import type { PlayerHeadCacheEntry, PlayerHeadCacheRepository } from "./storage/playerHeadCacheRepository.js";

export const playerHeadProvider = "mc-heads.net";
export const playerHeadFreshMs = 24 * 60 * 60 * 1000;
export const playerHeadRequestIntervalMs = 1_000;
export const playerHeadMaxConcurrentRequests = 2;
export const playerHeadMaxBytes = 64 * 1024;
export const playerHeadCacheMaxEntries = 10_000;
export const playerHeadCacheMaxBytes = 64 * 1024 * 1024;

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const defaultRateLimitCooldownMs = 5 * 60 * 1000;
const failureCooldownsMs = [60_000, 5 * 60_000, 15 * 60_000];

type Fetch = typeof undiciFetch;
type Priority = "foreground" | "background";

type QueueItem = {
  key: string;
  playerName: string;
  cached?: PlayerHeadCacheEntry;
  generation: number;
  promise: Promise<void>;
  resolve: () => void;
};

export type PlayerHeadServiceOptions = {
  settings: SettingsRepository;
  cache: PlayerHeadCacheRepository;
  fetch?: Fetch;
  now?: () => number;
  requestIntervalMs?: number;
  maxConcurrentRequests?: number;
  requestTimeoutMs?: number;
  userAgent?: string;
};

function cacheKey(playerName: string) {
  return playerName.trim().toLocaleLowerCase("en-US");
}

function rollingRefreshOffsetMs(key: string) {
  let hash = 2_166_136_261;
  for (let index = 0; index < key.length; index += 1) {
    hash = Math.imul(hash ^ key.charCodeAt(index), 16_777_619) >>> 0;
  }
  hash = (hash ^ (hash >>> 16)) >>> 0;
  hash = Math.imul(hash, 0x85ebca6b) >>> 0;
  hash = (hash ^ (hash >>> 13)) >>> 0;
  hash = Math.imul(hash, 0xc2b2ae35) >>> 0;
  hash = (hash ^ (hash >>> 16)) >>> 0;
  return Math.floor((hash / 0x1_0000_0000) * playerHeadFreshMs);
}

export function playerHeadRefreshAfter(key: string, refreshedAt: number, previous?: Pick<PlayerHeadCacheEntry, "fetchedAt" | "refreshAfter">) {
  const previousWindow = previous ? previous.refreshAfter - previous.fetchedAt : 0;
  const needsRollingOffset = !previous || previousWindow < playerHeadFreshMs;
  return refreshedAt + playerHeadFreshMs + (needsRollingOffset ? rollingRefreshOffsetMs(key) : 0);
}

function retryAfterMs(value: string | null, now: number) {
  if (!value) return defaultRateLimitCooldownMs;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1_000, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(1_000, date - now) : defaultRateLimitCooldownMs;
}

function validPng(bytes: Buffer) {
  return bytes.length >= pngSignature.length && bytes.subarray(0, pngSignature.length).equals(pngSignature);
}

async function readLimitedBody(response: Awaited<ReturnType<Fetch>>) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > playerHeadMaxBytes) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length);
}

async function discardBody(response: Awaited<ReturnType<Fetch>>) {
  await response.body?.cancel().catch(() => undefined);
}

export class PlayerHeadService {
  private readonly fetch: Fetch;
  private readonly now: () => number;
  private readonly requestIntervalMs: number;
  private readonly maxConcurrentRequests: number;
  private readonly requestTimeoutMs: number;
  private readonly userAgent: string;
  private readonly foregroundQueue: QueueItem[] = [];
  private readonly backgroundQueue: QueueItem[] = [];
  private readonly pending = new Map<string, QueueItem>();
  private readonly controllers = new Set<AbortController>();
  private activeRequests = 0;
  private nextStartAt = 0;
  private nextBackgroundStartAt = 0;
  private cooldownUntil = 0;
  private consecutiveFailures = 0;
  private generation = 0;
  private pumpTimer: NodeJS.Timeout | undefined;
  private pumpTimerPriority: Priority | undefined;

  constructor(private readonly options: PlayerHeadServiceOptions) {
    this.fetch = options.fetch ?? undiciFetch;
    this.now = options.now ?? Date.now;
    this.requestIntervalMs = options.requestIntervalMs ?? playerHeadRequestIntervalMs;
    this.maxConcurrentRequests = options.maxConcurrentRequests ?? playerHeadMaxConcurrentRequests;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 8_000;
    this.userAgent = options.userAgent ?? "serverSENTINEL/player-heads";
  }

  enabled() {
    return this.options.settings.get().playerHeadsEnabled;
  }

  setEnabled(enabled: boolean) {
    this.options.settings.setPlayerHeadsEnabled(enabled);
    if (!enabled) this.cancelPending();
  }

  stats() {
    return this.options.cache.stats();
  }

  clearCache() {
    this.cancelPending();
    this.options.cache.clear();
    return this.options.cache.stats();
  }

  async head(playerName: string) {
    if (!this.enabled()) return undefined;
    const name = playerName.trim();
    const key = cacheKey(name);
    if (!key) return undefined;
    const now = this.now();
    const cached = this.options.cache.get(key, now);
    if (cached) {
      if (cached.refreshAfter <= now) void this.enqueue(name, cached, "background");
      return cached.bytes;
    }
    await this.enqueue(name, undefined, "foreground");
    if (!this.enabled()) return undefined;
    return this.options.cache.get(key, this.now())?.bytes;
  }

  cancelPending() {
    this.generation += 1;
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    this.pumpTimer = undefined;
    this.pumpTimerPriority = undefined;
    this.nextBackgroundStartAt = 0;
    for (const controller of this.controllers) controller.abort();
    for (const item of [...this.foregroundQueue, ...this.backgroundQueue]) item.resolve();
    this.foregroundQueue.length = 0;
    this.backgroundQueue.length = 0;
    this.pending.clear();
  }

  close() {
    this.cancelPending();
  }

  private enqueue(playerName: string, cached: PlayerHeadCacheEntry | undefined, priority: Priority) {
    const key = cacheKey(playerName);
    const existing = this.pending.get(key);
    if (existing) return existing.promise;
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    const item = { key, playerName, cached, generation: this.generation, promise, resolve };
    this.pending.set(key, item);
    (priority === "foreground" ? this.foregroundQueue : this.backgroundQueue).push(item);
    if (priority === "foreground" && this.pumpTimer && this.pumpTimerPriority === "background") {
      clearTimeout(this.pumpTimer);
      this.pumpTimer = undefined;
      this.pumpTimerPriority = undefined;
    }
    this.pump();
    return promise;
  }

  private pump() {
    if (this.activeRequests >= this.maxConcurrentRequests || this.pumpTimer) return;
    const priority: Priority = this.foregroundQueue.length > 0 ? "foreground" : "background";
    const next = priority === "foreground" ? this.foregroundQueue[0] : this.backgroundQueue[0];
    if (!next) return;
    const waitMs = Math.max(
      0,
      this.nextStartAt - this.now(),
      this.cooldownUntil - this.now(),
      priority === "background" ? this.nextBackgroundStartAt - this.now() : 0
    );
    if (waitMs > 0) {
      this.pumpTimerPriority = priority;
      this.pumpTimer = setTimeout(() => {
        this.pumpTimer = undefined;
        this.pumpTimerPriority = undefined;
        this.pump();
      }, waitMs);
      this.pumpTimer.unref?.();
      return;
    }
    const item = priority === "foreground" ? this.foregroundQueue.shift() : this.backgroundQueue.shift();
    if (!item) return;
    if (item.generation !== this.generation || !this.enabled()) {
      this.finish(item);
      this.pump();
      return;
    }
    this.activeRequests += 1;
    this.nextStartAt = this.now() + this.requestIntervalMs;
    if (priority === "background") {
      const cacheEntries = Math.max(1, this.options.cache.stats().entries);
      this.nextBackgroundStartAt = this.now() + Math.max(this.requestIntervalMs, Math.ceil(playerHeadFreshMs / cacheEntries));
    }
    void this.refresh(item).finally(() => {
      this.activeRequests -= 1;
      this.finish(item);
      this.pump();
    });
    this.pump();
  }

  private finish(item: QueueItem) {
    if (this.pending.get(item.key) === item) this.pending.delete(item.key);
    item.resolve();
  }

  private async refresh(item: QueueItem) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    timeout.unref?.();
    this.controllers.add(controller);
    try {
      const headers: Record<string, string> = { "User-Agent": this.userAgent, Accept: "image/png" };
      if (item.cached?.etag) headers["If-None-Match"] = item.cached.etag;
      const response = await this.fetch(`https://${playerHeadProvider}/avatar/${encodeURIComponent(item.playerName)}/32`, {
        headers,
        redirect: "error",
        signal: controller.signal
      });
      if (item.generation !== this.generation || !this.enabled()) return;
      const now = this.now();
      if (response.status === 429) {
        await discardBody(response);
        this.cooldownUntil = Math.max(this.cooldownUntil, now + retryAfterMs(response.headers.get("retry-after"), now));
        return;
      }
      if (response.status === 304 && item.cached) {
        await discardBody(response);
        this.options.cache.markRefreshed(item.key, now, playerHeadRefreshAfter(item.key, now, item.cached), response.headers.get("etag") ?? undefined);
        this.markSuccess();
        return;
      }
      if (response.status >= 500) {
        await discardBody(response);
        this.markFailure(now);
        return;
      }
      if (!response.ok || !/^image\/png(?:;|$)/i.test(response.headers.get("content-type") ?? "")) {
        await discardBody(response);
        return;
      }
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > playerHeadMaxBytes) {
        await discardBody(response);
        return;
      }
      const bytes = await readLimitedBody(response);
      if (!bytes || !validPng(bytes)) return;
      if (item.generation !== this.generation || !this.enabled()) return;
      this.options.cache.set({
        key: item.key,
        playerName: item.playerName,
        bytes,
        etag: response.headers.get("etag") ?? undefined,
        fetchedAt: now,
        refreshAfter: playerHeadRefreshAfter(item.key, now, item.cached),
        lastAccessedAt: now
      });
      this.options.cache.enforceLimits(playerHeadCacheMaxEntries, playerHeadCacheMaxBytes);
      this.markSuccess();
    } catch (error) {
      if (!controller.signal.aborted || item.generation === this.generation) this.markFailure(this.now());
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(controller);
    }
  }

  private markSuccess() {
    this.consecutiveFailures = 0;
    if (this.cooldownUntil <= this.now()) this.cooldownUntil = 0;
  }

  private markFailure(now: number) {
    this.consecutiveFailures += 1;
    const index = Math.min(this.consecutiveFailures - 1, failureCooldownsMs.length - 1);
    this.cooldownUntil = Math.max(this.cooldownUntil, now + failureCooldownsMs[index]);
  }
}
