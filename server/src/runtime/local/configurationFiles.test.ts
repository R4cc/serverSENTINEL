import { link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readServerConfiguration, serverConfigurationMaxBytes, writeServerConfiguration } from "./configurationFiles.js";
import { updateServerProperties } from "./dockerContainers.js";
import type { ManagedServer } from "../../types.js";

let root: string;
let scope: { serverDir: string };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "serversentinel-config-security-"));
  scope = { serverDir: join(root, "server") };
  await mkdir(scope.serverDir);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("runtime configuration safety", () => {
  it("preserves settings and regular-file permissions when updating existing configuration", async () => {
    await writeFile(join(scope.serverDir, "server.properties"), "level-name=world\nserver-port=25565\n", { mode: 0o640 });
    const mode = (await stat(join(scope.serverDir, "server.properties"))).mode;
    await updateServerProperties(scope as ManagedServer, { "server-port": "25566" });
    expect(await readServerConfiguration(scope, "server.properties")).toContain("level-name=world");
    expect(await readServerConfiguration(scope, "server.properties")).toContain("server-port=25566");
    expect((await stat(join(scope.serverDir, "server.properties"))).mode).toBe(mode);
    expect(await readdir(scope.serverDir)).toEqual(["server.properties"]);
  });

  it("does not overwrite an external file through a hard link", async () => {
    const outside = join(root, "outside.properties");
    await writeFile(outside, "level-name=original\n");
    await link(outside, join(scope.serverDir, "server.properties"));
    await updateServerProperties(scope as ManagedServer, { "level-name": "changed" });
    expect(await readFile(outside, "utf8")).toBe("level-name=original\n");
    expect(await readServerConfiguration(scope, "server.properties")).toContain("level-name=changed");
  });

  it("rejects configuration reached through an escaping directory link", async () => {
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "secret"), "host secret");
    await symlink(outside, join(scope.serverDir, "escape"), process.platform === "win32" ? "junction" : "dir");
    await expect(readServerConfiguration(scope, "escape/secret")).rejects.toThrow("symlink");
    await expect(writeServerConfiguration(scope, "escape/secret", "overwritten")).rejects.toThrow("symlink");
    expect(await readFile(join(outside, "secret"), "utf8")).toBe("host secret");
  });

  it("bounds configuration reads and writes while allowing missing configuration to be created", async () => {
    await writeServerConfiguration(scope, "eula.txt", "eula=true\n");
    expect(await readServerConfiguration(scope, "eula.txt")).toBe("eula=true\n");
    await writeFile(join(scope.serverDir, "large"), Buffer.alloc(serverConfigurationMaxBytes + 1));
    await expect(readServerConfiguration(scope, "large")).rejects.toMatchObject({ code: "EFBIG" });
    await expect(writeServerConfiguration(scope, "large", "x".repeat(serverConfigurationMaxBytes + 1))).rejects.toThrow("limit");
  });

  it.skipIf(process.platform === "win32")("rejects a configuration symlink before updating a host file", async () => {
    const outside = join(root, "credentials");
    await writeFile(outside, "host secret");
    await symlink(outside, join(scope.serverDir, "server.properties"));
    await expect(updateServerProperties(scope as ManagedServer, { "server-port": "25566" })).rejects.toThrow("symlink");
    expect(await readFile(outside, "utf8")).toBe("host secret");
  });
});
