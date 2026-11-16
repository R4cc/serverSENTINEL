import { beforeEach, describe, expect, it, vi } from "vitest";
import { runtimeForServer, services } from "../appServices.js";
import { fetchProjects, fetchVersions, latestCompatibleVersionFor } from "../modrinth/compatibility.js";
import { installModWithRemoteVersionFallback, listModsWithPanelMetadata, updateModrinthMod } from "../mods/modService.js";
import type { NodeRuntime } from "../nodes/types.js";
import type { ManagedServer, ModrinthVersion, StoredUser } from "../types.js";
import { applyServerSettingsUpdate } from "./serverSettingsUpdate.js";
import { serverJarProvider } from "./provisioning.js";
import { applyMinecraftVersionSwitch, parseVersionSwitchRequest, planMinecraftVersionSwitch } from "./versionSwitch.js";

vi.mock("../appServices.js", () => ({ services: {}, runtimeForServer: vi.fn() }));
vi.mock("./provisioning.js", () => ({ serverJarProvider: { resolveServerJar: vi.fn() } }));
vi.mock("./lifecycle.js", () => ({ recordOperation: vi.fn((_input: unknown, action: (operation: unknown) => unknown) => action({})) }));
vi.mock("./serverSettingsUpdate.js", () => ({ applyServerSettingsUpdate: vi.fn() }));
vi.mock("../mods/modService.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../mods/modService.js")>(),
  listModsWithPanelMetadata: vi.fn(),
  updateModrinthMod: vi.fn(),
  installModWithRemoteVersionFallback: vi.fn(),
  withRecordedModMutation: vi.fn((_server: unknown, _user: unknown, action: () => unknown) => action())
}));
vi.mock("../modrinth/compatibility.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../modrinth/compatibility.js")>(),
  latestCompatibleVersionFor: vi.fn(),
  fetchVersions: vi.fn(),
  fetchProjects: vi.fn()
}));

const server = {
  id: "switch-test",
  displayName: "Survival",
  nodeId: "local",
  dockerImage: "eclipse-temurin:21-jre",
  runtimeProfile: {
    minecraftVersion: "1.21.1",
    runtimeType: "fabric",
    runtimeVersion: "0.16.0",
    jarArtifact: { filename: "fabric-server-launch.jar" }
  }
} as ManagedServer;

const admin = { id: "user-1", permissions: ["servers.editSettings", "mods.update", "mods.enableDisable", "mods.install"] } as unknown as StoredUser;

function installed(projectId: string, extra: Record<string, unknown> = {}) {
  return {
    filename: `${projectId}.jar`,
    enabled: true,
    preferredChannel: "release",
    modrinth: {
      projectId,
      versionId: `${projectId}-old`,
      filename: `${projectId}.jar`,
      versionNumber: "1.0.0",
      gameVersions: ["1.21.1"],
      loaders: ["fabric"],
      installedAt: "2026-01-01T00:00:00Z",
      installedWithForceIncompatible: false
    },
    ...extra
  };
}

function version(projectId: string, id: string): ModrinthVersion {
  return {
    id,
    project_id: projectId,
    version_number: id,
    version_type: "release",
    date_published: "2026-10-01T00:00:00Z",
    game_versions: ["1.21.4"],
    loaders: ["fabric"],
    files: [{ url: `https://cdn.modrinth.com/data/${projectId}/${id}.jar`, filename: `${projectId}-${id}.jar`, primary: true }]
  };
}

const toggleMod = vi.fn();
let serving = true;

beforeEach(() => {
  serving = true;
  Object.assign(services, { moduleRegistry: { isServing: () => serving }, modUpdatePlanCoordinator: undefined });
  toggleMod.mockReset().mockImplementation(async (_server, filename: string) => ({ ok: true, filename: `${filename}.disabled`, enabled: false }));
  vi.mocked(runtimeForServer).mockReturnValue({ toggleMod } as unknown as NodeRuntime);
  vi.mocked(serverJarProvider.resolveServerJar).mockReset().mockImplementation(async (request) => ({
    ...server.runtimeProfile,
    minecraftVersion: request.minecraftVersion,
    runtimeVersion: request.runtimeVersion === "latest" ? "0.16.14" : request.runtimeVersion
  }) as never);
  vi.mocked(applyServerSettingsUpdate).mockReset().mockImplementation(async (current, input) => ({
    ...current,
    runtimeProfile: { ...current.runtimeProfile, minecraftVersion: input.runtime!.minecraftVersion!, runtimeVersion: input.runtime!.runtimeVersion }
  }) as ManagedServer);
  vi.mocked(listModsWithPanelMetadata).mockReset().mockResolvedValue({
    mods: [installed("sodium", { preferredChannel: "beta" }), installed("lithium"), installed("broken")]
  });
  vi.mocked(latestCompatibleVersionFor).mockReset().mockImplementation(async (projectId) => (
    projectId === "sodium" ? version("sodium", "0.6.0") : projectId === "broken" ? version("broken", "2.0.0") : undefined
  ));
  vi.mocked(fetchVersions).mockReset().mockResolvedValue(new Map());
  vi.mocked(fetchProjects).mockReset().mockResolvedValue(new Map());
  vi.mocked(updateModrinthMod).mockReset().mockImplementation(async (_server, input) => {
    const { filename } = input as { filename: string };
    if (filename === "broken.jar") throw new Error("Download checksum mismatch");
    return { ok: true, filename: "sodium-0.6.0.jar", version: "0.6.0", channel: "beta" as const, replaced: filename };
  });
  vi.mocked(installModWithRemoteVersionFallback).mockReset();
});

