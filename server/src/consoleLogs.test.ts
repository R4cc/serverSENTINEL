import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { consoleLogLineLimit, readConsoleLogTail, tailConsoleLogText } from "./consoleLogs.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("console log history", () => {
  it("accepts configured history sizes and bounds untrusted limits", () => {
    expect(consoleLogLineLimit("5000")).toBe(5_000);
    expect(consoleLogLineLimit(50_000)).toBe(25_000);
    expect(consoleLogLineLimit("invalid")).toBe(5_000);
  });

  it("keeps complete trailing lines and preserves a final newline", () => {
    expect(tailConsoleLogText("one\ntwo\nthree\n", 2)).toBe("two\nthree\n");
    expect(tailConsoleLogText("partial\none\ntwo\n", 2, true)).toBe("one\ntwo\n");
  });

  it("reads the selected number of lines from latest.log", async () => {
    const directory = await mkdtemp(join(tmpdir(), "serversentinel-console-log-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "latest.log");
    await writeFile(path, `${Array.from({ length: 6_000 }, (_, index) => `line-${String(index).padStart(5, "0")}-payload`).join("\n")}\n`, "utf8");

    const text = await readConsoleLogTail(path, 5_000);
    const lines = text.trimEnd().split("\n");
    expect(lines).toHaveLength(5_000);
    expect(lines[0]).toBe("line-01000-payload");
    expect(lines.at(-1)).toBe("line-05999-payload");
  });
});
