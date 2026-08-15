import { describe, expect, it, vi } from "vitest";
import { createManagedContentModuleRuntime } from "./managedContentModule.js";

function testCoordinator() {
  return { start: vi.fn(), stop: vi.fn() };
}

describe("managed content module runtime", () => {
  it("builds nothing until the module is started, so a disabled installation opens no update checker", () => {
    const createCoordinator = vi.fn(testCoordinator);
    const published: Array<ReturnType<typeof testCoordinator> | undefined> = [];
    createManagedContentModuleRuntime({ createCoordinator, publish: (coordinator) => published.push(coordinator) });

    expect(createCoordinator).not.toHaveBeenCalled();
    expect(published).toEqual([]);
  });

  it("publishes a running coordinator on start and withdraws it on stop", async () => {
    const coordinator = testCoordinator();
    const published: Array<ReturnType<typeof testCoordinator> | undefined> = [];
    const runtime = createManagedContentModuleRuntime({
      createCoordinator: () => coordinator,
      publish: (value) => published.push(value)
    });

    await runtime.start();
    expect(published).toEqual([coordinator]);
    expect(coordinator.start).toHaveBeenCalledTimes(1);

    await runtime.stop();
    expect(published).toEqual([coordinator, undefined]);
    expect(coordinator.stop).toHaveBeenCalledTimes(1);
  });

  it("builds a fresh coordinator when the module is switched back on", async () => {
    const created: Array<ReturnType<typeof testCoordinator>> = [];
    const runtime = createManagedContentModuleRuntime({
      createCoordinator: () => {
        const coordinator = testCoordinator();
        created.push(coordinator);
        return coordinator;
      },
      publish: () => undefined
    });

    await runtime.start();
    await runtime.stop();
    await runtime.start();

    expect(created).toHaveLength(2);
    expect(created[0].stop).toHaveBeenCalledTimes(1);
    expect(created[1].start).toHaveBeenCalledTimes(1);
    await runtime.stop();
  });

  it("ignores a repeated start so one module can only ever hold one update checker", async () => {
    const createCoordinator = vi.fn(testCoordinator);
    const runtime = createManagedContentModuleRuntime({ createCoordinator, publish: () => undefined });

    await runtime.start();
    await runtime.start();

    expect(createCoordinator).toHaveBeenCalledTimes(1);
    await runtime.stop();
  });
});
