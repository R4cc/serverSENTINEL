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

  it("keeps existing progress when starting without a progress patch", async () => {
    const operations = await createRepository();
    const created = operations.create({ type: "server.restart", progress: 35 });

    const started = operations.start(created.id, { task: "Restarting" });

    expect(started).toMatchObject({
      status: "running",
      progress: 35,
      task: "Restarting"
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

  it("lists queued and running operations for a server in one active query", async () => {
    const operations = await createRepository();
    const queued = operations.create({ type: "file.extract", serverId: "server-a", createdAt: "2026-01-01T00:00:00.000Z" });
    const running = operations.create({ type: "server.start", serverId: "server-a", createdAt: "2026-01-01T00:00:01.000Z" });
    const finished = operations.create({ type: "server.stop", serverId: "server-a", createdAt: "2026-01-01T00:00:02.000Z" });
    const other = operations.create({ type: "server.start", serverId: "server-b" });
    operations.start(running.id);
    operations.succeed(finished.id);
    operations.start(other.id);

    expect(operations.listActive("server-a").map((operation) => operation.id)).toEqual([running.id, queued.id]);
  });

  it("prunes old finished operations and caps retained history", async () => {
    const operations = await createRepository();
    const old = operations.create({ type: "export.run", createdAt: "2026-01-01T00:00:00.000Z" });
    const recentA = operations.create({ type: "server.start", createdAt: "2026-02-01T00:00:00.000Z" });
    const recentB = operations.create({ type: "server.stop", createdAt: "2026-02-02T00:00:00.000Z" });
    const running = operations.create({ type: "server.restart", createdAt: "2026-01-01T00:00:00.000Z" });
    operations.start(running.id);
    operations.succeed(old.id, {}, "2026-01-01T00:00:01.000Z");
    operations.succeed(recentA.id, {}, "2026-02-01T00:00:01.000Z");
    operations.succeed(recentB.id, {}, "2026-02-02T00:00:01.000Z");

    expect(operations.deleteFinishedBefore("2026-01-15T00:00:00.000Z")).toBe(1);
    expect(operations.find(old.id)).toBeUndefined();
    expect(operations.find(running.id)).toMatchObject({ status: "running" });

    expect(operations.trimFinished(1)).toBe(1);
    expect(operations.find(recentA.id)).toBeUndefined();
    expect(operations.find(recentB.id)).toMatchObject({ status: "succeeded" });
    expect(operations.find(running.id)).toMatchObject({ status: "running" });
  });
});
