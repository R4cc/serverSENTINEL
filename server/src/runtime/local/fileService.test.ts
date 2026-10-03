import { chmod, lstat, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openContainedFile } from "../../core.js";
import {
  copyServerFile,
  createServerFolder,
  deleteServerEntry,
  listServerDirectory,
  moveServerEntry,
  previewServerFile,
  readServerTextFile,
  renameServerEntry,
  resolveUploadTarget,
  safeFileManagerName,
  toPublicServerPath,
  writeRuntimeUpload,
  writeServerTextFile
} from "./fileService.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, lstat: vi.fn(actual.lstat) };
});
vi.mock("../../core.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core.js")>();
  return { ...actual, openContainedFile: vi.fn(actual.openContainedFile) };
});

describe("fileService", () => {
  let serverDir: string;
  let scope: { serverDir: string };

  beforeEach(async () => {
    serverDir = await mkdtemp(join(tmpdir(), "serversentinel-files-"));
    scope = { serverDir };
  });

  afterEach(async () => {
    vi.mocked(lstat).mockReset();
    vi.mocked(openContainedFile).mockReset();
    await rm(serverDir, { recursive: true, force: true });
  });

  describe("safeFileManagerName", () => {
    it("accepts ordinary names with spaces and dashes", () => {
      expect(safeFileManagerName("my config-file 2.json")).toBe("my config-file 2.json");
    });

    it("rejects reserved characters and control characters", () => {
      expect(() => safeFileManagerName("a<b")).toThrow("unsafe characters");
      expect(() => safeFileManagerName(`a${String.fromCharCode(9)}b`)).toThrow("unsafe characters");
      expect(() => safeFileManagerName("x".repeat(161))).toThrow("unsafe characters");
    });

    it("rejects anything that is not a bare name", () => {
      // basename() strips the directory, so a path never equals its own name.
      expect(() => safeFileManagerName("a/b")).toThrow("A valid file or folder name is required");
      expect(() => safeFileManagerName("..")).toThrow("A valid file or folder name is required");
      expect(() => safeFileManagerName(" spaced ")).toThrow("A valid file or folder name is required");
      expect(() => safeFileManagerName(undefined)).toThrow("A valid file or folder name is required");
    });
  });

  it("renders public paths relative to the server root", () => {
    expect(toPublicServerPath(scope, serverDir)).toBe("/");
    expect(toPublicServerPath(scope, join(serverDir, "logs", "latest.log"))).toBe("/logs/latest.log");
  });

  it("lists directories first, then names, with a caller-supplied status", async () => {
    await mkdir(join(serverDir, "mods"));
    await writeFile(join(serverDir, "b.txt"), "b");
    await writeFile(join(serverDir, "a.txt"), "a");

    const listing = await listServerDirectory(scope, serverDir, { status: () => "managed" });
    expect(listing.entries.map((entry) => entry.name)).toEqual(["mods", "a.txt", "b.txt"]);
    expect(listing.entries.map((entry) => entry.type)).toEqual(["directory", "file", "file"]);
    expect(listing.entries.every((entry) => entry.status === "managed")).toBe(true);
  });

  it("defaults entry status to the file-manager classification", async () => {
    await writeFile(join(serverDir, "image.png"), Buffer.from([1, 2, 3]));
    const listing = await listServerDirectory(scope, serverDir);
    expect(listing.entries[0].status).toBe("binary");
  });

  it("omits entries removed during listing but propagates access errors", async () => {
    await writeFile(join(serverDir, "vanished.txt"), "gone");
    await writeFile(join(serverDir, "kept.txt"), "keep");
    const original = vi.mocked(lstat).getMockImplementation()!;
    vi.mocked(lstat).mockImplementation((...args) => String(args[0]).endsWith("vanished.txt")
      ? Promise.reject(Object.assign(new Error("removed"), { code: "ENOENT" })) : original(...args));
    expect((await listServerDirectory(scope, serverDir)).entries.map((entry) => entry.name)).toEqual(["kept.txt"]);
    vi.mocked(lstat).mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }));
    await expect(listServerDirectory(scope, serverDir)).rejects.toThrow("denied");
  });

  it("limits listing concurrency in large folders", async () => {
    await Promise.all(Array.from({ length: 80 }, (_, i) => writeFile(join(serverDir, `${i}.txt`), "x")));
    const original = vi.mocked(lstat).getMockImplementation()!;
    let active = 0;
    let peak = 0;
    vi.mocked(lstat).mockImplementation(async (...args) => {
      peak = Math.max(peak, ++active);
      try { return await original(...args); } finally { active--; }
    });
    expect((await listServerDirectory(scope, serverDir)).entries).toHaveLength(80);
    expect(peak).toBeLessThanOrEqual(32);
  });

  it("enforces read limits even if the file grows after stat", async () => {
    const target = join(serverDir, "growing.log");
    const original = vi.mocked(openContainedFile).getMockImplementation()!;
    vi.mocked(openContainedFile).mockImplementation(async (path) => {
      const handle = await original(path);
      const originalStat = handle.stat.bind(handle);
      vi.spyOn(handle, "stat").mockImplementation(async () => {
        const result = await originalStat();
        await writeFile(target, "x".repeat(2 * 1024 * 1024 + 20));
        return result;
      });
      return handle;
    });
    await writeFile(target, "small");
    expect(await previewServerFile(scope, target, { sizeLimit: 96 * 1024, requireTextLike: true })).toMatchObject({ preview: "too_large" });
    await writeFile(target, "small");
    await expect(readServerTextFile(scope, target)).rejects.toThrow("2 MiB editor limit");
  });

  describe("previewServerFile", () => {
    it("reports unsupported for non-text-like files only when the caller requires it", async () => {
      const target = join(serverDir, "image.png");
      await writeFile(target, "not really a png");

      expect(await previewServerFile(scope, target, { sizeLimit: 1024, requireTextLike: true }))
        .toMatchObject({ preview: "unsupported" });
      expect(await previewServerFile(scope, target, { sizeLimit: 1024, requireTextLike: false }))
        .toMatchObject({ preview: "text", content: "not really a png" });
    });

    it("reports too_large above the caller's limit and binary for NUL bytes", async () => {
      const big = join(serverDir, "big.txt");
      await writeFile(big, "x".repeat(50));
      expect(await previewServerFile(scope, big, { sizeLimit: 10, requireTextLike: true }))
        .toMatchObject({ preview: "too_large" });

      const binary = join(serverDir, "binary.txt");
      await writeFile(binary, Buffer.from([65, 0, 66]));
      expect(await previewServerFile(scope, binary, { sizeLimit: 1024, requireTextLike: true }))
        .toMatchObject({ preview: "binary" });
    });
  });

  it("reports why an editor read was rejected", async () => {
    const target = join(serverDir, "binary.txt");
    await writeFile(target, Buffer.from([65, 0, 66]));
    const rejections: string[] = [];

    await expect(readServerTextFile(scope, target, { onRejected: (reason) => rejections.push(reason) }))
      .rejects.toThrow("Binary files cannot be edited in the browser editor");
    expect(rejections).toEqual(["binary_file"]);
  });

  it("replaces edited files atomically and leaves no temporary file behind", async () => {
    const target = join(serverDir, "server.properties");
    await writeFile(target, "old");

    const result = await writeServerTextFile(scope, target, "new");
    expect(result).toEqual({ ok: true, path: "/server.properties" });
    expect(await readFile(target, "utf8")).toBe("new");
    const listing = await listServerDirectory(scope, serverDir);
    expect(listing.entries.map((entry) => entry.name)).toEqual(["server.properties"]);
  });

  it("rejects writes that are binary or not a string", async () => {
    const target = join(serverDir, "config.txt");
    await writeFile(target, "old");
    await expect(writeServerTextFile(scope, target, 42)).rejects.toThrow("Content is required");
    await expect(writeServerTextFile(scope, target, "a\0b")).rejects.toThrow("Binary files cannot be edited in the browser editor");
    expect(await readFile(target, "utf8")).toBe("old");
  });

  it.skipIf(process.platform === "win32")("preserves file permissions across an editor save", async () => {
    const target = join(serverDir, "restricted.conf");
    await writeFile(target, "old");
    await chmod(target, 0o640);
    await writeServerTextFile(scope, target, "new");
    expect((await stat(target)).mode & 0o777).toBe(0o640);
  });

  it("creates folders and refuses to clobber an existing entry", async () => {
    expect(await createServerFolder(scope, serverDir, "world")).toEqual({ ok: true, path: "/world" });
    await expect(createServerFolder(scope, serverDir, "world")).rejects.toThrow("already exists");
  });

  it("refuses to rename or move the server root", async () => {
    await expect(renameServerEntry(scope, serverDir, "other")).rejects.toThrow("Refusing to rename the server root directory");
    await expect(moveServerEntry(scope, serverDir, serverDir)).rejects.toThrow("Refusing to move the server root directory");
  });

  it("refuses to move a folder into itself", async () => {
    const parent = join(serverDir, "parent");
    const child = join(parent, "child");
    await mkdir(child, { recursive: true });
    await expect(moveServerEntry(scope, parent, child)).rejects.toThrow("A folder cannot be moved into itself");
  });

  it("reports an unchanged move destination", async () => {
    const target = join(serverDir, "note.txt");
    await writeFile(target, "hi");
    await expect(moveServerEntry(scope, target, serverDir)).rejects.toThrow("Item is already in that folder");
  });

  it("runs beforeApply after path checks but before the rename", async () => {
    const source = join(serverDir, "note.txt");
    const destination = join(serverDir, "sub");
    await writeFile(source, "hi");
    await mkdir(destination);

    await expect(moveServerEntry(scope, source, destination, {
      beforeApply: async () => { throw new Error("Stop the server first"); }
    })).rejects.toThrow("Stop the server first");
    expect(existsSync(source)).toBe(true);

    const calls: string[] = [];
    const result = await moveServerEntry(scope, source, destination, {
      beforeApply: async () => { calls.push("before"); }
    });
    expect(calls).toEqual(["before"]);
    expect(result.path).toBe("/sub/note.txt");
  });

  it("path errors take precedence over beforeApply", async () => {
    const source = join(serverDir, "note.txt");
    const destination = join(serverDir, "sub");
    await writeFile(source, "hi");
    await mkdir(destination);
    await writeFile(join(destination, "note.txt"), "collision");

    await expect(moveServerEntry(scope, source, destination, {
      beforeApply: async () => { throw new Error("Stop the server first"); }
    })).rejects.toThrow("A file or folder with that name already exists");
  });

  it("duplicates files into a target directory but refuses directories", async () => {
    const source = join(serverDir, "note.txt");
    await writeFile(source, "hi");
    expect(await copyServerFile(scope, source, serverDir, "copy.txt")).toEqual({ ok: true, path: "/copy.txt" });
    expect(await readFile(join(serverDir, "copy.txt"), "utf8")).toBe("hi");

    const folder = join(serverDir, "folder");
    await mkdir(folder);
    await expect(copyServerFile(scope, folder, serverDir, "folder-copy"))
      .rejects.toThrow("Only files can be duplicated from the browser file manager");
  });

  describe("deleteServerEntry", () => {
    it("validates the recursive flag and protects the server root", async () => {
      await expect(deleteServerEntry(scope, serverDir, "yes")).rejects.toThrow("recursive must be true or false");
      await expect(deleteServerEntry(scope, serverDir, "true")).rejects.toThrow("Refusing to delete the server root directory");
    });

    it("requires an explicit opt-in to remove a non-empty directory", async () => {
      const folder = join(serverDir, "world");
      await mkdir(folder);
      await writeFile(join(folder, "level.dat"), "data");

      await expect(deleteServerEntry(scope, folder, "false")).rejects.toThrow("Directory is not empty");
      expect(await deleteServerEntry(scope, folder, "true")).toEqual({ ok: true, path: "/world" });
      expect(existsSync(folder)).toBe(false);
    });
  });

  describe("resolveUploadTarget", () => {
    it("rejects a non-directory parent and an occupied name", async () => {
      const file = join(serverDir, "note.txt");
      await writeFile(file, "hi");
      await expect(resolveUploadTarget(scope, file, "x.txt")).rejects.toThrow("Upload path is not a directory");
      await expect(resolveUploadTarget(scope, serverDir, "note.txt")).rejects.toThrow("already exists");
    });

    it("returns the resolved destination for a free name", async () => {
      expect(await resolveUploadTarget(scope, serverDir, "new.txt")).toBe(join(serverDir, "new.txt"));
    });
  });

  describe("writeRuntimeUpload", () => {
    it("does not overwrite a file created while the upload is in progress", async () => {
      const target = await resolveUploadTarget(scope, serverDir, "concurrent.txt");
      await expect(writeRuntimeUpload(target, { stream: Readable.from(["upload"]) }, {
        maximumBytes: 1024, allowEmpty: true, label: "Uploaded file content",
        validateTemporary: async () => { await writeFile(target, "runtime content"); }
      })).rejects.toThrow("already exists");
      expect(await readFile(target, "utf8")).toBe("runtime content");
      expect((await listServerDirectory(scope, serverDir)).entries.map((entry) => entry.name)).toEqual(["concurrent.txt"]);
    });

    it("publishes only one of two concurrent uploads to the same path", async () => {
      const target = join(serverDir, "shared.txt");
      const results = await Promise.allSettled(["first", "second"].map((content) => writeRuntimeUpload(target, {
        stream: Readable.from([content])
      }, { maximumBytes: 1024, allowEmpty: true, label: "Uploaded file content" })));
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(["first", "second"]).toContain(await readFile(target, "utf8"));
      expect((await listServerDirectory(scope, serverDir)).entries.map((entry) => entry.name)).toEqual(["shared.txt"]);
    });

    it("writes a streamed upload and returns its size", async () => {
      const target = join(serverDir, "streamed.txt");
      const size = await writeRuntimeUpload(target, { stream: Readable.from([Buffer.from("hello")]), size: 5 }, {
        maximumBytes: 1024,
        allowEmpty: false,
        label: "Uploaded file content"
      });
      expect(size).toBe(5);
      expect(await readFile(target, "utf8")).toBe("hello");
    });

    it("leaves no file behind when a stream exceeds the limit", async () => {
      const target = join(serverDir, "toobig.txt");
      await expect(writeRuntimeUpload(target, { stream: Readable.from([Buffer.alloc(64)]) }, {
        maximumBytes: 8,
        allowEmpty: false,
        label: "Uploaded file content"
      })).rejects.toThrow("is larger than");
      expect(existsSync(target)).toBe(false);
      expect((await listServerDirectory(scope, serverDir)).entries).toEqual([]);
    });

    it("rejects a stream whose declared size does not match what arrived", async () => {
      const target = join(serverDir, "mismatch.txt");
      await expect(writeRuntimeUpload(target, { stream: Readable.from([Buffer.from("abc")]), size: 10 }, {
        maximumBytes: 1024,
        allowEmpty: false,
        label: "Uploaded file content"
      })).rejects.toThrow("declared 10 bytes but streamed 3");
      expect(existsSync(target)).toBe(false);
    });

    it("discards the upload when validateTemporary rejects it", async () => {
      const target = join(serverDir, "notajar.jar");
      await expect(writeRuntimeUpload(target, { stream: Readable.from([Buffer.from("nope")]), size: 4 }, {
        maximumBytes: 1024,
        allowEmpty: false,
        label: "Uploaded mod",
        validateTemporary: async () => { throw new Error("Uploaded mod must be a valid .jar file"); }
      })).rejects.toThrow("must be a valid .jar file");
      expect(existsSync(target)).toBe(false);
      expect((await listServerDirectory(scope, serverDir)).entries).toEqual([]);
    });
  });
});
