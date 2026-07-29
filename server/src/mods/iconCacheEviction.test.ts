import { mkdtemp, readdir, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Every distinct proxied URL hashes to its own cache file and nothing removed them, so an authenticated
 * mods.view caller could grow the data directory without bound by varying the URL.
 */

const maxEntries = 5;
let dataDir: string;

vi.mock("../config.js", () => ({
  config: {
    get dataDir() { return dataDir; },
    modrinthIconCacheMaxEntries: maxEntries
  }
}));

const roots: string[] = [];

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "serversentinel-icon-cache-"));
  roots.push(dataDir);
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function cacheDir() {
  return join(dataDir, "modrinth-icon-cache");
}

async function writeIcon(url: string) {
  const { writeCachedModrinthIcon } = await import("./icons.js");
  await writeCachedModrinthIcon(url, Buffer.from([0x89, 0x50, 0x4e, 0x47]), "https://cdn.modrinth.com/a.png", "image/png");
}

describe("Modrinth icon cache eviction", () => {
  it("keeps the cache at its entry ceiling as distinct URLs accumulate", async () => {
    for (let index = 0; index < maxEntries + 8; index += 1) {
      await writeIcon(`https://cdn.modrinth.com/icon-${index}.png`);
      // Space the mtimes so eviction order is deterministic on coarse filesystem clocks.
      const written = join(cacheDir(), (await readdir(cacheDir())).sort()[0]);
      await utimes(written, new Date(), new Date(Date.now() - (maxEntries + 8 - index) * 1000));
    }

    expect((await readdir(cacheDir())).length).toBeLessThanOrEqual(maxEntries);
  });

  it("evicts the least recently written entry first", async () => {
    for (let index = 0; index < maxEntries; index += 1) {
      await writeIcon(`https://cdn.modrinth.com/keep-${index}.png`);
    }
    const before = await readdir(cacheDir());
    const oldest = before.sort()[0];
    await utimes(join(cacheDir(), oldest), new Date(0), new Date(0));

    await writeIcon("https://cdn.modrinth.com/newest.png");

    const after = await readdir(cacheDir());
    expect(after).not.toContain(oldest);
    expect(after.length).toBeLessThanOrEqual(maxEntries);
  });

  it("leaves a cache under the ceiling untouched", async () => {
    await writeIcon("https://cdn.modrinth.com/only.png");

    const entries = await readdir(cacheDir());
    expect(entries).toHaveLength(1);
    expect((await stat(join(cacheDir(), entries[0]))).size).toBe(4);
  });
});
