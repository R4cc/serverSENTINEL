import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createModUpdatePlan } from "../modrinth/updatePlan.js";
import { openStorageDatabase, type StorageDatabase } from "./database.js";
import { ModUpdatePlanRepository } from "./modUpdatePlanRepository.js";

let storage: StorageDatabase | undefined;
const temporaryDirectories: string[] = [];

afterEach(async () => {
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

    repository.set(plan);
    storage.close();
    storage = openStorageDatabase(databasePath);

    expect(new ModUpdatePlanRepository(storage).get("server-a")).toEqual(plan);
  });

  it("ignores malformed or mismatched cached values", () => {
    storage = openStorageDatabase(":memory:");
    const repository = new ModUpdatePlanRepository(storage);
    storage.setMetadata("mod-update-plan:server-a", "not-json");
    storage.setMetadata("mod-update-plan:server-b", JSON.stringify(createModUpdatePlan("another-server", [])));

    expect(repository.get("server-a")).toBeNull();
    expect(repository.get("server-b")).toBeNull();
  });
});
