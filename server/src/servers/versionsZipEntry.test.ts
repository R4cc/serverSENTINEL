import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { launcherJarEntryMaxBytes, readZipEntry } from "./versions.js";

/**
 * A managed workload can rewrite its own launcher JAR, and `/api/app` reads it synchronously, so a
 * highly compressible entry must not be allowed to expand without bound on the panel event loop.
 */

function localFileHeader(name: string, data: Buffer, compressionMethod: number) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(compressionMethod, 8);
  header.writeUInt32LE(data.byteLength, 18);
  header.writeUInt16LE(Buffer.byteLength(name), 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, Buffer.from(name, "utf8"), data]);
}

describe("launcher JAR entry reads", () => {
  it("reads a small stored entry", () => {
    const payload = Buffer.from("game-version=1.21\n", "utf8");
    const jar = localFileHeader("install.properties", payload, 0);

    expect(readZipEntry(jar, "install.properties")?.toString("utf8")).toBe("game-version=1.21\n");
  });

  it("reads a small deflated entry", () => {
    const payload = Buffer.from("fabric-loader-version=0.16.0\n", "utf8");
    const jar = localFileHeader("install.properties", deflateRawSync(payload), 8);

    expect(readZipEntry(jar, "install.properties")?.toString("utf8")).toBe("fabric-loader-version=0.16.0\n");
  });

  it("refuses a deflate bomb instead of expanding it", () => {
    const bomb = deflateRawSync(Buffer.alloc(launcherJarEntryMaxBytes * 4, 0));
    expect(bomb.byteLength).toBeLessThan(launcherJarEntryMaxBytes);
    const jar = localFileHeader("install.properties", bomb, 8);

    expect(() => readZipEntry(jar, "install.properties")).toThrow();
  });

  it("refuses an oversized stored entry", () => {
    const jar = localFileHeader("install.properties", Buffer.alloc(launcherJarEntryMaxBytes + 1, 0x41), 0);

    expect(readZipEntry(jar, "install.properties")).toBeUndefined();
  });
});
