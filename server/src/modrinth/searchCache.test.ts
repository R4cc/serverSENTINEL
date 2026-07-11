import { beforeEach, describe, expect, it, vi } from "vitest";
import { modrinthFetch } from "./modrinthClient.js";
import { resetModrinthSearchCacheForTests, searchModrinth } from "./searchCache.js";

vi.mock("./modrinthClient.js", () => ({ modrinthFetch: vi.fn() }));

const fetchMock = vi.mocked(modrinthFetch);

beforeEach(() => {
  fetchMock.mockReset();
  resetModrinthSearchCacheForTests();
  vi.useRealTimers();
});

describe("Modrinth search cache", () => {
  it("coalesces requests and reuses results for thirty seconds", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ hits: [{ project_id: "fabric-api" }] }), { status: 200 }) as never);

    const [first, second] = await Promise.all([searchModrinth("https://api.modrinth.com/v2/search?query=fabric"), searchModrinth("https://api.modrinth.com/v2/search?query=fabric")]);
    const cached = await searchModrinth("https://api.modrinth.com/v2/search?query=fabric");

    expect(first.body).toEqual(second.body);
    expect(cached.cacheStatus).toBe("hit");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("serves a recent stale result when Modrinth is temporarily unavailable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T20:00:00Z"));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ hits: [{ project_id: "fabric-api" }] }), { status: 200 }) as never);
    await searchModrinth("https://api.modrinth.com/v2/search?query=fabric");
    vi.advanceTimersByTime(31_000);
    fetchMock.mockRejectedValueOnce(new Error("upstream unavailable"));

    const result = await searchModrinth("https://api.modrinth.com/v2/search?query=fabric");

    expect(result.cacheStatus).toBe("stale");
    expect(result.body.hits?.[0]?.project_id).toBe("fabric-api");
  });
});
