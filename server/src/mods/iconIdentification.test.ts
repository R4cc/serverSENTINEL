import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A manually uploaded jar is identified by its sha1. The hash used to be taken over a full
 * `readFile` of the jar -- up to the managed-content size limit, per unidentified mod, on every
 * list load. It is now streamed; the digest Modrinth is asked about must be the same.
 */
const fetchMock = vi.hoisted(() => vi.fn());
let dataDir: string;

vi.mock("../config.js", () => ({ config: { get dataDir() { return dataDir; } } }));
vi.mock("../modrinth/modrinthClient.js", () => ({ modrinthFetch: fetchMock }));

const roots: string[] = [];

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "serversentinel-icon-id-"));
  roots.push(dataDir);
  fetchMock.mockReset().mockResolvedValue({ json: async () => ({}) });
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("identifying an uploaded jar for its icon", () => {
  it("asks Modrinth about the jar's sha1, and only once while it stays unknown", async () => {
    const { ensureModrinthIconForFile } = await import("./icons.js");
    const serverDir = await realpath(await mkdtemp(join(tmpdir(), "serversentinel-icon-server-")));
    roots.push(serverDir);
    await mkdir(join(serverDir, "mods"));
    // Larger than one stream chunk, so the digest is built from several updates.
    const content = Buffer.alloc(200 * 1024, 7);
    content.write("manual-upload");
    const jar = join(serverDir, "mods", "manual.jar");
    await writeFile(jar, content);
    const server = {
      id: "server-1",
      serverDir,
      runtimeProfile: {
        minecraftVersion: "1.21.1",
        runtimeType: "fabric",
        runtimeVersion: "0.16.0",
        javaMajorVersion: 21,
        jarProvider: "mcjars",
        jarArtifact: { filename: "server.jar" },
        compatibilityStatus: "compatible",
        resolvedAt: "2026-01-01T00:00:00.000Z"
      }
    } as never;

    await expect(ensureModrinthIconForFile(server, "manual.jar", jar)).resolves.toBeUndefined();
    await expect(ensureModrinthIconForFile(server, "manual.jar", jar)).resolves.toBeUndefined();

    const sha1 = createHash("sha1").update(content).digest("hex");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`https://api.modrinth.com/v2/version_file/${sha1}?algorithm=sha1`);
  });
});
