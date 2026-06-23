import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openStorageDatabase, type StorageDatabase } from "./database.js";
import { fileEditLeaseTimeoutMs, FileEditLeasesRepository } from "./fileEditLeasesRepository.js";

const directories: string[] = [];
const databases: StorageDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createRepository() {
  const root = await mkdtemp(join(tmpdir(), "serversentinel-file-leases-"));
  directories.push(root);
  const storage = openStorageDatabase(join(root, "state.sqlite"));
  databases.push(storage);
  storage.connection.prepare(`
    INSERT INTO users (id, username, password_hash, salt, role_preset, permissions_json, created_at, updated_at)
    VALUES ('user-1', 'Alice', 'hash', 'salt', 'admin', '[]', 'now', 'now'),
           ('user-2', 'Bob', 'hash', 'salt', 'admin', '[]', 'now', 'now')
  `).run();
  storage.connection.prepare(`
    INSERT INTO sessions (id, user_id, created_at) VALUES ('session-1', 'user-1', 'now'), ('session-2', 'user-2', 'now')
  `).run();
  storage.connection.prepare(`
    INSERT INTO nodes (id, name, type, status, is_internal, created_at, updated_at)
    VALUES ('node', 'Node', 'remote', 'online', 0, 'now', 'now')
  `).run();
  storage.connection.prepare(`
    INSERT INTO servers (id, node_id, display_name, server_dir, runtime_profile_json, server_type, created_at, updated_at)
    VALUES ('server', 'node', 'Server', '/server', '{}', 'fabric', 'now', 'now')
  `).run();
  return new FileEditLeasesRepository(storage);
}

const alice = { userId: "user-1", sessionId: "session-1", displayName: "Alice" };
const bob = { userId: "user-2", sessionId: "session-2", displayName: "Bob" };

describe("FileEditLeasesRepository", () => {
  it("acquires one exclusive lease while allowing expiry recovery", async () => {
    const repository = await createRepository();
    const lease = repository.acquire({ serverId: "server", path: "/server.properties", fileRevision: "rev-1", owner: alice }, 1_000);
    expect(lease.displayName).toBe("Alice");
    expect(repository.requireOwned(lease.leaseId, "server", "/server.properties", alice, 2_000).leaseId).toBe(lease.leaseId);
    expect(() => repository.acquire({ serverId: "server", path: "/server.properties", fileRevision: "rev-1", owner: bob }, 2_000))
      .toThrow("Alice is already editing this file");
    expect(() => repository.requireOwned(lease.leaseId, "server", "/server.properties", bob, 2_001)).toThrow("no longer owned");

    const recovered = repository.acquire({ serverId: "server", path: "/server.properties", fileRevision: "rev-2", owner: bob }, 1_000 + fileEditLeaseTimeoutMs);
    expect(recovered.displayName).toBe("Bob");
  });

  it("heartbeats, validates ownership, and releases a lease", async () => {
    const repository = await createRepository();
    const lease = repository.acquire({ serverId: "server", path: "/ops.json", fileRevision: "rev", owner: alice }, 10_000);
    const refreshed = repository.heartbeat(lease.leaseId, alice, 20_000);
    expect(new Date(refreshed.expiresAt).getTime()).toBe(20_000 + fileEditLeaseTimeoutMs);
    expect(() => repository.requireOwned(lease.leaseId, "server", "/ops.json", bob, 20_001)).toThrow("no longer owned");
    expect(repository.release(lease.leaseId, alice)).toBe(true);
    expect(() => repository.requireOwned(lease.leaseId, "server", "/ops.json", alice, 20_002)).toThrow("expired");
  });

  it("rejects unnormalized lock paths", async () => {
    const repository = await createRepository();

    expect(() => repository.acquire({ serverId: "server", path: "ops.json", fileRevision: "rev", owner: alice })).toThrow("absolute");
    expect(() => repository.acquire({ serverId: "server", path: "/config/../ops.json", fileRevision: "rev", owner: alice })).toThrow("normalized");
    expect(() => repository.acquire({ serverId: "server", path: "/ops.json/", fileRevision: "rev", owner: alice })).toThrow("trailing slash");
  });

  it("force releases a lease only for the matching immutable server id", async () => {
    const repository = await createRepository();
    const lease = repository.acquire({ serverId: "server", path: "/ops.json", fileRevision: "rev", owner: alice }, 10_000);

    expect(repository.forceRelease(lease.leaseId, "other-server", 10_001)).toBe(false);
    expect(() => repository.acquire({ serverId: "server", path: "/ops.json", fileRevision: "rev", owner: bob }, 10_002)).toThrow("Alice is already editing this file");

    expect(repository.forceRelease(lease.leaseId, "server", 10_003)).toBe(true);
    const next = repository.acquire({ serverId: "server", path: "/ops.json", fileRevision: "rev", owner: bob }, 10_004);
    expect(next.displayName).toBe("Bob");
  });
});
