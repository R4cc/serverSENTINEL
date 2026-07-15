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

function storedUser(): StoredUser {
  return {
    id: "user-1",
    username: "admin",
    passwordHash: "hash",
    salt: "salt",
    rolePreset: "admin",
    permissions: [...ROLE_PRESETS.admin],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
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
});
