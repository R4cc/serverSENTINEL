import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

const fragmentLimit = 16 * 1024;

/** Keep one second of overlap, including Docker's whole-second `since` boundary. */
export class DockerLogResume {
  private latest = 0;
  private seen = new Map<string, { second: number; count: number }>();

  get since() { return Math.max(0, this.latest - 1); }

  attachment(write: (text: string) => void) {
    // Counts, rather than a set, preserve identical records sharing a nanosecond timestamp.
    const replay = new Map([...this.seen].map(([key, value]) => [key, value.count]));
    const decoder = new StringDecoder("utf8");
    let pending = "";
    let record: { second: number; hash: ReturnType<typeof createHash> } | null | undefined;
    const emit = (line: string) => {
      let prefixLength = 0;
      if (record === undefined) {
        const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{1,9}Z) /.exec(line);
        const second = match ? Math.floor(Date.parse(match[1]) / 1000) : NaN;
        record = Number.isFinite(second) ? { second, hash: createHash("sha256") } : null;
        if (record) prefixLength = match![0].length;
      }
      if (!record) { write(line); return; }
      const { second, hash } = record;
      // Hash deterministic fragments cumulatively without retaining the full record.
      // A reconnect can suppress emitted fragments and recover an unfinished suffix.
      const key = hash.update(line).copy().digest("hex");
      const remaining = replay.get(key) ?? 0;
      if (remaining > 0) { replay.set(key, remaining - 1); return; }
      if (second > this.latest) {
        this.latest = second;
        for (const [oldKey, record] of this.seen) {
          if (record.second < this.since) this.seen.delete(oldKey);
        }
      }
      this.seen.set(key, { second, count: (this.seen.get(key)?.count ?? 0) + 1 });
      // Bound memory even for a noisy workload. Eviction favors replay over losing output.
      if (this.seen.size > 8192) this.seen.delete(this.seen.keys().next().value!);
      write(line.slice(prefixLength));
    };
    const consume = (text: string) => {
      pending += text;
      while (pending) {
        const newline = pending.indexOf("\n");
        const complete = newline >= 0 && newline < fragmentLimit;
        if (!complete && pending.length < fragmentLimit) break;
        let length = complete ? newline + 1 : fragmentLimit;
        // Never divide a surrogate pair, even when it straddles the fragment boundary.
        const last = pending.charCodeAt(length - 1);
        if (!complete && last >= 0xd800 && last <= 0xdbff) length--;
        emit(pending.slice(0, length));
        pending = pending.slice(length);
        if (complete) record = undefined;
      }
    };
    return {
      write: (chunk: Buffer) => {
        // Bound decoding and concatenation too, including a single oversized input chunk.
        for (let offset = 0; offset < chunk.length; offset += fragmentLimit) {
          consume(decoder.write(chunk.subarray(offset, offset + fragmentLimit)));
        }
      },
      // Only clean EOF completes the buffered suffix. On failure it is replayed instead.
      end: () => { consume(decoder.end()); if (pending) emit(pending); pending = ""; record = undefined; }
    };
  }
}
