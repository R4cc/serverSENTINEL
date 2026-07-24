import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Response } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlayerHeadService, playerHeadFreshMs } from "./playerHeadService.js";
import { openStorageDatabase, type StorageDatabase } from "./storage/database.js";
import { PlayerHeadCacheRepository } from "./storage/playerHeadCacheRepository.js";
import { SettingsRepository } from "./storage/settingsRepository.js";

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const roots: string[] = [];
const databases: StorageDatabase[] = [];
const services: PlayerHeadService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) service.close();
  vi.useRealTimers();
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function harness(fetch: typeof globalThis.fetch = vi.fn(async () => new Response(png, { status: 200, headers: { "content-type": "image/png", etag: '"head-v1"' } })) as unknown as typeof globalThis.fetch) {
  const root = await mkdtemp(join(tmpdir(), "serversentinel-player-heads-"));
  roots.push(root);
  const database = openStorageDatabase(join(root, "serversentinel.sqlite"));
  databases.push(database);
  const settings = new SettingsRepository(database);
  const cache = new PlayerHeadCacheRepository(database);
  const service = new PlayerHeadService({
    settings,
    cache,
    fetch: fetch as never,
    requestIntervalMs: 0,
    requestTimeoutMs: 1_000
  });
  services.push(service);
  return { database, settings, cache, service, fetch };
}

