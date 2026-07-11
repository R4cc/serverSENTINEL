import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetch } from "undici";
import { configureModrinthApiKeyProvider, modrinthFetch, modrinthRequestHeaders, resetModrinthClientStateForTests } from "./modrinthClient.js";

vi.mock("undici", () => ({
  fetch: vi.fn()
}));

const fetchMock = vi.mocked(fetch);

beforeEach(() => {
  fetchMock.mockReset();
  resetModrinthClientStateForTests();
  configureModrinthApiKeyProvider(async () => "");
});

describe("Modrinth client", () => {
  it("only sends the API key to the Modrinth API host", () => {
    expect(modrinthRequestHeaders("https://api.modrinth.com/v2/project/fabric-api", "secret")).toMatchObject({
      Authorization: "secret"
    });

    expect(modrinthRequestHeaders("https://cdn.modrinth.com/data/example.jar", "secret")).not.toHaveProperty("Authorization");
    expect(modrinthRequestHeaders("https://example.invalid/file.jar", "secret")).not.toHaveProperty("Authorization");
    expect(modrinthRequestHeaders("not a url", "secret")).not.toHaveProperty("Authorization");
  });

  it("trims the API key before using it as an authorization header", () => {
    expect(modrinthRequestHeaders("https://api.modrinth.com/v2/search", "  mrp_secret  ")).toMatchObject({
      Authorization: "mrp_secret"
    });
  });

  it("rejects API keys that cannot be sent as HTTP headers", () => {
    expect(() => modrinthRequestHeaders("https://api.modrinth.com/v2/search", "mrp_secret\nhidden"))
      .toThrow("Modrinth API key contains invalid characters");
  });

  it("does not validate the API key for non-API URLs where it is not sent", () => {
    expect(modrinthRequestHeaders("https://cdn.modrinth.com/data/example.jar", "mrp_secret\nhidden"))
      .not.toHaveProperty("Authorization");
  });

  it("passes an abort signal to external requests so stalled Modrinth calls time out", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }) as never);

    await modrinthFetch("https://api.modrinth.com/v2/project/fabric-api", { timeoutMs: 1234 });

    expect(fetchMock).toHaveBeenCalledWith("https://api.modrinth.com/v2/project/fabric-api", expect.objectContaining({
      signal: expect.any(AbortSignal)
    }));
  });

  it("marks upstream Modrinth failures as public dependency errors", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 401, statusText: "Unauthorized" }) as never);

    await expect(modrinthFetch("https://api.modrinth.com/v2/search")).rejects.toMatchObject({
      message: "Modrinth request failed: 401 Unauthorized",
      statusCode: 424,
      code: "MODRINTH_REQUEST_FAILED",
      details: {
        upstreamStatus: 401,
        upstreamStatusText: "Unauthorized"
      }
    });
  });

  it("retries public GET requests without an invalid configured API key", async () => {
    configureModrinthApiKeyProvider(async () => "expired-token");
    fetchMock
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401, statusText: "Unauthorized" }) as never)
      .mockResolvedValueOnce(new Response("{}", { status: 200 }) as never);

    await expect(modrinthFetch("https://api.modrinth.com/v2/search?query=servercore")).resolves.toMatchObject({ status: 200 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ headers: expect.objectContaining({ Authorization: "expired-token" }) });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ headers: expect.not.objectContaining({ Authorization: expect.anything() }) });
  });

  it("does not remove authentication from POST requests", async () => {
    configureModrinthApiKeyProvider(async () => "expired-token");
    fetchMock.mockResolvedValue(new Response("unauthorized", { status: 401, statusText: "Unauthorized" }) as never);

    await expect(modrinthFetch("https://api.modrinth.com/v2/version_files", { method: "POST", json: { hashes: [] } })).rejects.toMatchObject({
      statusCode: 424,
      details: { upstreamStatus: 401 }
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ headers: expect.objectContaining({ Authorization: "expired-token" }) });
  });

  it("converts transport failures into public dependency errors instead of 500s", async () => {
    fetchMock.mockRejectedValue(new Error("connect ECONNRESET"));

    await expect(modrinthFetch("https://api.modrinth.com/v2/search")).rejects.toMatchObject({
      message: "Modrinth request failed: connect ECONNRESET",
      statusCode: 424,
      code: "MODRINTH_REQUEST_FAILED",
      details: { attempt: 3 }
    });
  });

  it("uses a stable rate-limit error code after retries", async () => {
    fetchMock.mockResolvedValue(new Response("limited", { status: 429, statusText: "Too Many Requests", headers: { "retry-after": "0" } }) as never);

    await expect(modrinthFetch("https://api.modrinth.com/v2/search?rate-test=1")).rejects.toMatchObject({
      statusCode: 424,
      code: "MODRINTH_RATE_LIMITED",
      details: { upstreamStatus: 429, attempt: 3 }
    });
  });

  it("bounds rate-limit waiting by the overall request deadline", async () => {
    fetchMock.mockResolvedValue(new Response("limited", { status: 429, statusText: "Too Many Requests", headers: { "retry-after": "60" } }) as never);

    await expect(modrinthFetch("https://api.modrinth.com/v2/search?deadline-test=1", { deadlineMs: 20 })).rejects.toMatchObject({
      statusCode: 424,
      code: "MODRINTH_RATE_LIMITED"
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shares a server rate-limit cooldown across requests", async () => {
    vi.useFakeTimers();
    try {
      fetchMock
        .mockResolvedValueOnce(new Response("limited", { status: 429, headers: { "retry-after": "1" } }) as never)
        .mockResolvedValue(new Response("{}", { status: 200 }) as never);

      const first = modrinthFetch("https://api.modrinth.com/v2/search?cooldown-a=1", { deadlineMs: 5_000 });
      await vi.advanceTimersByTimeAsync(0);
      const second = modrinthFetch("https://api.modrinth.com/v2/search?cooldown-b=1", { deadlineMs: 5_000 });
      await vi.advanceTimersByTimeAsync(999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);

      await expect(Promise.all([first, second])).resolves.toHaveLength(2);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("pauses new requests when successful responses exhaust the reported allowance", async () => {
    vi.useFakeTimers();
    try {
      fetchMock
        .mockResolvedValueOnce(new Response("{}", { status: 200, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1" } }) as never)
        .mockResolvedValueOnce(new Response("{}", { status: 200 }) as never);

      await modrinthFetch("https://api.modrinth.com/v2/search?allowance-a=1");
      const next = modrinthFetch("https://api.modrinth.com/v2/search?allowance-b=1", { deadlineMs: 5_000 });
      await vi.advanceTimersByTimeAsync(999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(next).resolves.toMatchObject({ status: 200 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("supports JSON POST requests for batched hash resolution", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }) as never);

    await modrinthFetch("https://api.modrinth.com/v2/version_files", { method: "POST", json: { hashes: ["abc"], algorithm: "sha1" } });

    expect(fetchMock).toHaveBeenCalledWith("https://api.modrinth.com/v2/version_files", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ hashes: ["abc"], algorithm: "sha1" }),
      headers: expect.objectContaining({ "Content-Type": "application/json" })
    }));
  });

  it("coalesces simultaneous GET requests", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }) as never);

    await Promise.all([
      modrinthFetch("https://api.modrinth.com/v2/project/shared"),
      modrinthFetch("https://api.modrinth.com/v2/project/shared")
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
