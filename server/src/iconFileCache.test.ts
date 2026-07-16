import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cachedIconFilenames, findCachedIconFile } from "./iconFileCache.js";

let temporaryDirectory = "";

afterEach(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = "";
});

describe("icon file cache lookup", () => {
  it("finds a supported icon by its exact cache key among unrelated entries", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "serversentinel-icon-cache-"));
    await Promise.all(Array.from({ length: 50 }, (_, index) => writeFile(join(temporaryDirectory, `unrelated-${index}.png`), "decoy")));
    await writeFile(join(temporaryDirectory, "target.webp"), "icon");

    await expect(findCachedIconFile(temporaryDirectory, "target")).resolves.toMatchObject({
      filename: "target.webp",
      path: join(temporaryDirectory, "target.webp")
    });
  });

  it("returns null when no supported icon exists", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "serversentinel-icon-cache-"));
    await writeFile(join(temporaryDirectory, "target.svg"), "unsupported");

    await expect(findCachedIconFile(temporaryDirectory, "target")).resolves.toBeNull();
  });

  it("ignores a matching directory and continues through supported extensions", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "serversentinel-icon-cache-"));
    await mkdir(join(temporaryDirectory, "target.webp"));
    await writeFile(join(temporaryDirectory, "target.png"), "icon");

    await expect(findCachedIconFile(temporaryDirectory, "target")).resolves.toMatchObject({ filename: "target.png" });
    expect(cachedIconFilenames("target")).toContain("target.png");
  });
});
