import { afterEach, describe, expect, it, vi } from "vitest";
import { readStoredValue, writeStoredValue } from "./browserStorage";

function installStorage(storage: Partial<Storage>) {
  vi.stubGlobal("window", { localStorage: storage });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("browser storage helpers", () => {
  it("reads and writes through localStorage", () => {
    const values = new Map<string, string>();
    installStorage({ getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } });

    writeStoredValue("preference", "on");

    expect(readStoredValue("preference")).toBe("on");
    expect(readStoredValue("missing")).toBeNull();
  });

  it("returns null and swallows the error when storage throws", () => {
    const blocked = () => { throw new DOMException("blocked", "SecurityError"); };
    installStorage({ getItem: blocked, setItem: blocked });

    expect(readStoredValue("preference")).toBeNull();
    expect(() => writeStoredValue("preference", "on")).not.toThrow();
  });

  it("returns null when localStorage itself cannot be reached", () => {
    vi.stubGlobal("window", Object.defineProperty({}, "localStorage", { get() { throw new DOMException("denied", "SecurityError"); } }));

    expect(readStoredValue("preference")).toBeNull();
    expect(() => writeStoredValue("preference", "on")).not.toThrow();
  });
});
