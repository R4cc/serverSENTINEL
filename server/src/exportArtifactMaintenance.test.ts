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
  it("expires successful exports and retains explicit expiry metadata", async () => {
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

    expect(report.expiredArtifacts).toBe(1);
    expect(existsSync(path)).toBe(false);
    expect(operations.find(operation.id)).toMatchObject({
      status: "succeeded",
      result: {
        artifact: {
          expiresAt: "2026-01-01T01:00:00.000Z",
          expiredAt: "2026-01-01T01:00:01.000Z"
        }
      }
    });
    expect(operations.find(operation.id)?.result).not.toHaveProperty("artifactPath");
    expect((operations.find(operation.id)?.result as { artifact: object }).artifact).not.toHaveProperty("downloadUrl");

    const secondReport = await maintenance.maintain(Date.parse("2026-01-01T02:00:00.000Z"));
    expect(secondReport.expiredArtifacts).toBe(0);
    expect(operations.find(operation.id)).toMatchObject({
      result: { artifact: { expiredAt: "2026-01-01T01:00:01.000Z" } }
    });
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

  it("removes an export artifact before pruning its operation record", async () => {
    const { exportsDir, operations, maintenance } = await harness();
    const operation = operations.create({
      id: "00000000-0000-4000-8000-000000000002",
      type: "export.run",
      createdAt: "2026-01-01T00:00:00.000Z"
    });
    const path = artifactPath(exportsDir, operation.id);
    await writeFile(path, "retained export");
    operations.succeed(operation.id, {
      result: { artifactPath: path, artifact: { expiresAt: "2026-12-01T00:00:00.000Z" } }
    }, "2026-01-01T00:00:01.000Z");

    const report = await maintenance.maintain(Date.parse("2026-02-15T00:00:00.000Z"));

    expect(report.prunedOperations).toBe(1);
    expect(existsSync(path)).toBe(false);
    expect(operations.find(operation.id)).toBeUndefined();
  });
});
