import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openStorageDatabase, type StorageDatabase } from "./database.js";
import { OperationsRepository } from "./operationsRepository.js";

const temporaryDirectories: string[] = [];
const openDatabases: StorageDatabase[] = [];

afterEach(async () => {
  for (const database of openDatabases.splice(0)) database.close();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createRepository() {
  const root = await mkdtemp(join(tmpdir(), "serversentinel-operations-"));
  temporaryDirectories.push(root);
  const storage = openStorageDatabase(join(root, "state.sqlite"));
  openDatabases.push(storage);
  return new OperationsRepository(storage);
}

describe("OperationsRepository", () => {
  it("records successful operations with result payloads", async () => {
    const operations = await createRepository();
    const created = operations.create({
      id: "00000000-0000-4000-8000-000000000001",
      type: "server.start",
      serverId: "server-id",
      nodeId: "node-id",
      createdBy: "user-id",
      task: "Queued"
    });

    operations.start(created.id, { progress: 10, task: "Starting" }, "2026-01-01T00:00:00.000Z");
    const completed = operations.succeed(created.id, {
      progress: 100,
      task: "Started",
      result: { ok: true },
      logSummary: "Container started"
    }, "2026-01-01T00:00:01.000Z");

    expect(completed).toMatchObject({
      id: created.id,
      type: "server.start",
      status: "succeeded",
      serverId: "server-id",
      nodeId: "node-id",
      createdBy: "user-id",
      progress: 100,
      task: "Started",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
      result: { ok: true },
      logSummary: "Container started"
    });
  });

  it("records failed operations with useful error state", async () => {
    const operations = await createRepository();
    const created = operations.create({ type: "mod.install", serverId: "server-id" });

    operations.start(created.id);
    const failed = operations.fail(created.id, "Download failed", { task: "Install failed", logSummary: "Modrinth returned 503" });

    expect(failed).toMatchObject({
      status: "failed",
      errorMessage: "Download failed",
      task: "Install failed",
      logSummary: "Modrinth returned 503"
    });
  });

  it("supports cancellation for queued or running operations", async () => {
    const operations = await createRepository();
    const created = operations.create({ type: "backup.create", serverId: "server-id" });

    const cancelled = operations.cancel(created.id, "Cancelled by admin");

    expect(cancelled).toMatchObject({
      status: "cancelled",
      errorMessage: "Cancelled by admin",
      task: "Cancelled by admin"
    });
  });

  it("marks incomplete operations as failed during startup recovery", async () => {
    const operations = await createRepository();
    const queued = operations.create({ type: "export.run" });
    const running = operations.create({ type: "server.restart" });
    operations.start(running.id);
    const succeeded = operations.create({ type: "server.stop" });
    operations.succeed(succeeded.id);

    expect(operations.failIncompleteOnStartup("Recovered after restart", "2026-01-01T00:00:00.000Z")).toBe(2);

    expect(operations.find(queued.id)).toMatchObject({ status: "failed", errorMessage: "Recovered after restart" });
    expect(operations.find(running.id)).toMatchObject({ status: "failed", errorMessage: "Recovered after restart" });
    expect(operations.find(succeeded.id)).toMatchObject({ status: "succeeded" });
  });

  it("lists operations by server and status", async () => {
    const operations = await createRepository();
    const first = operations.create({ type: "mod.update", serverId: "server-a", createdAt: "2026-01-01T00:00:00.000Z" });
    const second = operations.create({ type: "mod.remove", serverId: "server-a", createdAt: "2026-01-01T00:00:01.000Z" });
    const other = operations.create({ type: "mod.remove", serverId: "server-b", createdAt: "2026-01-01T00:00:02.000Z" });
    operations.start(second.id);
    operations.fail(second.id, "No file");
    operations.start(other.id);
    operations.fail(other.id, "No file");

    expect(operations.list({ serverId: "server-a" }).map((operation) => operation.id)).toEqual([second.id, first.id]);
    expect(operations.list({ serverId: "server-a", status: "failed" }).map((operation) => operation.id)).toEqual([second.id]);
  });
});
