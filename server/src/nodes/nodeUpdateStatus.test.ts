import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { NodeUpdateFailure } from "@serversentinel/contracts";
import { openStorageDatabase, type StorageDatabase } from "../storage/database.js";
import { clearNodeUpdateFailure, readNodeUpdateFailure, setNodeUpdateFailure } from "./nodeUpdateStatus.js";

const temporaryDirectories: string[] = [];
const openDatabases: StorageDatabase[] = [];

afterEach(async () => {
  for (const database of openDatabases.splice(0)) database.close();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function storage() {
  const root = await mkdtemp(join(tmpdir(), "serversentinel-node-update-failure-"));
  temporaryDirectories.push(root);
  const database = openStorageDatabase(join(root, "serversentinel.sqlite"));
  openDatabases.push(database);
  return database;
}

const failure: NodeUpdateFailure = {
  at: "2026-08-14T10:00:00.000Z",
  stage: "start",
  message: "The replacement container could not start: executable file not found in $PATH",
  image: "nl2109/serversentinel:26.8.13",
  recovered: true,
  containerName: "serversentinel-node"
};

describe("node update failure records", () => {
  it("round-trips a reported failure and clears it per node", async () => {
    const database = await storage();

    expect(readNodeUpdateFailure(database, "node-1")).toBeUndefined();
    setNodeUpdateFailure(database, "node-1", failure);
    setNodeUpdateFailure(database, "node-2", { ...failure, stage: "reconnect" });

    expect(readNodeUpdateFailure(database, "node-1")).toEqual(failure);
    clearNodeUpdateFailure(database, "node-1");
    expect(readNodeUpdateFailure(database, "node-1")).toBeUndefined();
    expect(readNodeUpdateFailure(database, "node-2")).toMatchObject({ stage: "reconnect" });
  });

  it("ignores a record that can no longer be read as a failure", async () => {
    const database = await storage();
    database.setMetadata("node-update-failure:node-1", "{not json");

    expect(readNodeUpdateFailure(database, "node-1")).toBeUndefined();
  });
});
