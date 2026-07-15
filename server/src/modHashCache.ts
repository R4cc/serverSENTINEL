import { createHash } from "node:crypto";

type ModHashCacheEntry = {
  size: number;
  modifiedAt: string | number;
  sha1: string;
};

export class ModHashCache {
  private readonly entries = new Map<string, ModHashCacheEntry>();

  constructor(private readonly maxEntries = 5_000) {}

  async sha1(key: string, size: number, modifiedAt: string | number, read: () => Promise<Buffer>) {
    const cached = this.entries.get(key);
    if (cached && cached.size === size && cached.modifiedAt === modifiedAt) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached.sha1;
    }

    const sha1 = createHash("sha1").update(await read()).digest("hex");
    this.entries.delete(key);
    this.entries.set(key, { size, modifiedAt, sha1 });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return sha1;
  }
}
