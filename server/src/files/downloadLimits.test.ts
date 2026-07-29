import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The byte limit does not bound a download plan on its own: empty files cost no bytes but retain an
 * entry each, the finished plan sits in a global token map for five minutes, and a compromised node can
 * list a directory as its own child so the walk never terminates.
 */

vi.mock("../auth/sessionService.js", () => ({
  requireRequestPermission: async () => ({ id: "user-1", username: "tester" })
}));

const remoteServer = {
  id: "00000000-0000-4000-8000-000000000001",
  nodeId: "remote-node",
  displayName: "remote",
  serverDir: "/data/servers/remote",
  runtimeProfile: {
    minecraftVersion: "1.21",
    runtimeType: "fabric",
    runtimeVersion: "0.16.0",
    javaMajorVersion: 21,
    jarProvider: "mcjars",
    jarArtifact: { filename: "server.jar" },
    compatibilityStatus: "compatible",
    resolvedAt: "2026-01-01T00:00:00.000Z"
  }
} as never;

const request = { headers: { cookie: "sid=1" } };

function preparedDownload(entryCount: number) {
  return {
    entries: Array.from({ length: entryCount }, (_, index) => ({
      sourcePath: `/data/server/file-${index}`,
      archivePath: `file-${index}`,
      type: "file" as const,
      size: 0,
      modifiedAt: "2026-01-01T00:00:00.000Z"
    })),
    totalSize: 0,
    archiveFilename: "server-files.zip"
  };
}

/** A node that answers every directory listing with a single child directory, forever. */
function cyclicRuntime() {
  return {
    listFiles: async () => ({
      path: "/loop",
      entries: [{ name: "loop", path: "/loop", type: "directory", size: 0, modifiedAt: "2026-01-01T00:00:00.000Z" }]
    }),
    resolveExistingPath: async (_server: unknown, path: string) => `/data/servers/remote${path}`
  } as never;
}

/** A node that answers with `width` empty files, then nothing below them. */
function wideRuntime(width: number) {
  return {
    listFiles: async (_server: unknown, target: string) => ({
      path: "/wide",
      entries: target.endsWith("/wide")
        ? Array.from({ length: width }, (_, index) => ({
          name: `file-${index}`,
          path: `/wide/file-${index}`,
          type: "file" as const,
          size: 0,
          modifiedAt: "2026-01-01T00:00:00.000Z"
        }))
        : []
    }),
    resolveExistingPath: async (_server: unknown, path: string) => `/data/servers/remote${path}`
  } as never;
}

describe("archive download limits", () => {
  beforeEach(async () => {
    const { archiveDownloadTokens } = await import("./fileService.js");
    archiveDownloadTokens.clear();
  });

  it("keeps the token map at its ceiling as tokens accumulate", async () => {
    const { archiveDownloadTokenMaxCount, archiveDownloadTokens, createArchiveDownloadToken } = await import("./fileService.js");

    for (let index = 0; index < archiveDownloadTokenMaxCount + 10; index += 1) {
      createArchiveDownloadToken("server-1", preparedDownload(1));
    }

    expect(archiveDownloadTokens.size).toBe(archiveDownloadTokenMaxCount);
  });

  it("evicts the oldest token rather than the newest", async () => {
    const { archiveDownloadTokenMaxCount, archiveDownloadTokens, createArchiveDownloadToken } = await import("./fileService.js");

    const first = createArchiveDownloadToken("server-1", preparedDownload(1));
    archiveDownloadTokens.get(first)!.expiresAt = 1;
    for (let index = 0; index < archiveDownloadTokenMaxCount; index += 1) {
      createArchiveDownloadToken("server-1", preparedDownload(1));
    }

    expect(archiveDownloadTokens.has(first)).toBe(false);
    expect(archiveDownloadTokens.size).toBe(archiveDownloadTokenMaxCount);
  });

  it("stops a self-referential node listing instead of recursing forever", async () => {
    const { collectArchiveEntries, fileDownloadMaxDepth } = await import("./fileService.js");
    const entries: unknown[] = [];

    await expect(collectArchiveEntries(
      request,
      cyclicRuntime(),
      remoteServer,
      { type: "directory", path: "/loop", name: "loop", target: "/data/servers/remote/loop", size: 0, modifiedAt: "2026-01-01T00:00:00.000Z" } as never,
      "loop",
      entries as never,
      { size: 0 }
    )).rejects.toThrow(`deeper than ${fileDownloadMaxDepth} directories`);

    expect(entries.length).toBeLessThanOrEqual(fileDownloadMaxDepth + 1);
  });

  it("rejects a plan with more entries than the ceiling allows", async () => {
    const { collectArchiveEntries, fileDownloadMaxEntries } = await import("./fileService.js");
    const entries: unknown[] = [];

    await expect(collectArchiveEntries(
      request,
      wideRuntime(fileDownloadMaxEntries + 10),
      remoteServer,
      { type: "directory", path: "/wide", name: "wide", target: "/data/servers/remote/wide", size: 0, modifiedAt: "2026-01-01T00:00:00.000Z" } as never,
      "wide",
      entries as never,
      { size: 0 }
    )).rejects.toThrow(`more than ${fileDownloadMaxEntries} files and folders`);
  });

  it("accepts a plan that stays under the entry ceiling", async () => {
    const { collectArchiveEntries } = await import("./fileService.js");
    const entries: unknown[] = [];

    await collectArchiveEntries(
      request,
      wideRuntime(5),
      remoteServer,
      { type: "directory", path: "/wide", name: "wide", target: "/data/servers/remote/wide", size: 0, modifiedAt: "2026-01-01T00:00:00.000Z" } as never,
      "wide",
      entries as never,
      { size: 0 }
    );

    expect(entries).toHaveLength(6);
  });
});
