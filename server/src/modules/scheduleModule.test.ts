import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createScheduleModuleRuntime } from "./scheduleModule.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("schedules module runtime", () => {
  it.each([false, true])("orphans an old pending tick after disable/re-enable (failure: %s)", async (fail) => {
    let finish!: () => void;
    const tick = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve, reject) => {
      finish = () => fail ? reject(new Error("old tick failed")) : resolve();
    })).mockResolvedValue(undefined);
    const runtime = createScheduleModuleRuntime({ tick, onError: vi.fn(), intervalMs: 1_000 });
    runtime.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(tick).toHaveBeenCalledTimes(1);
    runtime.stop();
    runtime.start();
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(tick).toHaveBeenCalledTimes(2);
    runtime.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(tick).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("polls on an interval and stops polling once the module is switched off", async () => {
    const tick = vi.fn(async () => undefined);
    const runtime = createScheduleModuleRuntime({ tick, onError: vi.fn(), intervalMs: 1_000 });

    await runtime.start();
    expect(tick).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(tick).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(tick).toHaveBeenCalledTimes(2);

    await runtime.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it("keeps polling after a failed tick rather than stranding every schedule", async () => {
    const tick = vi.fn()
      .mockRejectedValueOnce(new Error("node offline"))
      .mockResolvedValue(undefined);
    const onError = vi.fn();
    const runtime = createScheduleModuleRuntime({ tick, onError, intervalMs: 1_000 });

    await runtime.start();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(tick).toHaveBeenCalledTimes(2);
    await runtime.stop();
  });

  it("ignores a second start so a re-enabled module never polls twice", async () => {
    const tick = vi.fn(async () => undefined);
    const runtime = createScheduleModuleRuntime({ tick, onError: vi.fn(), intervalMs: 1_000 });

    await runtime.start();
    await runtime.start();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(tick).toHaveBeenCalledTimes(1);
    await runtime.stop();
  });
});
