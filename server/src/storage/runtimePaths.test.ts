import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeRuntimeDataRoot, runtimeDataPaths } from "./runtimePaths.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "serversentinel-data-root-"));
  temporaryDirectories.push(root);
  return root;
}

describe("runtime data paths", () => {
  it("derives storage model v2 paths from one canonical data root", async () => {
    const root = await temporaryRoot();
    const paths = runtimeDataPaths(root);

    expect(paths).toEqual({
      dataDir: resolve(root),
      databasePath: join(resolve(root), "serversentinel.sqlite"),
      serversDir: join(resolve(root), "servers"),
      backupsDir: join(resolve(root), "backups"),
      importsDir: join(resolve(root), "imports"),
      exportsDir: join(resolve(root), "exports"),
      tmpDir: join(resolve(root), "tmp"),
      nodeUpdatesDir: join(resolve(root), "tmp", "node-updates")
    });

    initializeRuntimeDataRoot(paths);

    for (const directory of [paths.dataDir, paths.serversDir, paths.backupsDir, paths.importsDir, paths.exportsDir, paths.tmpDir]) {
      expect(existsSync(directory)).toBe(true);
    }
  });
});
