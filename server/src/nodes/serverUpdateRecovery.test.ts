import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it } from "vitest";
import { openStorageDatabase, type StorageDatabase } from "../storage/database.js";
import type { ManagedServer } from "../types.js";
import { NodeServerUpdateRecovery } from "./serverUpdateRecovery.js";

let root: string;
let files: string;
let storage: StorageDatabase;
let previous: ManagedServer;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "serversentinel-update-recovery-"));
  files = join(root, "server");
  await mkdir(files);
  storage = openStorageDatabase(join(root, "state.sqlite"));
  previous = { id: "server", nodeId: "node", serverDir: files, runtimeProfile: { jarArtifact: { filename: "server.jar" } }, updatedAt: "before", configurationRevision: "initial" } as ManagedServer;
});
afterEach(async () => { storage.close(); await rm(root, { recursive: true, force: true }); });

it("restores overwritten files and removes newly created files after interrupted preparation", async () => {
  await writeFile(join(files, "server.jar"), "old jar");
  const recovery = new NodeServerUpdateRecovery(storage);
  await recovery.prepare(previous, { ...previous, updatedAt: "after" }, files, ["server.jar", "server.properties"]);
  await writeFile(join(files, "server.jar"), "new jar");
  await writeFile(join(files, "server.properties"), "new properties");
  storage.close();
  storage = openStorageDatabase(join(root, "state.sqlite"));
  await new NodeServerUpdateRecovery(storage).recover(previous.id, files);
  expect(await readFile(join(files, "server.jar"), "utf8")).toBe("old jar");
  await expect(readFile(join(files, "server.properties"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(new NodeServerUpdateRecovery(storage).pending(previous)).toBeUndefined();
});

it("retains committed configuration across restarts and rejects stale reconciliation", async () => {
  const recovery = new NodeServerUpdateRecovery(storage);
  const updated = { ...previous, dockerImage: "new:image", updatedAt: "after" };
  await recovery.prepare(previous, updated, files, []);
  recovery.applied(previous.id);
  storage.close();
  storage = openStorageDatabase(join(root, "state.sqlite"));
  const reopened = new NodeServerUpdateRecovery(storage);
  expect(reopened.pending(previous)?.server).toMatchObject({ dockerImage: "new:image", updatedAt: "after" });
  expect(reopened.pending({ ...previous, configurationRevision: "newer" })).toBeUndefined();
  expect(reopened.pending(updated)).toBeUndefined();
});

it("preserves the preceding committed update if a later file update fails", async () => {
  const recovery = new NodeServerUpdateRecovery(storage);
  const applied = { ...previous, dockerImage: "first:image", updatedAt: "first" };
  await recovery.prepare(previous, applied, files, []);
  recovery.applied(previous.id);
  await recovery.prepare(applied, { ...applied, dockerImage: "second:image" }, files, []);
  await recovery.recover(previous.id, files);
  expect(recovery.pending(previous)?.server.dockerImage).toBe("first:image");
});
