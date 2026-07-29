import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.resetModules();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

beforeEach(() => {
  vi.resetModules();
});

async function importsRoot() {
  const root = await mkdtemp(join(tmpdir(), "serversentinel-import-sweep-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "imports"), { recursive: true });
  return root;
}

async function loadSweeper(dataDir: string) {
  vi.stubEnv("SERVERSENTINEL_DATA_DIR", dataDir);
  const { sweepAbandonedImports } = await import("./importExportService.js");
  return sweepAbandonedImports;
}

describe("abandoned import sweep", () => {
  it("removes uploads older than the retention window and keeps recent ones", async () => {
    const root = await importsRoot();
    const stale = join(root, "imports", "import-00000000-0000-4000-8000-000000000001.zip");
    const fresh = join(root, "imports", "import-00000000-0000-4000-8000-000000000002.zip");
    await writeFile(stale, "stale", "utf8");
    await writeFile(fresh, "fresh", "utf8");
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await utimes(stale, old, old);

    const sweep = await loadSweeper(root);
    const result = await sweep();

    expect(result.removed).toBe(1);
    expect(await readdir(join(root, "imports"))).toEqual(["import-00000000-0000-4000-8000-000000000002.zip"]);
  });

  it("leaves unrelated files alone and tolerates a missing directory", async () => {
    const root = await importsRoot();
    const unrelated = join(root, "imports", "notes.txt");
    await writeFile(unrelated, "keep", "utf8");
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await utimes(unrelated, old, old);

    const sweep = await loadSweeper(root);
    expect((await sweep()).removed).toBe(0);
    expect(await readdir(join(root, "imports"))).toEqual(["notes.txt"]);

    await rm(join(root, "imports"), { recursive: true, force: true });
    expect((await sweep()).removed).toBe(0);
  });
});
