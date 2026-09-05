import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

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
    const emit = (line: string) => {
      const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{1,9}Z) /.exec(line);
      if (!match) { write(line); return; }
      const second = Math.floor(Date.parse(match[1]) / 1000);
      if (!Number.isFinite(second)) { write(line); return; }
      const key = createHash("sha256").update(line).digest("hex");
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
      write(line.slice(match[0].length));
    };
    return {
      write: (chunk: Buffer) => {
        pending += decoder.write(chunk);
        let end: number;
        while ((end = pending.indexOf("\n")) >= 0) {
          emit(pending.slice(0, end + 1));
          pending = pending.slice(end + 1);
        }
      },
      // Only a clean EOF completes an unterminated record. On failure it is replayed instead.
      end: () => { pending += decoder.end(); if (pending) emit(pending); pending = ""; }
    };
  }
}
