import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Staging and the servers folder are often different mounts, so the move falls back to copying.
 * A copy that failed partway used to leave a half-written server folder behind: the import only
 * records the destination for cleanup once the move returns, and the move never returned.
 */
const fsControl = vi.hoisted(() => ({ crossDevice: false, failCopy: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (fsControl.crossDevice) throw Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
      return actual.rename(...args);
    },
    cp: async (source: string, destination: string, options?: Parameters<typeof actual.cp>[2]) => {
      if (!fsControl.failCopy) return actual.cp(source, destination, options);
      await actual.writeFile(join(destination, "partial.dat"), "half");
      throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    }
  };
});

const roots: string[] = [];

afterEach(async () => {
  fsControl.crossDevice = false;
  fsControl.failCopy = false;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function stagedServer() {
  const root = await mkdtemp(join(tmpdir(), "serversentinel-move-"));
  roots.push(root);
  const source = join(root, "staging", "server");
  await mkdir(join(source, "world"), { recursive: true });
  await writeFile(join(source, "world", "level.dat"), "level");
  await mkdir(join(root, "servers"));
  return { root, source, destination: join(root, "servers", "imported") };
}

describe("moving a staged import across devices", () => {
  it("removes the half-copied server folder when the copy fails", async () => {
    const { moveStagedServer } = await import("./importExport.js");
    const { root, source, destination } = await stagedServer();
    fsControl.crossDevice = true;
    fsControl.failCopy = true;

    await expect(moveStagedServer(source, destination)).rejects.toThrow("no space left on device");

    expect(await readdir(join(root, "servers"))).toEqual([]);
    expect(await readdir(join(source, "world"))).toEqual(["level.dat"]);
  });

  it("copies the folder and removes the staging copy when the copy succeeds", async () => {
    const { moveStagedServer } = await import("./importExport.js");
    const { source, destination } = await stagedServer();
    fsControl.crossDevice = true;

    await moveStagedServer(source, destination);

    expect(await readdir(join(destination, "world"))).toEqual(["level.dat"]);
    await expect(readdir(source)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
