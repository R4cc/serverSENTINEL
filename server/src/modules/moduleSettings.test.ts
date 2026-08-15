import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openStorageDatabase, type StorageDatabase } from "../storage/database.js";
import { readDisabledModules, writeDisabledModules } from "./moduleSettings.js";

const roots: string[] = [];
const databases: StorageDatabase[] = [];
const disabledModulesKey = "modules.disabled";

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function storage() {
  const root = await mkdtemp(join(tmpdir(), "serversentinel-module-settings-"));
  roots.push(root);
  const database = openStorageDatabase(join(root, "state.sqlite"));
  databases.push(database);
  return database;
}

describe("module enablement storage", () => {
  it("treats an absent, malformed, or non-array value as nothing disabled", async () => {
    const database = await storage();
    expect(readDisabledModules(database).size).toBe(0);

    for (const value of ["not json", '"schedules"', "{}", "[1, true, null]"]) {
      database.setMetadata(disabledModulesKey, value);
      expect(readDisabledModules(database).size, value).toBe(0);
    }
  });

  it("round-trips the modules this build knows about", async () => {
    const database = await storage();
    writeDisabledModules(database, ["managedContent"]);
    expect([...readDisabledModules(database)]).toEqual(["managedContent"]);

    writeDisabledModules(database, []);
    expect([...readDisabledModules(database)]).toEqual([]);
  });

  it("keeps an unrecognized module's setting instead of quietly switching it back on", async () => {
    // What a newer release wrote, read by an older one that has no such module.
    const database = await storage();
    database.setMetadata(disabledModulesKey, JSON.stringify(["schedules", "somethingFromALaterRelease"]));

    expect([...readDisabledModules(database)]).toEqual(["schedules"]);

    // An unrelated toggle must not drop the setting the older build cannot interpret.
    writeDisabledModules(database, readDisabledModules(database));
    expect(JSON.parse(database.metadata(disabledModulesKey)!)).toEqual(["schedules", "somethingFromALaterRelease"]);

    writeDisabledModules(database, []);
    expect(JSON.parse(database.metadata(disabledModulesKey)!)).toEqual(["somethingFromALaterRelease"]);
  });
});
