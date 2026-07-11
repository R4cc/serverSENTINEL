import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchProjects, fetchProjectVersions, resetModrinthMetadataCachesForTests } from "./compatibility.js";
import { modrinthFetch } from "./modrinthClient.js";

vi.mock("./modrinthClient.js", () => ({ modrinthFetch: vi.fn() }));

const fetchMock = vi.mocked(modrinthFetch);
const version = { id: "v1", version_number: "1.0.0", version_type: "release", loaders: ["fabric"], game_versions: ["1.21.4"], files: [] };

beforeEach(() => {
  fetchMock.mockReset();
  resetModrinthMetadataCachesForTests();
  vi.useRealTimers();
});

describe("Modrinth metadata caches", () => {
  it("loads dependency projects with one bulk request and caches them", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify([{ id: "dep-a", title: "A" }, { id: "dep-b", title: "B" }]), { status: 200 }) as never);

    const first = await fetchProjects(["dep-a", "dep-b", "dep-a"]);
    const second = await fetchProjects(["dep-a", "dep-b"]);

    expect(first.get("dep-a")?.title).toBe("A");
    expect(second.get("dep-b")?.title).toBe("B");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/v2/projects?ids=");
  });

  it("reuses version reviews but supports authoritative force refreshes", async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify([version]), { status: 200 }) as never);

    await fetchProjectVersions("project-a");
    await fetchProjectVersions("project-a");
    await fetchProjectVersions("project-a", undefined, { forceRefresh: true });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses stale version metadata after a transient refresh failure", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T20:00:00Z"));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([version]), { status: 200 }) as never);
    await fetchProjectVersions("project-a");
    vi.advanceTimersByTime(6 * 60_000);
    fetchMock.mockRejectedValueOnce(new Error("upstream unavailable"));

    await expect(fetchProjectVersions("project-a")).resolves.toEqual([version]);
  });
});
