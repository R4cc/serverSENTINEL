import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openStorageDatabase, type StorageDatabase } from "../storage/database.js";
import { ServerLocationStore } from "./serverLocations.js";

const temporaryDirectories: string[] = [];
const openDatabases: StorageDatabase[] = [];

afterEach(async () => {
  for (const database of openDatabases.splice(0)) database.close();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createStore() {
  const root = await mkdtemp(join(tmpdir(), "serversentinel-server-locations-"));
  temporaryDirectories.push(root);
  const storage = openStorageDatabase(join(root, "state.sqlite"));
  openDatabases.push(storage);
  return new ServerLocationStore(storage);
}

describe("Player Insights server locations", () => {
  it("does not let an older resolution overwrite a newer address", async () => {
    const store = await createStore();
    store.set("server-1", { address: "old.example.net" });
    store.set("server-1", { address: "new.example.net" });

    store.setIfAddress("server-1", "old.example.net", {
      address: "old.example.net",
      location: { label: "Old", precision: "country" }
    });

    expect(store.get("server-1")).toEqual({ serverId: "server-1", address: "new.example.net" });
  });

  it("does not resurrect an address cleared while its resolution was in flight", async () => {
    const store = await createStore();
    store.set("server-1", { address: "old.example.net" });
    store.set("server-1", {});

    store.setIfAddress("server-1", "old.example.net", {
      address: "old.example.net",
      location: { label: "Old", precision: "country" }
    });

    expect(store.get("server-1")).toEqual({ serverId: "server-1" });
  });
});
