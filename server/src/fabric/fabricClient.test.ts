import { describe, expect, it, vi, beforeEach } from "vitest";
import { fabricMeta } from "./fabricClient.js";
import { fetch } from "undici";

vi.mock("undici", () => {
  return {
    fetch: vi.fn()
  };
});

describe("fabricMeta caching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("caches the result of fabricMeta and returns it on subsequent calls", async () => {
    const mockResponse = {
      ok: true,
      json: async () => [{ version: "1.21.4", stable: true }]
    };
    vi.mocked(fetch).mockResolvedValue(mockResponse as any);

    // First call: should trigger fetch
    const res1 = await fabricMeta("/v2/versions/game");
    expect(res1).toEqual([{ version: "1.21.4", stable: true }]);
    expect(fetch).toHaveBeenCalledTimes(1);

    // Second call: should read from cache, not trigger fetch
    const res2 = await fabricMeta("/v2/versions/game");
    expect(res2).toEqual([{ version: "1.21.4", stable: true }]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
