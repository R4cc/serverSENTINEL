import { describe, expect, it } from "vitest";
import { DockerLogDecoder, DockerLogTextDecoder, stripDockerLogHeaders } from "./dockerLogs.js";

function dockerLogFrame(streamType: number, text: string) {
  const payload = Buffer.from(text, "utf8");
  const header = Buffer.alloc(8);
  header[0] = streamType;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

describe("Docker log decoding", () => {
  it("strips multiplexed Docker log headers from buffered logs", () => {
    const buffer = Buffer.concat([
      dockerLogFrame(1, "\x1b[32mstdout\x1b[0m\n"),
      dockerLogFrame(2, "\x1b[31mstderr\x1b[0m\n")
    ]);

    expect(stripDockerLogHeaders(buffer).toString("utf8")).toBe("\x1b[32mstdout\x1b[0m\n\x1b[31mstderr\x1b[0m\n");
  });

  it("demuxes frames split across stream chunks", () => {
    const decoder = new DockerLogDecoder();
    const frame = dockerLogFrame(1, "\x1b[38;5;82mLuckPerms\x1b[0m\n");

    expect(decoder.write(frame.subarray(0, 3)).toString("utf8")).toBe("");
    expect(decoder.write(frame.subarray(3, 12)).toString("utf8")).toBe("");
    expect(decoder.write(frame.subarray(12)).toString("utf8")).toBe("\x1b[38;5;82mLuckPerms\x1b[0m\n");
  });

  it("passes TTY/raw logs through without stripping ANSI bytes", () => {
    const raw = Buffer.from("\x1b[38;5;82mLuckPerms\x1b[0m\n", "utf8");
    const decoder = new DockerLogDecoder();

    expect(stripDockerLogHeaders(raw)).toEqual(raw);
    expect(decoder.write(raw)).toEqual(raw);
  });

  it("preserves ANSI sequences split across raw TTY chunks", () => {
    const decoder = new DockerLogDecoder();
    const first = Buffer.from("\x1b[38;2;24;", "utf8");
    const second = Buffer.from("166;255mLuckPerms\x1b[0m\n", "utf8");

    expect(Buffer.concat([decoder.write(first), decoder.write(second)]).toString("utf8"))
      .toBe("\x1b[38;2;24;166;255mLuckPerms\x1b[0m\n");
  });

  it("keeps a multi-byte character whole when Docker splits it across two frames", () => {
    const text = Buffer.from("café ✓ ok\n", "utf8");
    const split = text.indexOf(0xc3) + 1;
    const first = Buffer.concat([Buffer.from([1, 0, 0, 0, 0, 0, 0, split]), text.subarray(0, split)]);
    const rest = text.subarray(split);
    const second = Buffer.concat([Buffer.from([1, 0, 0, 0, 0, 0, 0, rest.length]), rest]);
    const decoder = new DockerLogTextDecoder();

    // Decoding each frame on its own, as the node agent used to, corrupts both halves.
    const frameDecoder = new DockerLogDecoder();
    expect(frameDecoder.write(first).toString("utf8") + frameDecoder.write(second).toString("utf8")).toContain("\uFFFD");

    const output = decoder.write(first) + decoder.write(second) + decoder.end();

    expect(output).toBe("café ✓ ok\n");
    expect(output).not.toContain("\uFFFD");
  });

  it("keeps a multi-byte character whole when a raw TTY chunk ends inside it", () => {
    const text = Buffer.from("§aWelcome ✓\n", "utf8");
    const decoder = new DockerLogTextDecoder();

    expect(decoder.write(text.subarray(0, 1)) + decoder.write(text.subarray(1)) + decoder.end()).toBe("§aWelcome ✓\n");
  });
});