describe("parseVersionSwitchRequest", () => {
  it("accepts release and year-based versions and rejects anything path-like", () => {
    expect(parseVersionSwitchRequest({ minecraftVersion: "1.21.4" })).toEqual({ minecraftVersion: "1.21.4", runtimeVersion: undefined });
    expect(parseVersionSwitchRequest({ minecraftVersion: "26.1", runtimeVersion: "0.17.2" })).toEqual({ minecraftVersion: "26.1", runtimeVersion: "0.17.2" });
    expect(() => parseVersionSwitchRequest({ minecraftVersion: "../1.21" })).toThrow("Choose a valid Minecraft version");
    expect(() => parseVersionSwitchRequest({})).toThrow("Choose a valid Minecraft version");
  });
});

describe("planMinecraftVersionSwitch", () => {
  it("resolves the runtime for the target and plans every installed mod", async () => {
    const plan = await planMinecraftVersionSwitch(server, { minecraftVersion: "1.21.4" }, admin);

    expect(plan).toMatchObject({
      direction: "upgrade",
      current: { minecraftVersion: "1.21.1", runtimeVersion: "0.16.0" },
      target: { minecraftVersion: "1.21.4", runtimeVersion: "0.16.14", dockerImage: "eclipse-temurin:21-jre" },
      counts: { update: 2, disable: 1 }
    });
    expect(plan.content.find((entry) => entry.projectId === "lithium")?.action).toBe("disable");
    expect(plan.warnings[0]).toContain("Back up the world first");
  });

  it("leaves content alone, and says so, when the module is switched off or the account cannot change mods", async () => {
    serving = false;
    const moduleOff = await planMinecraftVersionSwitch(server, { minecraftVersion: "1.21.4" }, admin);
    expect(moduleOff.content).toEqual([]);
    expect(moduleOff.contentSkippedReason).toContain("module is switched off");
    expect(listModsWithPanelMetadata).not.toHaveBeenCalled();

    serving = true;
    const viewer = { ...admin, permissions: ["servers.editSettings"] } as unknown as StoredUser;
    expect((await planMinecraftVersionSwitch(server, { minecraftVersion: "1.21.4" }, viewer)).contentSkippedReason).toContain("cannot update");
  });

  it("refuses a switch that changes nothing", async () => {
    await expect(planMinecraftVersionSwitch(server, { minecraftVersion: "1.21.1", runtimeVersion: "0.16.0" }, admin))
      .rejects.toThrow("already runs Minecraft 1.21.1");
  });

  it("keeps every mod when only the loader changes", async () => {
    const plan = await planMinecraftVersionSwitch(server, { minecraftVersion: "1.21.1", runtimeVersion: "0.16.14" }, admin);
    expect(plan.content.map((entry) => entry.action)).toEqual(["keep", "keep", "keep"]);
    expect(latestCompatibleVersionFor).not.toHaveBeenCalled();
  });
});

describe("applyMinecraftVersionSwitch", () => {
  it("switches the runtime first, then updates, disables, and falls back to disabling a failed update", async () => {
    const { server: switched, result } = await applyMinecraftVersionSwitch(server, { minecraftVersion: "1.21.4" }, admin);

    expect(applyServerSettingsUpdate).toHaveBeenCalledWith(server, { runtime: { runtimeType: "fabric", minecraftVersion: "1.21.4", runtimeVersion: "0.16.14" } });
    expect(switched.runtimeProfile.minecraftVersion).toBe("1.21.4");
    // Mods are changed against the switched server, keeping each mod's own release channel.
    expect(updateModrinthMod).toHaveBeenCalledWith(switched, { filename: "sodium.jar", channel: "beta" });
    expect(toggleMod).toHaveBeenCalledWith(switched, "lithium.jar", false);
    expect(toggleMod).toHaveBeenCalledWith(switched, "broken.jar", false);

    const byFile = Object.fromEntries(result.outcomes.map((outcome) => [outcome.filename, outcome]));
    expect(byFile["sodium.jar"]).toMatchObject({ status: "updated", finalFilename: "sodium-0.6.0.jar", version: "0.6.0" });
    expect(byFile["lithium.jar"]).toMatchObject({ status: "disabled", finalFilename: "lithium.jar.disabled" });
    expect(byFile["broken.jar"]).toMatchObject({ status: "disabled" });
    expect(byFile["broken.jar"].reason).toContain("Download checksum mismatch");
    expect(result.counts).toMatchObject({ updated: 1, disabled: 2, failed: 0 });
  });

  it("reports a mod as failed when even disabling it does not work", async () => {
    toggleMod.mockRejectedValue(new Error("Node offline"));
    const { result } = await applyMinecraftVersionSwitch(server, { minecraftVersion: "1.21.4" }, admin);
    const lithium = result.outcomes.find((outcome) => outcome.filename === "lithium.jar");
    expect(lithium?.status).toBe("failed");
    expect(lithium?.reason).toContain("Node offline");
  });
});
