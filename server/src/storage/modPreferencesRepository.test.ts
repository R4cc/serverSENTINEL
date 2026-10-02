import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StorageDatabase } from "./database.js";
import { ModPreferencesRepository } from "./modPreferencesRepository.js";

let directory: string;
let database: StorageDatabase;
let repository: ModPreferencesRepository;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "serversentinel-mod-prefs-"));
  database = new StorageDatabase(join(directory, "test.sqlite"));
  database.connection.exec(`INSERT INTO nodes (id, name, type, status, is_internal, created_at, updated_at) VALUES ('local', 'Local', 'local', 'online', 1, '', '');
    INSERT INTO servers (id, node_id, display_name, server_dir, runtime_profile_json, created_at, updated_at) VALUES ('server-1', 'local', 'Test', '/test', '{}', '', '')`);
  repository = new ModPreferencesRepository(database);
});

afterEach(async () => {
  database?.close();
  await rm(directory, { recursive: true, force: true });
});

describe("mod preference enrichment revisions", () => {
  it("accepts unchanged enrichment and rejects stale snapshots across repository instances", () => {
    const snapshot = repository.snapshot("server-1");
    expect(repository.replaceAllIfUnchanged("server-1", { "first.jar": { channel: "beta" } }, snapshot.revision)).toBe(true);
    const beforeMutation = repository.snapshot("server-1");
    const another = new ModPreferencesRepository(database);
    another.replaceAll("server-1", { "new.jar": { channel: "alpha" } });
    expect(repository.replaceAllIfUnchanged("server-1", beforeMutation.preferences, beforeMutation.revision)).toBe(false);
    expect(repository.list("server-1")).toEqual({ "new.jar": { channel: "alpha", modrinth: undefined } });
  });

  it("keeps a deletion newer than an enrichment snapshot", () => {
    repository.replaceAll("server-1", { "old.jar": { channel: "release" } });
    const snapshot = repository.snapshot("server-1");
    repository.replaceAll("server-1", {});
    expect(repository.replaceAllIfUnchanged("server-1", snapshot.preferences, snapshot.revision)).toBe(false);
    expect(repository.list("server-1")).toEqual({});
  });

  it("ignores commits after the server or database is gone", () => {
    const snapshot = repository.snapshot("server-1");
    database.connection.prepare("DELETE FROM servers WHERE id = ?").run("server-1");
    expect(repository.replaceAllIfUnchanged("server-1", { "old.jar": { channel: "release" } }, snapshot.revision)).toBe(false);
    database.close();
    expect(repository.replaceAllIfUnchanged("server-1", {}, snapshot.revision)).toBe(false);
  });
});
