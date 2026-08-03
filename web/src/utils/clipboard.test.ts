import { describe, expect, it, vi } from "vitest";
import { copyToClipboard, type ClipboardHost } from "./clipboard";

type TestCarrier = {
  value: string;
  readOnly: boolean;
  removed: boolean;
  selectedRange?: [number, number];
  style: { position: string; top: string; opacity: string };
  select(): void;
  setSelectionRange(start: number, end: number): void;
  remove(): void;
};

/** The suite runs without a DOM, so the carrier the copy falls back to is stood up by hand. */
function testHost(overrides: {
  isSecureContext?: boolean;
  writeText?: (text: string) => Promise<void>;
  execCommand?: (command: string) => boolean;
} = {}) {
  const carriers: TestCarrier[] = [];
  const attached: TestCarrier[] = [];
  const focused = { focus: vi.fn() };
  const host = {
    isSecureContext: overrides.isSecureContext ?? true,
    navigator: overrides.writeText ? { clipboard: { writeText: overrides.writeText } } : {},
    document: {
      createElement: () => {
        const carrier: TestCarrier = {
          value: "",
          readOnly: false,
          removed: false,
          style: { position: "", top: "", opacity: "" },
          select: () => {},
          setSelectionRange: (start: number, end: number) => { carrier.selectedRange = [start, end]; },
          remove: () => { carrier.removed = true; }
        };
        carriers.push(carrier);
        return carrier;
      },
      body: { appendChild: (node: TestCarrier) => attached.push(node) },
      execCommand: overrides.execCommand ?? (() => true),
      activeElement: focused
    }
  } as unknown as ClipboardHost;
  return { host, carriers, attached, focused };
}

describe("copyToClipboard", () => {
  it("uses the clipboard API where the panel is served securely", async () => {
    const writeText = vi.fn(async () => {});
    const { host, attached } = testHost({ writeText });

    expect(await copyToClipboard("say hello", host)).toBe(true);
    expect(writeText).toHaveBeenCalledWith("say hello");
    expect(attached).toHaveLength(0);
  });

  it("copies through a carrier when the clipboard API is not exposed", async () => {
    // A panel reached over plain HTTP on a LAN has no navigator.clipboard at all, which is the
    // deployment this path exists for rather than an exotic browser.
    const { host, carriers, attached, focused } = testHost({ isSecureContext: false });

    expect(await copyToClipboard("Done (5.1s)!", host)).toBe(true);
    expect(attached).toHaveLength(1);
    expect(carriers[0].value).toBe("Done (5.1s)!");
    expect(carriers[0].selectedRange).toEqual([0, "Done (5.1s)!".length]);
    // The carrier must not outlive the copy, and the command line must get its caret back.
    expect(carriers[0].removed).toBe(true);
    expect(focused.focus).toHaveBeenCalled();
  });

  it("falls back to the carrier when the clipboard API refuses", async () => {
    const { host, attached } = testHost({ writeText: async () => { throw new Error("Denied"); } });

    expect(await copyToClipboard("list", host)).toBe(true);
    expect(attached).toHaveLength(1);
  });

  it("reports a copy that did not happen", async () => {
    const { host } = testHost({ isSecureContext: false, execCommand: () => false });

    expect(await copyToClipboard("list", host)).toBe(false);
    expect(await copyToClipboard("", host)).toBe(false);
  });
});