describe("PlayerHeadService", () => {
  it("does not contact MCHeads while disabled or undecided", async () => {
    const test = await harness();
    expect(test.settings.get()).toMatchObject({ playerHeadsEnabled: false, playerHeadsOnboardingCompleted: false });
    await expect(test.service.head("Alex")).resolves.toBeUndefined();
    expect(test.fetch).not.toHaveBeenCalled();
  });

  it("coalesces uncached requests and persists a reusable PNG", async () => {
    const test = await harness();
    test.service.setEnabled(true);
    const heads = await Promise.all([test.service.head("Alex"), test.service.head("alex"), test.service.head("Alex")]);
    expect(heads.every((head) => head?.equals(png))).toBe(true);
    expect(test.fetch).toHaveBeenCalledTimes(1);
    expect(test.cache.stats()).toEqual({ entries: 1, bytes: png.length });
    await expect(test.service.head("Alex")).resolves.toEqual(png);
    expect(test.fetch).toHaveBeenCalledTimes(1);
  });

  it("serves stale bytes immediately and revalidates with ETag", async () => {
    let resolveFetch!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve; })) as unknown as typeof globalThis.fetch;
    const test = await harness(fetch);
    test.service.setEnabled(true);
    test.cache.set({ key: "alex", playerName: "Alex", bytes: png, etag: '"head-v1"', fetchedAt: 1, refreshAfter: 2, lastAccessedAt: 1 });

    await expect(test.service.head("Alex")).resolves.toEqual(png);
    expect(test.fetch).toHaveBeenCalledWith("https://mc-heads.net/avatar/Alex/32", expect.objectContaining({
      headers: expect.objectContaining({ "If-None-Match": '"head-v1"' }),
      redirect: "error"
    }));
    resolveFetch(new Response(null, { status: 304, headers: { etag: '"head-v1"' } }));
    await vi.waitFor(() => expect(test.cache.get("alex", Date.now())?.refreshAfter).toBeGreaterThan(Date.now() + playerHeadFreshMs - 5_000));
  });

  it.each([
    ["wrong content type", new Response(png, { status: 200, headers: { "content-type": "text/plain" } })],
    ["invalid PNG", new Response(Buffer.from("not png"), { status: 200, headers: { "content-type": "image/png" } })],
    ["oversized PNG", new Response(Buffer.concat([png, Buffer.alloc(64 * 1024)]), { status: 200, headers: { "content-type": "image/png" } })]
  ])("rejects %s responses without caching them", async (_label, response) => {
    const fetch = vi.fn(async () => response) as unknown as typeof globalThis.fetch;
    const test = await harness(fetch);
    test.service.setEnabled(true);
    await expect(test.service.head("Alex")).resolves.toBeUndefined();
    expect(test.cache.stats()).toEqual({ entries: 0, bytes: 0 });
  });

  it("keeps cached heads on disable and removes them only on explicit clear", async () => {
    const test = await harness();
    test.service.setEnabled(true);
    await test.service.head("Alex");
    test.service.setEnabled(false);
    expect(test.cache.stats().entries).toBe(1);
    expect(test.service.clearCache()).toEqual({ entries: 0, bytes: 0 });
  });

  it("spaces request starts and never exceeds the configured concurrency", async () => {
    const starts: number[] = [];
    let active = 0;
    let maxActive = 0;
    const fetch = vi.fn(async () => {
      starts.push(Date.now());
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active -= 1;
      return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
    }) as unknown as typeof globalThis.fetch;
    const test = await harness(fetch);
    test.service.close();
    const service = new PlayerHeadService({ settings: test.settings, cache: test.cache, fetch: fetch as never, requestIntervalMs: 10, maxConcurrentRequests: 2 });
    service.setEnabled(true);
    await Promise.all(Array.from({ length: 8 }, (_, index) => service.head(`Player${index}`)));
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(starts).toHaveLength(8);
    expect(starts.slice(1).every((start, index) => start - starts[index] >= 7)).toBe(true);
    service.close();
  });

  it("cancels active and queued work when disabled", async () => {
    const fetch = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })) as unknown as typeof globalThis.fetch;
    const test = await harness(fetch);
    test.service.close();
    const service = new PlayerHeadService({ settings: test.settings, cache: test.cache, fetch: fetch as never, requestIntervalMs: 1_000 });
    services.push(service);
    service.setEnabled(true);
    const active = service.head("Alex");
    const queued = service.head("Steve");
    expect(fetch).toHaveBeenCalledTimes(1);
    service.setEnabled(false);
    await expect(Promise.all([active, queued])).resolves.toEqual([undefined, undefined]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(test.cache.stats()).toEqual({ entries: 0, bytes: 0 });
  });

  it("times out a stalled upstream request without caching a response", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
    })) as unknown as typeof globalThis.fetch;
    const test = await harness(fetch);
    test.service.close();
    const service = new PlayerHeadService({ settings: test.settings, cache: test.cache, fetch: fetch as never, requestIntervalMs: 0, requestTimeoutMs: 8_000 });
    services.push(service);
    service.setEnabled(true);
    const head = service.head("Alex");
    await vi.advanceTimersByTimeAsync(8_000);
    await expect(head).resolves.toBeUndefined();
    expect(test.cache.stats()).toEqual({ entries: 0, bytes: 0 });
  });

  it("honors Retry-After and applies exponential cooldown after repeated 5xx responses", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const starts: number[] = [];
    const responses = [
      new Response(null, { status: 429, headers: { "retry-after": "2" } }),
      new Response(null, { status: 500 }),
      new Response(null, { status: 503 }),
      new Response(png, { status: 200, headers: { "content-type": "image/png" } })
    ];
    const fetch = vi.fn(async () => {
      starts.push(Date.now());
      return responses.shift()!;
    }) as unknown as typeof globalThis.fetch;
    const test = await harness(fetch);
    test.service.close();
    const service = new PlayerHeadService({ settings: test.settings, cache: test.cache, fetch: fetch as never, requestIntervalMs: 1_000 });
    services.push(service);
    service.setEnabled(true);
    const heads = [service.head("Player0"), service.head("Player1"), service.head("Player2"), service.head("Player3")];
    await vi.runAllTimersAsync();
    await Promise.all(heads);
    expect(starts).toEqual([0, 2_000, 62_000, 362_000]);
    expect(test.cache.stats().entries).toBe(1);
  });

  it("limits a cold 300-player workload to 60 starts per minute and two concurrent requests", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const starts: number[] = [];
    let active = 0;
    let maxActive = 0;
    const fetch = vi.fn(() => new Promise<Response>((resolve) => {
      starts.push(Date.now());
      active += 1;
      maxActive = Math.max(maxActive, active);
      setTimeout(() => {
        active -= 1;
        resolve(new Response(png, { status: 200, headers: { "content-type": "image/png" } }));
      }, 1_500);
    })) as unknown as typeof globalThis.fetch;
    const test = await harness(fetch);
    test.service.close();
    const service = new PlayerHeadService({
      settings: test.settings,
      cache: test.cache,
      fetch: fetch as never,
      requestIntervalMs: 1_000,
      maxConcurrentRequests: 2,
      requestTimeoutMs: 8_000
    });
    services.push(service);
    service.setEnabled(true);
    const heads = Array.from({ length: 300 }, (_, index) => service.head(`Player${index}`));
    await vi.runAllTimersAsync();
    await Promise.all(heads);
    expect(starts).toHaveLength(300);
    expect(maxActive).toBeLessThanOrEqual(2);
    for (const start of starts) {
      expect(starts.filter((candidate) => candidate >= start && candidate < start + 60_000).length).toBeLessThanOrEqual(60);
    }
    expect(starts.at(-1)).toBeGreaterThanOrEqual(299_000);
  });
});
