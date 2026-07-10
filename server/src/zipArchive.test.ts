import { createWriteStream } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { afterEach, describe, expect, it } from "vitest";
import { ZipFile } from "yazl";
import { extractZipArchive, indexZipArchive, listZipArchive, planZipExtraction, readZipArchiveEntry } from "./zipArchive.js";

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

describe("ZIP archive browsing", () => {
  it("builds implicit folders and reads nested text entries", async () => {
    const root = await temporaryRoot();
    const archive = join(root, "server.zip");
    await writeZip(archive, [
      { name: "config/server.yml", content: "enabled: true\n" },
      { name: "empty/", directory: true }
    ]);

    const top = await listZipArchive(archive, "/", limits);
    expect(top.readOnly).toBe(true);
    expect(top.entries.map((entry) => [entry.path, entry.type])).toEqual([
      ["/config", "directory"],
      ["/empty", "directory"]
    ]);
    const config = await listZipArchive(archive, "/config", limits);
    expect(config.entries[0]).toMatchObject({ path: "/config/server.yml", type: "file", size: 14 });
    const read = await readZipArchiveEntry(archive, "/config/server.yml", limits, 1024);
    expect(read.content.toString("utf8")).toBe("enabled: true\n");
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
});
