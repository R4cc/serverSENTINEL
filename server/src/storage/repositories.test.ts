import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ROLE_PRESETS } from "../permissions.js";
import type { ManagedNode, StoredUser } from "../types.js";
import { openStorageDatabase, type StorageDatabase } from "./database.js";
import { NodesRepository } from "./nodesRepository.js";
import { SessionsRepository } from "./sessionsRepository.js";
import { SettingsRepository } from "./settingsRepository.js";
import { UsersRepository } from "./usersRepository.js";

const temporaryDirectories: string[] = [];
const openDatabases: StorageDatabase[] = [];

afterEach(async () => {
  for (const database of openDatabases.splice(0)) database.close();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createStorage() {
  const root = await mkdtemp(join(tmpdir(), "serversentinel-repositories-"));
  temporaryDirectories.push(root);
  const storage = openStorageDatabase(join(root, "state.sqlite"));
  openDatabases.push(storage);
  return storage;
}

function storedUser(overrides: Partial<StoredUser> = {}): StoredUser {
  return {
    id: "admin-id",
    username: "admin",
    passwordHash: "password-hash",
    salt: "salt",
    rolePreset: "admin",
    permissions: [...ROLE_PRESETS.admin],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

describe("SQLite repositories", () => {
  it("stores users and cascades sessions when a user is deleted", async () => {
    const storage = await createStorage();
    const users = new UsersRepository(storage);
    const sessions = new SessionsRepository(storage);
    expect(users.list()).toEqual([]);

    const admin = storedUser();
    const operator = storedUser({
      id: "operator-id",
      username: "operator",
      rolePreset: "operator",
      permissions: [...ROLE_PRESETS.operator]
    });
    users.createFirst(admin, { id: "admin-session", userId: admin.id, createdAt: "2026-01-01T00:00:00.000Z" });
    users.create(operator);
    sessions.create({ id: "session-id", userId: operator.id, createdAt: "2026-01-02T00:00:00.000Z" });

    users.delete(operator.id);

    expect(users.list()).toEqual([admin]);
    expect(sessions.find("session-id")).toBeUndefined();
    expect(sessions.find("admin-session")).toBeDefined();
    expect(() => users.createFirst(storedUser({ id: "other" }), { id: "other-session", userId: "other", createdAt: "2026-01-03T00:00:00.000Z" }))
      .toThrow("Initial registration is already complete");
    expect(() => users.updateById(admin.id, (current) => ({
      ...current,
      rolePreset: "viewer",
      permissions: [...ROLE_PRESETS.viewer]
    }))).toThrow("At least one admin user is required");
    expect(users.list()[0].rolePreset).toBe("admin");
  });

  it("stores complete node records and applies metadata updates", async () => {
    const storage = await createStorage();
    const nodes = new NodesRepository(storage);
    const node: ManagedNode = {
      id: "node-id",
      name: "Remote Node",
      type: "remote",
      status: "online",
      isInternal: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      capabilities: ["node.update", "node.remove"],
      totalMemory: 8_589_934_592,
      compatibility: "compatible",
      secretHash: "secret"
    };

    nodes.create(node);
    nodes.updateById(node.id, (current) => ({ ...current, status: "offline", agentVersion: "0.8.0" }));

    expect(nodes.list()).toEqual([{ ...node, status: "offline", agentVersion: "0.8.0" }]);
  });

  it("stores panel settings without creating JSON state", async () => {
    const storage = await createStorage();
    const settings = new SettingsRepository(storage);
    expect(settings.get()).toEqual({ modrinthApiKey: undefined });

    settings.setModrinthApiKey("  modrinth-secret  ");

    expect(settings.get()).toEqual({ modrinthApiKey: "modrinth-secret" });
  });
});
