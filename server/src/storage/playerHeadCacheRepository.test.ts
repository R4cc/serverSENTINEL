import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openStorageDatabase, type StorageDatabase } from "./database.js";
import { PlayerHeadCacheRepository } from "./playerHeadCacheRepository.js";
import { SettingsRepository } from "./settingsRepository.js";

const roots: string[] = [];
const databases: StorageDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repositories() {
  const root = await mkdtemp(join(tmpdir(), "serversentinel-head-cache-"));
  roots.push(root);
  const database = openStorageDatabase(join(root, "serversentinel.sqlite"));
  databases.push(database);
  return { cache: new PlayerHeadCacheRepository(database), settings: new SettingsRepository(database) };
}

describe("player head storage", () => {
  it("persists the global choice without overwriting Modrinth configuration", async () => {
    const { settings } = await repositories();
    settings.setModrinthApiKey("secret-key");
    settings.setPlayerHeadsEnabled(true);
    expect(settings.get()).toEqual({ modrinthApiKey: "secret-key", playerHeadsEnabled: true, playerHeadsOnboardingCompleted: true });
    settings.setPlayerHeadsEnabled(false);
    expect(settings.get()).toEqual({ modrinthApiKey: "secret-key", playerHeadsEnabled: false, playerHeadsOnboardingCompleted: true });
  });

  it("reports stored image bytes and evicts least-recently-used rows", async () => {
    const { cache } = await repositories();
    for (let index = 0; index < 3; index += 1) {
      cache.set({ key: `player${index}`, playerName: `Player${index}`, bytes: Buffer.alloc(index + 2), fetchedAt: 1, refreshAfter: 2, lastAccessedAt: index });
    }
    expect(cache.stats()).toEqual({ entries: 3, bytes: 9 });
    expect(cache.enforceLimits(2, 100)).toEqual({ entries: 2, bytes: 7 });
    expect(cache.get("player0", 10)).toBeUndefined();
    cache.clear();
    expect(cache.stats()).toEqual({ entries: 0, bytes: 0 });
  });
});
