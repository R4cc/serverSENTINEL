import { describe, expect, it, vi } from "vitest";
import { OperationService } from "./operationService.js";

function repository() {
  const operation = { id: "op-1", type: "export.run", status: "running", progress: 0, task: "Queued", createdAt: "2026-01-01T00:00:00.000Z" } as const;
  return {
    operation,
    value: {
      create: vi.fn(() => operation),
      start: vi.fn(() => operation),
      update: vi.fn(),
      find: vi.fn(() => operation),
      succeed: vi.fn(),
      fail: vi.fn()
    }
  };
}

describe("OperationService", () => {
  it("drains delayed foreground and queued result writes before storage can close", async () => {
    const { value } = repository();
    const service = new OperationService(value as never, { markRestartRequired: vi.fn(), clearRestartRequired: vi.fn(), errorDetails: String });
    let finishForeground!: () => void;
    let finishQueued!: () => void;
    let finishCleanup!: () => void;
    const foreground = service.run({ type: "server.start", task: "Starting" },
      () => new Promise<void>((resolve) => { finishForeground = resolve; }));
    const cleanup = new Promise<void>((resolve) => { finishCleanup = resolve; });
    service.enqueue({ type: "export.run", task: "Exporting", failureTask: "Failed", failureFallback: "Failed",
      onSettled: () => cleanup }, () => new Promise<void>((resolve) => { finishQueued = resolve; }));
    const drained = vi.fn();
    const drain = service.drain().then(drained);
    await Promise.resolve();
    expect(drained).not.toHaveBeenCalled();
    finishForeground();
    await foreground;
    expect(value.succeed).toHaveBeenCalledTimes(1);
    expect(drained).not.toHaveBeenCalled();
    finishQueued();
    await vi.waitFor(() => expect(value.succeed).toHaveBeenCalledTimes(2));
    expect(drained).not.toHaveBeenCalled();
    finishCleanup();
    await drain;
    expect(drained).toHaveBeenCalledOnce();
  });

  it("runs foreground operations through one lifecycle", async () => {
    const { value } = repository();
    const mark = vi.fn();
    const service = new OperationService(value as never, { markRestartRequired: mark, clearRestartRequired: vi.fn(), errorDetails: String });
    await expect(service.run({ type: "export.run", serverId: "server-1", task: "Exporting", restartEffect: "mark" }, async () => ({ ok: true }))).resolves.toEqual({ ok: true });
    expect(value.start).toHaveBeenCalledWith("op-1", { progress: 5, task: "Exporting" });
    expect(value.succeed).toHaveBeenCalledWith("op-1", expect.objectContaining({ progress: 100 }));
    expect(mark).toHaveBeenCalledWith("server-1");
  });

  it("settles queued failures consistently", async () => {
    const { value, operation } = repository();
    const failed = { ...operation, status: "failed" as const };
    value.find.mockReturnValue(failed as never);
    const settled = vi.fn();
    const service = new OperationService(value as never, { markRestartRequired: vi.fn(), clearRestartRequired: vi.fn(), errorDetails: () => "details" });
    service.enqueue({ type: "export.run", task: "Queued", failureTask: "Export failed", failureFallback: "Export failed", onSettled: settled }, async () => {
      throw new Error("network failed");
    });
    await vi.waitFor(() => expect(value.fail).toHaveBeenCalledWith("op-1", "network failed", { task: "Export failed", logSummary: "details" }));
    await vi.waitFor(() => expect(settled).toHaveBeenCalledWith(failed));
  });
});
