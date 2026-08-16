import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PlayerLocation } from "@serversentinel/contracts";
import { openStorageDatabase, type StorageDatabase } from "./database.js";
import { PlayerGeoRepository } from "./playerGeoRepository.js";

const temporaryDirectories: string[] = [];
const openDatabases: StorageDatabase[] = [];

afterEach(async () => {
  for (const database of openDatabases.splice(0)) database.close();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const copenhagen: PlayerLocation = {
  label: "Copenhagen",
  city: "Copenhagen",
  country: "Denmark",
  countryCode: "DK",
  continent: "Europe",
  continentCode: "EU",
  latitude: 55.68,
  longitude: 12.57,
  accuracyRadiusKm: 20,
  precision: "city"
};

const sydney: PlayerLocation = { label: "Sydney", city: "Sydney", countryCode: "AU", continentCode: "OC", latitude: -33.87, longitude: 151.21, precision: "city" };

async function createRepository() {
  const root = await mkdtemp(join(tmpdir(), "serversentinel-player-geo-"));
  temporaryDirectories.push(root);
  const storage = openStorageDatabase(join(root, "state.sqlite"));
  openDatabases.push(storage);
  // The table is scoped to a server by a foreign key, so a row needs one to hang from.
  storage.connection.prepare("INSERT INTO nodes (id, name, type, status, is_internal, created_at, updated_at) VALUES ('local', 'Internal', 'local', 'online', 1, '2026-01-01', '2026-01-01')").run();
  storage.connection.prepare(`
    INSERT INTO servers (id, node_id, display_name, server_dir, runtime_profile_json, created_at, updated_at)
    VALUES ('server-1', 'local', 'Survival', '/servers/survival', '{}', '2026-01-01', '2026-01-01')
  `).run();
  return { storage, repository: new PlayerGeoRepository(storage) };
}

describe("player geography storage", () => {
  it("stores the derived place and nothing that could identify a connection", async () => {
    const { storage, repository } = await createRepository();
    repository.record({ serverId: "server-1", player: "SullyTheSnak", location: copenhagen, at: 1_000 });

    const [entry] = repository.list();
    expect(entry).toMatchObject({ serverId: "server-1", player: "SullyTheSnak", playerKey: "sullythesnak", observations: 1 });
    expect(entry.location).toEqual(copenhagen);

    // The privacy promise, checked against the bytes actually on disk rather than the API shape.
    const row = storage.connection.prepare<[], { location_json: string }>("SELECT location_json FROM player_geo_locations").get();
    expect(row?.location_json).not.toMatch(/\d{1,3}(\.\d{1,3}){3}/);
    const columns = storage.connection.prepare<[], { name: string }>("SELECT name FROM pragma_table_info('player_geo_locations')").all().map((column) => column.name);
    expect(columns).not.toContain("address");
    expect(columns).not.toContain("ip_hash");
  });

  it("counts a later join as another observation and replaces the place", async () => {
    const { repository } = await createRepository();
    repository.record({ serverId: "server-1", player: "SullyTheSnak", location: copenhagen, at: 1_000 });
    repository.record({ serverId: "server-1", player: "SullyTheSnak", location: sydney, at: 5_000 });

    const [entry] = repository.list();
    expect(entry).toMatchObject({ observations: 2, firstSeenAt: 1_000, lastSeenAt: 5_000 });
    expect(entry.location.city).toBe("Sydney");
  });

  it("does not count the same login again when the log window is polled a second time", async () => {
    const { repository } = await createRepository();
    repository.record({ serverId: "server-1", player: "SullyTheSnak", location: copenhagen, at: 5_000 });
    repository.record({ serverId: "server-1", player: "SullyTheSnak", location: copenhagen, at: 5_000 });
    repository.record({ serverId: "server-1", player: "SullyTheSnak", location: copenhagen, at: 1_000 });

    expect(repository.list()[0]).toMatchObject({ observations: 1, lastSeenAt: 5_000 });
  });

  it("treats the same player written differently as one player", async () => {
    const { repository } = await createRepository();
    repository.record({ serverId: "server-1", player: "SullyTheSnak", location: copenhagen, at: 1_000 });
    repository.record({ serverId: "server-1", player: "sullythesnak", location: copenhagen, at: 2_000 });

    expect(repository.list()).toHaveLength(1);
    expect(repository.find("server-1", "SULLYTHESNAK")?.observations).toBe(2);
  });

  it("prunes geography that stopped describing anyone who plays here", async () => {
    const { repository } = await createRepository();
    repository.record({ serverId: "server-1", player: "Old", location: copenhagen, at: 1_000 });
    repository.record({ serverId: "server-1", player: "Recent", location: copenhagen, at: 9_000 });

    expect(repository.prune(5_000)).toBe(1);
    expect(repository.list().map((entry) => entry.player)).toEqual(["Recent"]);
    expect(repository.stats()).toEqual({ entries: 1, servers: 1 });
  });

  it("lets go of a deleted server's geography with the server", async () => {
    const { storage, repository } = await createRepository();
    repository.record({ serverId: "server-1", player: "SullyTheSnak", location: copenhagen, at: 1_000 });
    storage.connection.prepare("DELETE FROM servers WHERE id = 'server-1'").run();
    expect(repository.list()).toEqual([]);
  });
});
