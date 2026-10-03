import { beforeEach, expect, it, vi } from "vitest";
import type { ManagedServer } from "../types.js";

const fixtures = vi.hoisted(() => ({
  lifecycle: vi.fn(), serverStatus: vi.fn(), setRuntimeLifecycle: vi.fn(),
  invalidate: vi.fn(), noteRunning: vi.fn(), noteStopped: vi.fn()
}));

vi.mock("../appServices.js", () => ({
  runtimeForServer: () => ({ lifecycle: fixtures.lifecycle, serverStatus: fixtures.serverStatus }),
  services: {
    exportCoordinator: { withMutation: (_id: string, operation: () => Promise<unknown>) => operation() },
    serversRepository: { setRuntimeLifecycle: fixtures.setRuntimeLifecycle },
    runtimeStateCoordinator: { invalidate: fixtures.invalidate, noteRunning: fixtures.noteRunning, noteStopped: fixtures.noteStopped }
  }
}));
vi.mock("../runtime/local/dockerContainers.js", () => ({ serverLogFields: () => ({}) }));

import { startServerWithIntent } from "./lifecycle.js";
import { withModMutationLock } from "../mods/managedContent.js";

beforeEach(() => {
  vi.clearAllMocks();
  fixtures.lifecycle.mockResolvedValue({ docker: { running: true } });
  fixtures.serverStatus.mockResolvedValue({ docker: { available: true, running: false, state: "exited" } });
});

it.each([false, true])("preserves bounded retry history for a recovery start (failure: %s)", async (failure) => {
  const managed = { id: "a", runtimeIntent: "running", crashAttemptTimestamps: [new Date().toISOString()] } as ManagedServer;
  if (failure) fixtures.lifecycle.mockRejectedValueOnce(new Error("crashed again"));
  const result = startServerWithIntent(managed, { recovery: true });
  if (failure) await expect(result).rejects.toThrow("crashed again");
  else await result;
  expect(managed.crashAttemptTimestamps).toHaveLength(1);
  expect(fixtures.invalidate).not.toHaveBeenCalled();
  expect(fixtures.noteRunning).not.toHaveBeenCalled();
  expect(fixtures.noteStopped).not.toHaveBeenCalled();
});

it("lets an explicit start clear retry history and invalidate pending reconciliation", async () => {
  const managed = { id: "a", runtimeIntent: "running", crashAttemptTimestamps: [new Date().toISOString()] } as ManagedServer;
  await startServerWithIntent(managed);
  expect(managed.crashAttemptTimestamps).toEqual([]);
  expect(fixtures.invalidate).toHaveBeenCalledWith("a");
  expect(fixtures.noteRunning).toHaveBeenCalledWith("a");
});

it("blocks a scheduled or recovery start during a mod mutation and permits a retry afterward", async () => {
  const managed = { id: "a", runtimeIntent: "stopped" } as ManagedServer;
  const gate = Promise.withResolvers<void>();
  const mutation = withModMutationLock(managed.id, () => gate.promise);
  await expect(startServerWithIntent(managed)).rejects.toMatchObject({ statusCode: 409 });
  await expect(startServerWithIntent(managed, { recovery: true })).rejects.toMatchObject({ statusCode: 409 });
  expect(fixtures.lifecycle).not.toHaveBeenCalled();
  gate.resolve();
  await mutation;
  await startServerWithIntent(managed);
  expect(fixtures.lifecycle).toHaveBeenCalledOnce();
});
