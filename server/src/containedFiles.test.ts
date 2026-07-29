import { constants as fsConstants } from "node:fs";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openContainedFile, openContainedReadStream, readContainedFile, statContainedFile } from "./core.js";

/**
 * A managed workload can write inside its own server root, so it can replace a validated path with a
 * symlink before the panel opens it. These helpers resolve the path once and refuse a final-component
 * symlink outright where the platform supports it.
 *
 * `O_NOFOLLOW` is POSIX-only and Windows additionally refuses unprivileged symlink creation, so the
 * refusal cases only run where both are available. CI runs on Linux, where they do.
 */
const symlinkChecksSupported = process.platform !== "win32" && typeof fsConstants.O_NOFOLLOW === "number";
const describeSymlinks = symlinkChecksSupported ? describe : describe.skip;

const roots: string[] = [];

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "serversentinel-contained-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function readStreamToString(stream: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

describe("contained file reads", () => {
  it("reads a regular file", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "server.properties"), "level-name=world\n", "utf8");

    expect((await readContainedFile(join(root, "server.properties"))).toString("utf8")).toBe("level-name=world\n");
  });

  it("reports the size of the inode it opened", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "log.txt"), "0123456789", "utf8");

    expect((await statContainedFile(join(root, "log.txt"))).size).toBe(10);
  });

  it("streams a regular file and closes its handle", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "world.dat"), "payload", "utf8");

    const { stream, size } = await openContainedReadStream(join(root, "world.dat"));
    expect(size).toBe(7);
    expect(await readStreamToString(stream)).toBe("payload");
  });

  it("enforces a byte ceiling against the opened file", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "big.txt"), "x".repeat(64), "utf8");

    await expect(readContainedFile(join(root, "big.txt"), 8)).rejects.toMatchObject({ code: "EFBIG" });
    expect((await readContainedFile(join(root, "big.txt"), 64)).byteLength).toBe(64);
  });

  // A read-only open of a directory succeeds, so the fstat behind the handle is what rejects it. A
  // non-regular file never reaches a caller that asked for file contents.
  it("refuses a directory where a file is expected", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "config"));

    await expect(statContainedFile(join(root, "config"))).rejects.toMatchObject({ code: "EINVAL" });
  });
});

describeSymlinks("contained file reads against a swapped path", () => {
  it("refuses to open a symlink pointing outside the server root", async () => {
    const root = await temporaryRoot();
    const outside = join(root, "outside-secret");
    await writeFile(outside, "host secret", "utf8");
    await mkdir(join(root, "server"));
    await symlink(outside, join(root, "server", "server.properties"));

    await expect(openContainedFile(join(root, "server", "server.properties")))
      .rejects.toMatchObject({ code: "ELOOP" });
  });

  it("refuses to read through a swapped symlink instead of returning its bytes", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "secret"), "host secret", "utf8");
    await symlink(join(root, "secret"), join(root, "swapped.txt"));

    await expect(readContainedFile(join(root, "swapped.txt"))).rejects.toMatchObject({ code: "ELOOP" });
  });

  it("refuses to stream through a swapped symlink", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "secret"), "host secret", "utf8");
    await symlink(join(root, "secret"), join(root, "download.bin"));

    await expect(openContainedReadStream(join(root, "download.bin"))).rejects.toMatchObject({ code: "ELOOP" });
  });

  it("still reads the real file when nothing was swapped", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "ops.json"), "[]", "utf8");

    expect((await readContainedFile(join(root, "ops.json"))).toString("utf8")).toBe("[]");
  });
});
