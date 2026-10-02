import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runtimeForServer } from "../appServices.js";
import type { NodeRuntime } from "../nodes/types.js";
import type { ManagedServer } from "../types.js";
import { resetModrinthMetadataCachesForTests } from "../modrinth/compatibility.js";
import { configureModrinthApiKeyProvider, resetModrinthClientStateForTests } from "../modrinth/modrinthClient.js";
import { listModsWithPanelMetadata, updateModrinthMod } from "./modService.js";

vi.mock("../appServices.js", () => ({ services: {}, runtimeForServer: vi.fn() }));

const server = { id: "request-test", runtimeProfile: { runtimeType: "fabric", minecraftVersion: "1.21.4", jarArtifact: { filename: "server.jar" } } } as ManagedServer;
const mods = Array.from({ length: 40 }, (_, index) => ({
  filename: `mod-${index}.jar`,
  modrinth: { projectId: `project-${index}`, versionId: `version-${index}`, versionNumber: "1",
    filename: `mod-${index}.jar`, gameVersions: ["1.21.4"], loaders: ["fabric"],
    installedAt: "2026-09-01T00:00:00Z", installedWithForceIncompatible: false }
}));
const listMods = vi.fn();
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  resetModrinthMetadataCachesForTests();
  resetModrinthClientStateForTests();
  configureModrinthApiKeyProvider(async () => "");
  listMods.mockReset().mockResolvedValue({ mods });
  vi.mocked(runtimeForServer).mockReturnValue({ listMods } as unknown as NodeRuntime);
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe("managed content request counts", () => {
  it("starts a new scan after cancellation and preserves its coalescing slot when the old scan finishes", async () => {
    let finishOld!: (result: { mods: typeof mods }) => void;
    let finishNew!: (result: { mods: typeof mods }) => void;
    listMods.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { finishNew = resolve; }));
    const controller = new AbortController();
    const old = listModsWithPanelMetadata(server, { forceRefresh: true, signal: controller.signal });
    controller.abort();
    const current = listModsWithPanelMetadata(server, { forceRefresh: true, signal: new AbortController().signal });
    expect(listMods).toHaveBeenCalledTimes(2);
    finishOld({ mods: [] });
    await old;
    const joined = listModsWithPanelMetadata(server, { forceRefresh: true });
    expect(listMods).toHaveBeenCalledTimes(2);
    finishNew({ mods });
    expect(await current).toEqual({ mods });
    expect(await joined).toEqual({ mods });
  });

  it("shares concurrent local scans without repeating their metadata enrichment", async () => {
    const results = await Promise.all([
      listModsWithPanelMetadata(server, { forceRefresh: true }),
      listModsWithPanelMetadata(server, { forceRefresh: true })
    ]);
    expect(results).toEqual([{ mods }, { mods }]);
    expect(listMods).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shares live progress with callers that join an existing scan", async () => {
    let finish!: () => void;
    listMods.mockImplementation(async (_server, options) => {
      options.onProgress({ checked: 0, total: mods.length });
      await new Promise<void>((resolve) => { finish = resolve; });
      options.onProgress({ checked: mods.length, total: mods.length });
      return { mods };
    });
    const firstProgress: Array<{ checked: number; total: number }> = [];
    const joinedProgress: Array<{ checked: number; total: number }> = [];

    const first = listModsWithPanelMetadata(server, { forceRefresh: true, onProgress: (progress) => firstProgress.push(progress) });
    await vi.waitFor(() => expect(firstProgress).toEqual([{ checked: 0, total: mods.length }]));
    const joined = listModsWithPanelMetadata(server, { forceRefresh: true, onProgress: (progress) => joinedProgress.push(progress) });
    expect(joinedProgress).toEqual([{ checked: 0, total: mods.length }]);
    finish();
    await Promise.all([first, joined]);

    expect(firstProgress.at(-1)).toEqual({ checked: mods.length, total: mods.length });
    expect(joinedProgress.at(-1)).toEqual({ checked: mods.length, total: mods.length });
    expect(listMods).toHaveBeenCalledTimes(1);
  });

  it("checks only the three selected projects in a forty-mod installation", async () => {
    fetchMock.mockImplementation(async (url) => {
      const index = String(url).match(/project-(\d+)/)?.[1];
      return new Response(JSON.stringify([{
        id: `version-${index}`, project_id: `project-${index}`, version_number: "1", version_type: "release",
        loaders: ["fabric"], game_versions: ["1.21.4"],
        files: [{ filename: `mod-${index}.jar`, url: "https://cdn.modrinth.com/test.jar", primary: true }]
      }]));
    });
    for (let index = 0; index < 3; index += 1) {
      await expect(updateModrinthMod(server, { filename: `mod-${index}.jar`, channel: "release" }))
        .resolves.toMatchObject({ upToDate: true });
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(listMods.mock.calls.every(([, options]) => options.forceRefresh !== true)).toBe(true);
  });
});
