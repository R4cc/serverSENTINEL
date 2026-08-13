import { afterEach, describe, expect, it, vi } from "vitest";
import { registerShutdownHandlers } from "./shutdown.js";

function captureSignalHandlers() {
  const handlers = new Map<string, () => void>();
  const once = vi.spyOn(process, "once").mockImplementation((signal, handler) => {
    handlers.set(String(signal), handler as () => void);
    return process;
  });
  const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => code) as never);
  return { handlers, once, exit };
}

const silentLogger = { info() {}, error() {} };

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("shutdown handlers", () => {
  it("drains registered teardown on SIGTERM and SIGINT before exiting", async () => {
    const { handlers, exit } = captureSignalHandlers();
    const close = vi.fn(async () => undefined);
    registerShutdownHandlers(close, { logger: silentLogger });

    expect([...handlers.keys()]).toEqual(["SIGTERM", "SIGINT"]);
    handlers.get("SIGTERM")!();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("ignores repeated signals so teardown never runs twice", async () => {
    const { handlers, exit } = captureSignalHandlers();
    const close = vi.fn(async () => undefined);
    registerShutdownHandlers(close, { logger: silentLogger });

    handlers.get("SIGTERM")!();
    handlers.get("SIGINT")!();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("exits non-zero when teardown fails", async () => {
    const { handlers, exit } = captureSignalHandlers();
    const errors: string[] = [];
    registerShutdownHandlers(async () => { throw new Error("database busy"); }, {
      logger: { info() {}, error: (_fields, message) => errors.push(message) }
    });

    handlers.get("SIGTERM")!();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(errors).toEqual(["Shutdown failed"]);
  });

  it("exits when teardown does not finish within the timeout", async () => {
    vi.useFakeTimers();
    const { handlers, exit } = captureSignalHandlers();
    registerShutdownHandlers(() => new Promise(() => undefined), { logger: silentLogger, timeoutMs: 5_000 });

    handlers.get("SIGTERM")!();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
