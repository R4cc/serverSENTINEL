import { describe, expect, it } from "vitest";
import type { FileEntry } from "../../types";
import { defaultFileSort, nextFileSort, sortFileEntries } from "./fileSorting";

function entry(name: string, type: FileEntry["type"], size = 0, modifiedAt = "2026-01-01T00:00:00.000Z"): FileEntry {
  return { name, path: `/${name}`, type, size, modifiedAt };
}

describe("file sorting", () => {
  const entries = [
    entry("beta.txt", "file", 20),
    entry("folder", "directory"),
    entry("alpha.txt", "file", 10)
  ];

  it("keeps directories first for ascending and descending sorts", () => {
    expect(sortFileEntries(entries, defaultFileSort).map((item) => item.name)).toEqual(["folder", "alpha.txt", "beta.txt"]);
    expect(sortFileEntries(entries, { id: "name", desc: true }).map((item) => item.name)).toEqual(["folder", "beta.txt", "alpha.txt"]);
  });

  it("uses names as stable tie breakers and toggles the active column", () => {
    expect(sortFileEntries(entries, { id: "size", desc: false }).map((item) => item.name)).toEqual(["folder", "alpha.txt", "beta.txt"]);
    expect(nextFileSort(defaultFileSort, "size")).toEqual({ id: "size", desc: false });
    expect(nextFileSort({ id: "size", desc: false }, "size")).toEqual({ id: "size", desc: true });
  });

  it("sorts an unparseable modified date as the oldest, whatever its name or position", () => {
    const dated = [
      entry("b.txt", "file", 0, "2026-01-01T00:00:00.000Z"),
      entry("c.txt", "file", 0, "2025-01-01T00:00:00.000Z"),
      entry("z.txt", "file", 0, "not-a-date"),
      entry("a.txt", "file", 0, "")
    ];
    const orders = [dated, [...dated].reverse(), [dated[2], dated[0], dated[3], dated[1]]];
    for (const order of orders) {
      expect(sortFileEntries(order, { id: "modifiedAt", desc: false }).map((item) => item.name)).toEqual(["a.txt", "z.txt", "c.txt", "b.txt"]);
      expect(sortFileEntries(order, { id: "modifiedAt", desc: true }).map((item) => item.name)).toEqual(["b.txt", "c.txt", "z.txt", "a.txt"]);
    }
  });
});
