import { createWriteStream } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { afterEach, describe, expect, it } from "vitest";
import { ZipFile } from "yazl";
import { extractZipArchive, indexZipArchive, planZipExtraction } from "./zipArchive.js";

const roots: string[] = [];
const limits = { maxEntries: 100, maxExpandedBytes: 1024 * 1024 };

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "serversentinel-zip-"));
  roots.push(root);
  return root;
}

async function writeZip(path: string, entries: Array<{ name: string; content?: string; directory?: boolean }>) {
  const zip = new ZipFile();
  for (const entry of entries) {
    if (entry.directory) zip.addEmptyDirectory(entry.name);
    else zip.addBuffer(Buffer.from(entry.content ?? ""), entry.name);
  }
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(path));
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ZIP archive indexing", () => {
  /**
   * Indexing synthesizes a record for every ancestor of every entry, so cost grows with the square
   * of the path depth. A 627 KB archive of 20 empty files nested 8,000 deep measured at 1.28 GB of
   * heap and 3.5 s of blocked event loop before this was bounded — and neither the entry count nor
   * the expanded-size limit sees it, because the entries are real and their content is empty.
   */
  it("refuses an archive whose entries are nested deeply enough to amplify indexing", async () => {
    const root = await temporaryRoot();
    const archive = join(root, "deep.zip");
    await writeZip(archive, [{ name: `${"a/".repeat(2_000)}f.txt`, content: "" }]);

    const startedAt = Date.now();
    await expect(indexZipArchive(archive, { maxEntries: 100, maxExpandedBytes: 1024 * 1024 }))
      .rejects.toThrow(/longer than|nested deeper/);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("refuses an entry nested past the segment limit even when the path is short", async () => {
    const root = await temporaryRoot();
    const archive = join(root, "segments.zip");
    await writeZip(archive, [{ name: `${"a/".repeat(70)}f.txt`, content: "" }]);

    await expect(indexZipArchive(archive, limits)).rejects.toThrow("nested deeper");
  });

  it("builds implicit folders for nested entries", async () => {
    const root = await temporaryRoot();
    const archive = join(root, "server.zip");
    await writeZip(archive, [
      { name: "config/server.yml", content: "enabled: true\n" },
      { name: "empty/", directory: true }
    ]);

    const index = await indexZipArchive(archive, limits);
    expect(index.entries.map((entry) => [entry.path, entry.type])).toEqual([
      ["config", "directory"],
      ["config/server.yml", "file"],
      ["empty", "directory"]
    ]);
    expect(index.entries.find((entry) => entry.path === "config/server.yml")).toMatchObject({ type: "file", size: 14 });
  });

  it("rejects traversal paths and expanded-size overflow", async () => {
    const root = await temporaryRoot();
    const archive = join(root, "unsafe.zip");
    await writeZip(archive, [{ name: "xx/evil", content: "bad" }]);
    const bytes = await readFile(archive);
    await writeFile(archive, Buffer.from(bytes.toString("binary").replaceAll("xx/evil", "../evil"), "binary"));
    await expect(indexZipArchive(archive, limits)).rejects.toThrow(/invalid relative path|unsafe path/);

    const large = join(root, "large.zip");
    await writeZip(large, [{ name: "large.txt", content: "x".repeat(100) }]);
    await expect(indexZipArchive(large, { ...limits, maxExpandedBytes: 10 })).rejects.toThrow("expands beyond");
  });
});

describe("ZIP extraction", () => {
  it("plans conflicts and supports skip and replace policies", async () => {
    const root = await temporaryRoot();
    const archive = join(root, "server.zip");
    const destination = join(root, "destination");
    await mkdir(join(destination, "config"), { recursive: true });
    await writeFile(join(destination, "config", "server.yml"), "old\n", "utf8");
    await writeZip(archive, [
      { name: "config/server.yml", content: "new\n" },
      { name: "mods/readme.txt", content: "hello\n" }
    ]);

    const plan = await planZipExtraction(archive, destination, limits);
    expect(plan).toMatchObject({ fileCount: 2, directoryCount: 2, totalBytes: 10 });
    expect(plan.conflicts).toHaveLength(1);

    const skipped = await extractZipArchive({ archivePath: archive, destinationPath: destination, conflictPolicy: "skip", limits });
    expect(skipped).toMatchObject({ extractedFiles: 1, skippedFiles: 1, replacedFiles: 0 });
    expect(await readFile(join(destination, "config", "server.yml"), "utf8")).toBe("old\n");
    expect(await readFile(join(destination, "mods", "readme.txt"), "utf8")).toBe("hello\n");

    const replaced = await extractZipArchive({ archivePath: archive, destinationPath: destination, conflictPolicy: "replace", limits });
    expect(replaced.replacedFiles).toBe(2);
    expect(await readFile(join(destination, "config", "server.yml"), "utf8")).toBe("new\n");
  });

  // The count is enforced while walking the central directory, so an over-limit archive is rejected
  // without every entry being retained first.
  it("rejects an archive with more entries than the limit allows", async () => {
    const root = await temporaryRoot();
    const archive = join(root, "many.zip");
    await writeZip(archive, Array.from({ length: 12 }, (_, index) => ({ name: `file-${index}.txt`, content: "x" })));

    await expect(indexZipArchive(archive, { maxEntries: 10, maxExpandedBytes: 1024 * 1024 }))
      .rejects.toMatchObject({ code: "zip_entry_limit" });
  });

  it("accepts an archive exactly at the entry limit", async () => {
    const root = await temporaryRoot();
    const archive = join(root, "exact.zip");
    await writeZip(archive, Array.from({ length: 10 }, (_, index) => ({ name: `file-${index}.txt`, content: "x" })));

    const index = await indexZipArchive(archive, { maxEntries: 10, maxExpandedBytes: 1024 * 1024 });
    expect(index.entries.filter((entry) => entry.type === "file")).toHaveLength(10);
  });
});
