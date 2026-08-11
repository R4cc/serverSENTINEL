import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExportCancelledError, ExportCoordinator } from "./exportCoordinator.js";
import { openStorageDatabase, type StorageDatabase } from "./storage/database.js";
import { OperationsRepository } from "./storage/operationsRepository.js";

const roots: string[] = [];
const databases: StorageDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "serversentinel-export-coordinator-"));
  roots.push(root);
  const database = openStorageDatabase(join(root, "state.sqlite"));
  databases.push(database);
  const operations = new OperationsRepository(database);
  return { operations, coordinator: new ExportCoordinator(operations) };
}

describe("export coordinator", () => {
  it("locks every included server and releases the scope after completion", async () => {
    const { coordinator } = await harness();
    let finish!: () => void;
    const pending = coordinator.run("export-1", ["server-1", "server-2"], () => new Promise<void>((resolve) => { finish = resolve; }));

    expect(coordinator.activeOperationId("server-1")).toBe("export-1");
    expect(coordinator.activeOperationId("server-2")).toBe("export-1");
    expect(() => coordinator.assertMutationAllowed("server-2")).toThrowError(expect.objectContaining({
      statusCode: 409,
      code: "EXPORT_IN_PROGRESS"
    }));
    expect(() => coordinator.assertCanStart(["server-2"])).toThrowError(expect.objectContaining({
      statusCode: 409,
      code: "EXPORT_ALREADY_RUNNING"
    }));

    finish();
    await pending;
    expect(coordinator.activeOperationId("server-1")).toBeUndefined();
    expect(() => coordinator.assertMutationAllowed("server-2")).not.toThrow();
  });

  it("reports cancelling until the aborting action unwinds", async () => {
    const { operations, coordinator } = await harness();
    const operation = operations.create({ type: "export.run", task: "Exporting" });
    operations.start(operation.id);
    let release!: () => void;
    const pending = coordinator.run(operation.id, ["server-1"], async (signal) => {
      await new Promise<void>((resolve) => { release = resolve; });
      signal.throwIfAborted();
    });

    expect(coordinator.requestCancel(operation.id)).toBe(true);
    expect(operations.find(operation.id)?.task).toBe("Cancelling export");
    expect(coordinator.activeOperationId("server-1")).toBe(operation.id);

    release();
    await expect(pending).rejects.toBeInstanceOf(ExportCancelledError);
    expect(coordinator.activeOperationId("server-1")).toBeUndefined();
  });

  it("does not start an export while a tracked server mutation is active", async () => {
    const { coordinator } = await harness();
    let finish!: () => void;
    const mutation = coordinator.withMutation("server-1", () => new Promise<void>((resolve) => { finish = resolve; }));

    expect(() => coordinator.assertCanStart(["server-1"])).toThrowError(expect.objectContaining({
      statusCode: 409,
      code: "SERVER_MUTATION_IN_PROGRESS"
    }));

    finish();
    await mutation;
    expect(() => coordinator.assertCanStart(["server-1"])).not.toThrow();
    expect(coordinator.mutationVersion("server-1")).toBe(1);
  });

  it("invalidates measured inventory even when a mutation fails", async () => {
    const { coordinator } = await harness();

    await expect(coordinator.withMutation("server-1", async () => { throw new Error("write failed"); })).rejects.toThrow("write failed");

    expect(coordinator.mutationVersion("server-1")).toBe(1);
  });

  it("keeps the server locked but closes cancellation before publishing the replacement", async () => {
    const { operations, coordinator } = await harness();
    const operation = operations.create({ type: "export.run", task: "Exporting" });
    operations.start(operation.id);
    let finish!: () => void;
    const pending = coordinator.run(operation.id, ["server-1"], async (_signal, beginCommit) => {
      beginCommit();
      await new Promise<void>((resolve) => { finish = resolve; });
    });

    expect(operations.find(operation.id)).toMatchObject({ progress: 99, task: "Finalizing export" });
    expect(coordinator.isCancellationAvailable(operation.id)).toBe(false);
    expect(coordinator.requestCancel(operation.id)).toBe(false);
    expect(() => coordinator.assertMutationAllowed("server-1")).toThrowError(expect.objectContaining({ code: "EXPORT_IN_PROGRESS" }));

    finish();
    await pending;
    expect(coordinator.activeOperationId("server-1")).toBeUndefined();
  });
});
