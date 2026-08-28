import { describe, expect, it } from "vitest";
import { extractFirstTarMember } from "./tarEntries.js";

const blockSize = 512;

function tarHeader(name: string, size: number, typeFlag = "0") {
  const header = Buffer.alloc(blockSize);
  header.write(name, 0, 100, "utf8");
  header.write("000644 \0", 100, 8, "utf8");
  header.write(`${size.toString(8).padStart(11, "0")} `, 124, 12, "utf8");
  header.write(typeFlag, 156, 1, "utf8");
  // The checksum field is treated as spaces while it is computed, and this reader ignores it.
  header.write("        ", 148, 8, "utf8");
  return header;
}

function tarArchive(members: Array<{ name: string; content: string; typeFlag?: string }>) {
  const blocks: Buffer[] = [];
  for (const member of members) {
    const content = Buffer.from(member.content, "utf8");
    blocks.push(tarHeader(member.name, content.length, member.typeFlag));
    blocks.push(content);
    const padding = content.length % blockSize === 0 ? 0 : blockSize - (content.length % blockSize);
    if (padding) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(blockSize * 2));
  return Buffer.concat(blocks);
}

async function* inChunks(buffer: Buffer, size: number) {
  for (let offset = 0; offset < buffer.length; offset += size) yield buffer.subarray(offset, offset + size);
}

async function extract(archive: Buffer, chunkSize: number) {
  const written: Buffer[] = [];
  const member = await extractFirstTarMember(
    inChunks(archive, chunkSize),
    (name) => name.toLowerCase().endsWith(".mmdb"),
    () => ({
      write(chunk) { written.push(Buffer.from(chunk)); },
      finish() { /* nothing to close for an in-memory sink */ }
    })
  );
  return { member, content: Buffer.concat(written).toString("utf8") };
}

describe("tar member extraction", () => {
  const archive = tarArchive([
    { name: "GeoLite2-City_20260810/COPYRIGHT.txt", content: "MaxMind" },
    { name: "GeoLite2-City_20260810/GeoLite2-City.mmdb", content: "x".repeat(1_500) },
    { name: "GeoLite2-City_20260810/LICENSE.txt", content: "CC BY-SA" }
  ]);

  it("finds the database past the files in front of it", async () => {
    const { member, content } = await extract(archive, 4_096);
    expect(member?.name).toBe("GeoLite2-City_20260810/GeoLite2-City.mmdb");
    expect(member?.size).toBe(1_500);
    expect(content).toBe("x".repeat(1_500));
  });

  it("reassembles a member split across arbitrary chunk boundaries", async () => {
    for (const chunkSize of [1, 7, 100, 512, 513, 10_000]) {
      const { member, content } = await extract(archive, chunkSize);
      expect(content, `chunk size ${chunkSize}`).toBe("x".repeat(1_500));
      expect(member?.size, `chunk size ${chunkSize}`).toBe(1_500);
    }
  });

  it("reports no member when the archive holds no database", async () => {
    const { member, content } = await extract(tarArchive([{ name: "readme.txt", content: "nothing here" }]), 512);
    expect(member).toBeUndefined();
    expect(content).toBe("");
  });

  it("ignores a directory entry that happens to be named like the database", async () => {
    const withDirectory = tarArchive([
      { name: "GeoLite2-City.mmdb/", content: "", typeFlag: "5" },
      { name: "nested/GeoLite2-City.mmdb", content: "real" }
    ]);
    const { member, content } = await extract(withDirectory, 512);
    expect(member?.name).toBe("nested/GeoLite2-City.mmdb");
    expect(content).toBe("real");
  });
});
