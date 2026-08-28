import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { StoredUser } from "../types.js";
import { ROLE_PRESETS } from "../permissions.js";
import { openStorageDatabase, type StorageDatabase } from "./database.js";
import { UsersRepository } from "./usersRepository.js";

const temporaryDirectories: string[] = [];
const openDatabases: StorageDatabase[] = [];

afterEach(async () => {
  for (const database of openDatabases.splice(0)) database.close();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createRepository() {
  const root = await mkdtemp(join(tmpdir(), "serversentinel-users-repository-"));
  temporaryDirectories.push(root);
  const storage = openStorageDatabase(join(root, "state.sqlite"));
  openDatabases.push(storage);
  return new UsersRepository(storage);
}

function storedUser(overrides: Partial<StoredUser> = {}): StoredUser {
  return {
    id: "user-1",
    username: "admin",
    passwordHash: "hash",
    salt: "salt",
    rolePreset: "admin",
    permissions: [...ROLE_PRESETS.admin],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

describe("UsersRepository.findById", () => {
  it("reads one stored user by primary key", async () => {
    const repository = await createRepository();
    const user = storedUser();
    repository.create(user);

    expect(repository.findById(user.id)).toEqual(user);
    expect(repository.findById("missing-user")).toBeUndefined();
  });

  it("upgrades stored presets with permissions introduced after their accounts were created", async () => {
    const repository = await createRepository();
    const legacyAdmin = storedUser({
      permissions: ROLE_PRESETS.admin.filter((permission) => !["servers.export", "players.view", "players.manage"].includes(permission))
    });
    const legacyManager = storedUser({
      id: "manager-1",
      username: "manager",
      rolePreset: "manager",
      permissions: ROLE_PRESETS.manager.filter((permission) => !["servers.export", "players.view", "players.manage"].includes(permission))
    });
    const legacyViewer = storedUser({
      id: "viewer-1",
      username: "viewer",
      rolePreset: "viewer",
      permissions: ROLE_PRESETS.viewer.filter((permission) => permission !== "players.view")
    });
    repository.create(legacyAdmin);
    repository.create(legacyManager);
    repository.create(legacyViewer);

    expect(repository.findById(legacyAdmin.id)).toMatchObject({
      rolePreset: "admin",
      permissions: expect.arrayContaining(["servers.export", "players.view", "players.manage"])
    });
    expect(repository.findById(legacyManager.id)).toMatchObject({
      rolePreset: "manager",
      permissions: expect.arrayContaining(["servers.export", "players.view", "players.manage"])
    });
    expect(repository.findById(legacyViewer.id)).toMatchObject({
      rolePreset: "viewer",
      permissions: expect.arrayContaining(["players.view"])
    });
  });

  it("does not grant new preset permissions to a custom account", async () => {
    const repository = await createRepository();
    repository.create(storedUser());
    const custom = storedUser({
      id: "custom-1",
      username: "custom",
      rolePreset: "custom",
      permissions: ["servers.view", "settings.view"]
    });
    repository.create(custom);

    expect(repository.findById(custom.id)).toEqual(custom);
    expect(repository.findById(custom.id)?.permissions).not.toContain("players.view");
  });

  it("does not repair a divergent grant merely because its stored role names a preset", async () => {
    const repository = await createRepository();
    repository.create(storedUser());
    const divergent = storedUser({
      id: "divergent-1",
      username: "divergent",
      rolePreset: "viewer",
      permissions: ["servers.view", "settings.view"]
    });
    repository.create(divergent);

    expect(repository.findById(divergent.id)).toMatchObject({
      rolePreset: "custom",
      permissions: ["servers.view", "settings.view"]
    });
  });
});
