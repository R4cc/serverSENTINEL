const dockerLogHeaderLength = 8;
const dockerLogStreamTypes = new Set([0, 1, 2]);

function dockerLogHeaderState(buffer: Buffer, offset: number) {
  const available = buffer.length - offset;
  if (available <= 0) return "partial";

  const streamType = buffer[offset];
  if (!dockerLogStreamTypes.has(streamType)) return "invalid";

  const fixedHeaderLength = Math.min(available, 4);
  for (let index = 1; index < fixedHeaderLength; index += 1) {
    if (buffer[offset + index] !== 0) return "invalid";
  }

  if (available < dockerLogHeaderLength) return "partial";
  return "complete";
}

export class DockerLogDecoder {
  private pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  write(chunk: Buffer) {
    const buffer = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    this.pending = Buffer.alloc(0);
    if (!buffer.length) return Buffer.alloc(0);

    const initialHeaderState = dockerLogHeaderState(buffer, 0);
    if (initialHeaderState === "invalid") return buffer;
    if (initialHeaderState === "partial") {
      this.pending = buffer;
      return Buffer.alloc(0);
    }

    const chunks: Buffer[] = [];
    let offset = 0;
    while (offset < buffer.length) {
      const headerState = dockerLogHeaderState(buffer, offset);
      if (headerState === "invalid") {
        chunks.push(buffer.subarray(offset));
        offset = buffer.length;
        break;
      }
      if (headerState === "partial") {
        this.pending = buffer.subarray(offset);
        break;
      }

      const size = buffer.readUInt32BE(offset + 4);
      const start = offset + dockerLogHeaderLength;
      const end = start + size;
      if (end > buffer.length) {
        this.pending = buffer.subarray(offset);
        break;
      }

      chunks.push(buffer.subarray(start, end));
      offset = end;
    }

    return chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0);
  }

  flush() {
    const pending = this.pending;
    this.pending = Buffer.alloc(0);
    return pending;
  }
}

export function stripDockerLogHeaders(buffer: Buffer) {
  const decoder = new DockerLogDecoder();
  const decoded = decoder.write(buffer);
  const pending = decoder.flush();
  if (!decoded.length) return pending.length ? pending : buffer;
  return pending.length ? Buffer.concat([decoded, pending]) : decoded;
}
