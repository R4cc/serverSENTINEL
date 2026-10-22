import { describe, expect, it, vi } from "vitest";
import { ModHashCache } from "./modHashCache.js";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";

describe("ModHashCache", () => {
  it("hashes streamed chunks without buffering the whole JAR and reuses the result", async () => {
    const cache = new ModHashCache();
    const read = vi.fn(async () => Readable.from([Buffer.from("mod "), Buffer.from("jar")]));
    const expected = createHash("sha1").update("mod jar").digest("hex");
    expect(await cache.sha1("streamed.jar", 7, 1, read)).toBe(expected);
    expect(await cache.sha1("streamed.jar", 7, 1, read)).toBe(expected);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("closes a growing stream and never caches its incomplete digest", async () => {
    const cache = new ModHashCache();
    let closed = false;
    async function* growing() {
      try { yield Buffer.from("too large"); }
      finally { closed = true; }
    }
    await expect(cache.sha1("changing.jar", 3, 1, async () => growing())).rejects.toThrow("grew while hashing");
    expect(closed).toBe(true);
    const read = vi.fn(async () => Readable.from([Buffer.from("jar")]));
    await cache.sha1("changing.jar", 3, 1, read);
    expect(read).toHaveBeenCalledOnce();
  });
  it("reuses hashes while file metadata is unchanged", async () => {
    const cache = new ModHashCache();
    const read = vi.fn(async () => Buffer.from("mod jar"));

    const first = await cache.sha1("server-a:mod.jar", 7, "2026-07-15T10:00:00.000Z", read);
    const second = await cache.sha1("server-a:mod.jar", 7, "2026-07-15T10:00:00.000Z", read);

    expect(second).toBe(first);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("rehashes a file when its size or modification time changes", async () => {
    const cache = new ModHashCache();
    const read = vi.fn()
      .mockResolvedValueOnce(Buffer.from("first"))
      .mockResolvedValueOnce(Buffer.from("second"))
      .mockResolvedValueOnce(Buffer.from("third"));

    await cache.sha1("server-a:mod.jar", 5, 1, read);
    await cache.sha1("server-a:mod.jar", 6, 1, read);
    await cache.sha1("server-a:mod.jar", 6, 2, read);

    expect(read).toHaveBeenCalledTimes(3);
  });
});
