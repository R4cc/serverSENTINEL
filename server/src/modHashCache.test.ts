import { describe, expect, it, vi } from "vitest";
import { ModHashCache } from "./modHashCache.js";

describe("ModHashCache", () => {
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
