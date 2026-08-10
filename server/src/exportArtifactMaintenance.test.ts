import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExportArtifactMaintenance } from "./exportArtifactMaintenance.js";
import { exportArtifactFilename } from "./importExport.js";
import { openStorageDatabase, type StorageDatabase } from "./storage/database.js";
import { OperationsRepository } from "./storage/operationsRepository.js";

const roots: string[] = [];
const databases: StorageDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "serversentinel-export-maintenance-"));
  roots.push(root);
  const exportsDir = join(root, "exports");
  await mkdir(exportsDir);
  const database = openStorageDatabase(join(root, "state.sqlite"));
  databases.push(database);
  const operations = new OperationsRepository(database);
  const maintenance = new ExportArtifactMaintenance(
    exportsDir,
    operations,
    60 * 60 * 1000,
    30 * 24 * 60 * 60 * 1000,
    1_000
  );
  return { exportsDir, operations, maintenance };
}

function artifactPath(exportsDir: string, operationId: string) {
  return join(exportsDir, exportArtifactFilename(operationId));
}

describe("export artifact maintenance", () => {
  it("retains the latest successful export indefinitely and ignores legacy expiry metadata", async () => {
    const { exportsDir, operations, maintenance } = await harness();
    const operation = operations.create({
      id: "00000000-0000-4000-8000-000000000001",
      type: "export.run",
      createdAt: "2026-01-01T00:00:00.000Z"
    });
    const path = artifactPath(exportsDir, operation.id);
    await writeFile(path, "sensitive export");
    operations.succeed(operation.id, {
      result: {
        artifactPath: path,
        artifact: {
          filename: exportArtifactFilename(operation.id),
          downloadUrl: `/api/exports/${operation.id}/download`,
          expiresAt: "2026-01-01T01:00:00.000Z"
        }
      }
    }, "2026-01-01T00:00:01.000Z");

    const report = await maintenance.maintain(Date.parse("2026-01-01T01:00:01.000Z"));

    expect(report.expiredArtifacts).toBe(0);
    expect(existsSync(path)).toBe(true);
    expect(operations.find(operation.id)).toMatchObject({
      status: "succeeded",
      result: {
        artifactPath: path,
        artifact: {
          downloadUrl: `/api/exports/${operation.id}/download`,
          expiresAt: "2026-01-01T01:00:00.000Z"
        }
      }
    });

    const secondReport = await maintenance.maintain(Date.parse("2026-01-01T02:00:00.000Z"));
    expect(secondReport.expiredArtifacts).toBe(0);
    expect(existsSync(path)).toBe(true);
  });

  it.each(["failed", "cancelled"] as const)("cleans partial files for %s exports", async (status) => {
    const { exportsDir, operations, maintenance } = await harness();
    const operation = operations.create({ type: "export.run" });
    const path = artifactPath(exportsDir, operation.id);
    const temporaryPath = `${path}.partial.tmp`;
    await writeFile(path, "partial export");
    await writeFile(temporaryPath, "partial temporary export");
    operations.start(operation.id);
    if (status === "failed") operations.fail(operation.id, "Export failed");
    else operations.cancel(operation.id, "Export cancelled");

    await maintenance.maintain();

    expect(existsSync(path)).toBe(false);
    expect(existsSync(temporaryPath)).toBe(false);
  });

  it("recovers orphaned export files", async () => {
    const { exportsDir, maintenance } = await harness();
    const orphan = join(exportsDir, "serversentinel-export-orphan.json");
    await writeFile(orphan, "orphaned secrets");

    const report = await maintenance.maintain();

    expect(report.orphanedArtifacts).toBe(1);
    expect(existsSync(orphan)).toBe(false);
  });

  it("does not mistake an active export's partial file for an orphan", async () => {
    const { exportsDir, operations, maintenance } = await harness();
    const operation = operations.create({ type: "export.run" });
    operations.start(operation.id);
    const partial = `${artifactPath(exportsDir, operation.id)}.write.tmp`;
    await writeFile(partial, "export in progress");

    await maintenance.maintain();

    expect(existsSync(partial)).toBe(true);
  });

  it("replaces the previous successful artifact only after a new export succeeds", async () => {
    const { exportsDir, operations, maintenance } = await harness();
    const operation = operations.create({
      id: "00000000-0000-4000-8000-000000000002",
      type: "export.run",
      serverId: "server-1",
      createdAt: "2026-01-01T00:00:00.000Z"
    });
    const path = artifactPath(exportsDir, operation.id);
    await writeFile(path, "retained export");
    operations.succeed(operation.id, {
      result: { artifactPath: path, artifact: { expiresAt: "2026-12-01T00:00:00.000Z" } }
    }, "2026-01-01T00:00:01.000Z");

    const failed = operations.create({
      id: "00000000-0000-4000-8000-000000000003",
      type: "export.run",
      createdAt: "2026-02-01T00:00:00.000Z",
      serverId: "server-1"
    });
    operations.start(failed.id);
    operations.replaceResult(failed.id, { serverIds: ["server-1"] });
    operations.fail(failed.id, "Export failed");

    await maintenance.prepareNewExport(["server-1"]);

    expect(existsSync(path)).toBe(true);
    expect(operations.find(operation.id)).toBeDefined();
    expect(operations.find(failed.id)).toBeUndefined();

    const replacement = operations.create({
      id: "00000000-0000-4000-8000-000000000004",
      type: "export.run",
      createdAt: "2026-02-02T00:00:00.000Z",
      serverId: "server-1"
    });
    operations.start(replacement.id);
    operations.replaceResult(replacement.id, { serverIds: ["server-1"] });
    await maintenance.replacePreviousSuccessfulExports(replacement.id, ["server-1"]);

    expect(existsSync(path)).toBe(false);
    expect(operations.find(operation.id)).toBeUndefined();
    expect(operations.find(replacement.id)).toBeDefined();
  });

  it("prunes legacy duplicate successful ZIPs while keeping the newest per server", async () => {
    const { exportsDir, operations, maintenance } = await harness();
    const older = operations.create({
      id: "00000000-0000-4000-8000-000000000005",
      type: "export.run",
      serverId: "server-1",
      createdAt: "2026-01-01T00:00:00.000Z"
    });
    const newer = operations.create({
      id: "00000000-0000-4000-8000-000000000006",
      type: "export.run",
      serverId: "server-1",
      createdAt: "2026-01-02T00:00:00.000Z"
    });
    const olderPath = artifactPath(exportsDir, older.id);
    const newerPath = artifactPath(exportsDir, newer.id);
    await writeFile(olderPath, "older export");
    await writeFile(newerPath, "newer export");
    operations.succeed(older.id, { result: { artifactPath: olderPath, serverIds: ["server-1"] } }, "2026-01-01T00:00:01.000Z");
    operations.succeed(newer.id, { result: { artifactPath: newerPath, serverIds: ["server-1"] } }, "2026-01-02T00:00:01.000Z");

    const report = await maintenance.maintain(Date.parse("2026-03-01T00:00:00.000Z"));

    expect(report.prunedOperations).toBe(1);
    expect(existsSync(olderPath)).toBe(false);
    expect(operations.find(older.id)).toBeUndefined();
    expect(existsSync(newerPath)).toBe(true);
    expect(operations.find(newer.id)).toBeDefined();
  });
});
