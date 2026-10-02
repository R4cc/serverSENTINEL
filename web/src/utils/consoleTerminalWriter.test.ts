import { describe, expect, it } from "vitest";
import { ConsoleTerminalWriter } from "./consoleTerminalWriter";

function fixture() {
  const writes: string[] = [];
  const callbacks: (() => void)[] = [];
  const idle: boolean[] = [];
  const writer = new ConsoleTerminalWriter({ write(text, complete) { writes.push(text); callbacks.push(complete); } }, replaced => idle.push(replaced));
  const finish = () => { callbacks.shift()?.(); };
  const drain = () => { while (callbacks.length) finish(); };
  return { writer, writes, idle, finish, drain };
}

describe("console terminal delivery", () => {
  it("bounds large history writes and preserves formatting across batch boundaries", () => {
    const { writer, writes, idle, drain } = fixture();
    writer.update([], 1);
    drain();
    writes.length = 0;
    idle.length = 0;
    const lines = Array.from({ length: 15000 }, (_, index) => ({ seq: index + 1, text: `§a${index} ${"output ".repeat(20)}\n` }));
    writer.update(lines, 1);
    expect(writes).toHaveLength(1);
    drain();
    expect(writes.length).toBeGreaterThan(1);
    // Minecraft codes expand into ANSI sequences; visible output uses a 256 KiB input budget.
    expect(Math.max(...writes.map(text => text.length))).toBeLessThan(295_000);
    const expected = lines.map(line => line.text.replace("§a", "\x1b[38;2;85;255;85m").replace("\n", "\r\n")).join("");
    expect(writes.join("") === expected).toBe(true);
    expect(idle).toEqual([false]);
  });

  it("resumes only the unwritten suffix while newer snapshots overlap an in-flight write", () => {
    const { writer, writes, idle, drain } = fixture();
    writer.update([{ seq: 1, text: "same\n" }], 1);
    writer.update([{ seq: 1, text: "same\n" }, { seq: 2, text: "same\n" }], 1);
    drain();
    expect(writes).toEqual(["\x1bc\x1b[?2026hsame\r\n\x1b[?2026l", "same\r\n\x1b[?2026l"]);
    expect(writer.update([{ seq: 2, text: "same\n" }], 1)).toBe(false);
    expect(idle).toEqual([true]);
    expect(writes).toHaveLength(2);
  });

  it("discards the unwritten old history and serializes replacement after the active parse", () => {
    const { writer, writes, idle, finish, drain } = fixture();
    writer.update([{ seq: 1, text: "old\n" }, { seq: 2, text: "x".repeat(4_200_000) }, { seq: 3, text: "discarded\n" }], 1);
    writer.update([{ seq: 1, text: "replacement\n" }], 2);
    writer.update([{ seq: 1, text: "latest\n" }], 3);
    expect(writes).toHaveLength(1);
    finish();
    drain();
    expect(writes[1]).toBe("\x1bc\x1b[?2026hlatest\r\n\x1b[?2026l");
    expect(writes.join("")).not.toContain("discarded");
    expect(writes.join("")).not.toContain("replacement");
    expect(idle).toEqual([true]);
  });

  it("completes empty replacements and ignores callbacks after disposal", () => {
    const { writer, writes, idle, finish, drain } = fixture();
    writer.update([], 1);
    drain();
    expect(writes).toEqual(["\x1bc\x1b[?2026h\x1b[?2026l"]);
    expect(idle).toEqual([true]);
    writer.update([{ seq: 1, text: "late\n" }], 1);
    writer.dispose();
    finish();
    writer.update([{ seq: 2, text: "disposed\n" }], 1);
    expect(writes).toHaveLength(2);
    expect(idle).toEqual([true]);
  });
});
