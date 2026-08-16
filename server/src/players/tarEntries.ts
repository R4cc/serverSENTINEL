/**
 * Just enough tar to get one file out of MaxMind's GeoLite2 archive.
 *
 * The download is a `.tar.gz` holding a dated directory with the `.mmdb` inside it. Pulling in a
 * tar dependency for a single ~60 MB member is not worth it, and buffering the whole expanded
 * archive to reach that member is not worth it either — so this consumes the gunzip stream chunk
 * by chunk and hands the wanted member's bytes to a sink as they arrive.
 */

const blockSize = 512;

type TarHeader = {
  name: string;
  size: number;
  typeFlag: string;
};

function readString(block: Buffer, offset: number, length: number) {
  const raw = block.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString("utf8").trim();
}

function readOctal(block: Buffer, offset: number, length: number) {
  const value = readString(block, offset, length).replace(/[^0-7]/g, "");
  return value ? Number.parseInt(value, 8) : 0;
}

function parseHeader(block: Buffer): TarHeader | null {
  if (block.every((byte) => byte === 0)) return null;
  const prefix = readString(block, 345, 155);
  const name = readString(block, 0, 100);
  return {
    name: prefix ? `${prefix}/${name}` : name,
    size: readOctal(block, 124, 12),
    typeFlag: readString(block, 156, 1) || "0"
  };
}

export type TarMemberSink = {
  write(chunk: Buffer): Promise<void> | void;
  finish(): Promise<void> | void;
};

/**
 * Streams the first member matching `wanted` into a sink.
 *
 * Returns the member's name and size, or undefined when the archive held no match. Members after
 * the wanted one are skipped without being buffered, so the peak cost is one 512-byte block plus
 * whatever the sink keeps.
 */
export async function extractFirstTarMember(
  chunks: AsyncIterable<Buffer | Uint8Array>,
  wanted: (name: string) => boolean,
  openSink: (header: { name: string; size: number }) => TarMemberSink
) {
  let pending = Buffer.alloc(0);
  let header: TarHeader | undefined;
  let remaining = 0;
  let padding = 0;
  let sink: TarMemberSink | undefined;
  let extracted: { name: string; size: number } | undefined;

  for await (const rawChunk of chunks) {
    pending = pending.length === 0 ? Buffer.from(rawChunk) : Buffer.concat([pending, Buffer.from(rawChunk)]);
    while (true) {
      if (remaining > 0) {
        if (pending.length === 0) break;
        const take = Math.min(remaining, pending.length);
        if (sink) await sink.write(pending.subarray(0, take));
        pending = pending.subarray(take);
        remaining -= take;
        if (remaining === 0 && sink) {
          await sink.finish();
          extracted = { name: header!.name, size: header!.size };
          sink = undefined;
          // Everything after the wanted member is of no interest, and the archive is large.
          return extracted;
        }
        continue;
      }
      if (padding > 0) {
        const take = Math.min(padding, pending.length);
        pending = pending.subarray(take);
        padding -= take;
        if (padding > 0) break;
        continue;
      }
      if (pending.length < blockSize) break;
      const block = pending.subarray(0, blockSize);
      pending = pending.subarray(blockSize);
      header = parseHeader(block) ?? undefined;
      if (!header) continue;
      remaining = header.size;
      padding = remaining % blockSize === 0 ? 0 : blockSize - (remaining % blockSize);
      const isFile = header.typeFlag === "0" || header.typeFlag === "\0";
      if (isFile && wanted(header.name)) sink = openSink({ name: header.name, size: header.size });
      if (remaining === 0 && sink) {
        await sink.finish();
        return { name: header.name, size: header.size };
      }
    }
  }
  return extracted;
}
