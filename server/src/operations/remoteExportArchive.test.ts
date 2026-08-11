import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExportPlan } from "../importExport.js";
import type { ManagedServer } from "../types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.resetModules();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

beforeEach(() => {
  vi.resetModules();
});

async function loadStreamRemoteExportArchive() {
  const dataDir = await mkdtemp(join(tmpdir(), "serversentinel-remote-export-"));
  temporaryDirectories.push(dataDir);
  vi.stubEnv("SERVERSENTINEL_DATA_DIR", dataDir);
  const { streamRemoteExportArchive } = await import("./importExportService.js");
  return streamRemoteExportArchive;
}

const server = { id: "server-1", nodeId: "node-1", displayName: "Survival" } as ManagedServer;
const plan = { manifest: { servers: [] }, entries: [], totalBytes: 1024 } as unknown as ExportPlan;

function harness(downloadExportArchive?: () => Promise<unknown>) {
  const refusals: unknown[] = [];
  const progress: string[] = [];
  return {
    refusals,
    progress,
    input: {
      runtime: { downloadExportArchive } as never,
      server,
      plan,
      filename: "export.zip",
      signal: new AbortController().signal,
      report: (_value: number, task: string) => progress.push(task),
      onRefused: (error: unknown) => refusals.push(error)
    }
  };
}

describe("remote export archive", () => {
  it("hands back the node's archive stream when the node accepts", async () => {
    const streamRemoteExportArchive = await loadStreamRemoteExportArchive();
    const download = { filename: "export.zip", stream: Readable.from([]) };
    const { input, refusals, progress } = harness(async () => download);

    await expect(streamRemoteExportArchive(input)).resolves.toBe(download);
    expect(refusals).toEqual([]);
    expect(progress).toEqual(["Checking remote export support"]);
  });

  // A node running an older agent rejects the manifest schema outright, and a node configured with a
  // lower size or file limit than the panel rejects a selection the panel considers legal. Both used
  // to end the whole export instead of letting the panel build the archive itself.
  it("falls back to the panel archive when the node refuses the transfer", async () => {
    const streamRemoteExportArchive = await loadStreamRemoteExportArchive();
    const refusal = new Error("Unsupported export manifest");
    const { input, refusals } = harness(async () => { throw refusal; });

    await expect(streamRemoteExportArchive(input)).resolves.toBeUndefined();
    expect(refusals).toEqual([refusal]);
  });

  it("does not fall back when the export was cancelled", async () => {
    const streamRemoteExportArchive = await loadStreamRemoteExportArchive();
    const controller = new AbortController();
    const { input, refusals } = harness(async () => {
      controller.abort();
      throw new Error("Transfer cancelled");
    });

    await expect(streamRemoteExportArchive({ ...input, signal: controller.signal })).rejects.toThrow("Transfer cancelled");
    expect(refusals).toEqual([]);
  });

  it("skips the fast path entirely for a runtime that cannot stream an archive", async () => {
    const streamRemoteExportArchive = await loadStreamRemoteExportArchive();
    const { input, progress } = harness(undefined);

    await expect(streamRemoteExportArchive(input)).resolves.toBeUndefined();
    expect(progress).toEqual([]);
  });
});
