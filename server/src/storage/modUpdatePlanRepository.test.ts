import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createModUpdatePlan } from "../modrinth/updatePlan.js";
import { openStorageDatabase, type StorageDatabase } from "./database.js";
import { ModUpdatePlanRepository } from "./modUpdatePlanRepository.js";

let storage: StorageDatabase | undefined;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  storage?.close();
  storage = undefined;
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ModUpdatePlanRepository", () => {
  it("persists the last successful plan across database restarts", async () => {
    const root = await mkdtemp(join(tmpdir(), "serversentinel-mod-update-plan-"));
    temporaryDirectories.push(root);
    const databasePath = join(root, "state.sqlite");
    storage = openStorageDatabase(databasePath);
    const repository = new ModUpdatePlanRepository(storage);
    const plan = createModUpdatePlan("server-a", [], "2026-01-01T00:00:00.000Z");
    const installed = { scannedAt: plan.generatedAt, mods: [{ filename: "example.jar", enabled: true, displayName: "Example", size: 42, sha1: "internal-hash" }] };

    repository.set(plan, installed);
    storage.close();
    storage = openStorageDatabase(databasePath);

    expect(new ModUpdatePlanRepository(storage).get("server-a")).toEqual(plan);
    expect(new ModUpdatePlanRepository(storage).getInstalled("server-a")).toEqual(installed);
  });

  it("ignores malformed or mismatched cached values", () => {
    storage = openStorageDatabase(":memory:");
    const repository = new ModUpdatePlanRepository(storage);
    storage.setMetadata("mod-update-plan:server-a", "not-json");
    storage.setMetadata("mod-update-plan:server-b", JSON.stringify(createModUpdatePlan("another-server", [])));

    expect(repository.get("server-a")).toBeNull();
    expect(repository.get("server-b")).toBeNull();
  });

  it.each([
    "not-json",
    JSON.stringify({ serverId: "other-server", scannedAt: "2026-10-02T00:00:00Z", mods: [] }),
    JSON.stringify({ serverId: "server-a", scannedAt: "invalid", mods: [] }),
    JSON.stringify({ serverId: "server-a", scannedAt: "2026-10-02T00:00:00Z", mods: [null] }),
    JSON.stringify({ serverId: "server-a", scannedAt: "2026-10-02T00:00:00Z", mods: [{ filename: "example.jar", enabled: "yes" }] }),
    JSON.stringify({ serverId: "server-a", scannedAt: "2026-10-02T00:00:00Z", mods: [{ filename: "example.jar", enabled: true, size: -1 }] })
  ])("ignores an invalid installed snapshot: %s", (serialized) => {
    storage = openStorageDatabase(":memory:");
    storage.setMetadata("mod-installed-snapshot:server-a", serialized);
    expect(new ModUpdatePlanRepository(storage).getInstalled("server-a")).toBeNull();
  });

  it("rolls back both cached values if persisting the installed snapshot fails", () => {
    storage = openStorageDatabase(":memory:");
    const repository = new ModUpdatePlanRepository(storage);
    const originalPlan = createModUpdatePlan("server-a", [], "2026-10-01T00:00:00Z");
    const originalSnapshot = { scannedAt: originalPlan.generatedAt, mods: [{ filename: "old.jar", enabled: true }] };
    repository.set(originalPlan, originalSnapshot);
    const write = storage.setMetadata.bind(storage);
    vi.spyOn(storage, "setMetadata").mockImplementation((key, value) => {
      if (key.startsWith("mod-installed-snapshot:")) throw new Error("Snapshot write failed");
      write(key, value);
    });
    const nextPlan = createModUpdatePlan("server-a", [], "2026-10-02T00:00:00Z");
    expect(() => repository.set(nextPlan, { scannedAt: nextPlan.generatedAt, mods: [] })).toThrow("Snapshot write failed");
    expect(repository.get("server-a")).toEqual(originalPlan);
    expect(repository.getInstalled("server-a")).toEqual(originalSnapshot);
  });

  it("keeps legacy plans readable without inventing an installed snapshot", () => {
    storage = openStorageDatabase(":memory:");
    const repository = new ModUpdatePlanRepository(storage);
    const plan = createModUpdatePlan("server-a", []);
    repository.set(plan);
    expect(repository.get("server-a")).toEqual(plan);
    expect(repository.getInstalled("server-a")).toBeNull();
  });
});
