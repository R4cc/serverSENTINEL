import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetch } from "undici";
import { configureModrinthApiKeyProvider, modrinthFetch, modrinthRequestHeaders } from "./modrinthClient.js";

vi.mock("undici", () => ({
  fetch: vi.fn()
}));

const fetchMock = vi.mocked(fetch);

beforeEach(() => {
  fetchMock.mockReset();
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

  it("passes an abort signal to external requests so stalled Modrinth calls time out", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }) as never);

    await modrinthFetch("https://api.modrinth.com/v2/project/fabric-api", { timeoutMs: 1234 });

    expect(fetchMock).toHaveBeenCalledWith("https://api.modrinth.com/v2/project/fabric-api", expect.objectContaining({
      signal: expect.any(AbortSignal)
    }));
  });
});
