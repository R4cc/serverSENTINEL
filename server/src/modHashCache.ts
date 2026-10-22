import { createHash } from "node:crypto";

type ModHashCacheEntry = {
  size: number;
  modifiedAt: string | number;
  sha1: string;
};

export class ModHashCache {
  private readonly entries = new Map<string, ModHashCacheEntry>();

  constructor(private readonly maxEntries = 5_000) {}

  async sha1(key: string, size: number, modifiedAt: string | number, read: () => Promise<Buffer | AsyncIterable<Uint8Array>>) {
    const cached = this.entries.get(key);
    if (cached && cached.size === size && cached.modifiedAt === modifiedAt) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached.sha1;
    }

    const input = await read(), hash = createHash("sha1");
    if (Buffer.isBuffer(input)) hash.update(input);
    else {
      let received = 0;
      for await (const chunk of input) {
        received += chunk.byteLength;
        if (received > size) throw new Error("Mod file grew while hashing");
        hash.update(chunk);
      }
      if (received !== size) throw new Error("Mod file changed while hashing");
    }
    const sha1 = hash.digest("hex");
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
