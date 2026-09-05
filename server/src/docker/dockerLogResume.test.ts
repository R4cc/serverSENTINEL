import { describe, expect, it } from "vitest";
import { DockerLogResume } from "./dockerLogResume.js";

const timestamp = "2026-09-05T12:34:56.123456789Z ";
const limit = 16 * 1024;

describe("DockerLogResume", () => {
  it.each([false, true])("forwards 16 MiB before EOF with bounded fragments (timestamped: %s)", (timestamped) => {
    const resume = new DockerLogResume();
    let received = 0;
    const attachment = resume.attachment((text) => {
      expect(text.length).toBeLessThanOrEqual(limit);
      expect(text).toMatch(/^x+$/);
      received += text.length;
    });
    const size = 16 * 1024 * 1024;
    attachment.write(Buffer.from((timestamped ? timestamp : "") + "x".repeat(size)));
    expect(received).toBeGreaterThanOrEqual(size - limit);
    attachment.end();
    expect(received).toBe(size);
  });

  it("deduplicates long repeated records independently of transport chunk boundaries", () => {
    const resume = new DockerLogResume();
    const body = "x".repeat(limit * 3) + "\n";
    const record = timestamp + body;
    const first: string[] = [];
    resume.attachment((text) => first.push(text)).write(Buffer.from(record.repeat(2)));
    expect(first.join("")).toBe(body.repeat(2));
    expect(resume.since).toBe(Math.floor(Date.parse(timestamp.trim()) / 1000) - 1);
    const replayed: string[] = [];
    const attachment = resume.attachment((text) => replayed.push(text));
    const bytes = Buffer.from(record.repeat(3) + timestamp + "next\n");
    for (let offset = 0; offset < bytes.length; offset += 137) {
      attachment.write(bytes.subarray(offset, offset + 137));
    }
    attachment.end();
    expect(replayed.join("")).toBe(body + "next\n");
  });

  it("recovers an aborted suffix without replaying already emitted fragments", () => {
    const resume = new DockerLogResume();
    const output: string[] = [];
    const write = (text: string) => output.push(text);
    const body = "a".repeat(limit * 2) + "tail\n";
    const bytes = Buffer.from(timestamp + body);
    resume.attachment(write).write(bytes.subarray(0, limit + 100));
    expect(output.join("").length).toBe(limit - timestamp.length);
    const reattached = resume.attachment(write);
    reattached.write(bytes);
    reattached.end();
    expect(output.join("")).toBe(body);
  });

  it("preserves UTF-8 at byte and fragment boundaries and parses only the record prefix", () => {
    const resume = new DockerLogResume();
    const body = "a".repeat(limit - timestamp.length - 1) + "😀" + timestamp + "é".repeat(limit) + "\n";
    const bytes = Buffer.from(timestamp + body + timestamp + "next\n");
    const output: string[] = [];
    const attachment = resume.attachment((text) => output.push(text));
    for (let offset = 0; offset < bytes.length; offset += 7) {
      attachment.write(bytes.subarray(offset, offset + 7));
    }
    attachment.end();
    expect(output.join("")).toBe(body + "next\n");
    expect(output.every((text) => Buffer.from(text).toString() === text)).toBe(true);
    const replayed: string[] = [];
    const replay = resume.attachment((text) => replayed.push(text));
    replay.write(bytes);
    replay.end();
    expect(replayed).toEqual([]);
  });

  it("preserves malformed prefixes, split timestamps, and clean unterminated EOF replay", () => {
    const resume = new DockerLogResume();
    const output: string[] = [];
    const attachment = resume.attachment((text) => output.push(text));
    const invalid = "2026-99-99T99:99:99.1Z " + "x".repeat(limit) + "\n";
    attachment.write(Buffer.from(invalid + timestamp.slice(0, 10)));
    attachment.write(Buffer.from(timestamp.slice(10) + "tail"));
    expect(output.join("")).toBe(invalid);
    attachment.end();
    expect(output.join("")).toBe(invalid + "tail");
    const replayed: string[] = [];
    const replay = resume.attachment((text) => replayed.push(text));
    replay.write(Buffer.from(timestamp + "tail"));
    replay.end();
    expect(replayed).toEqual([]);
  });
});
